/** File storage — local disk today, S3 when the platform moves to AWS.
 *
 *  How it works:
 *    · Multer keeps staging uploads to UPLOAD_DIR exactly as before (fast, simple,
 *      and fine on Fargate too — container disk is scratch space).
 *    · The persistUploads middleware runs right after multer: in S3 mode it pushes
 *      each staged file to the bucket and removes the local copy; in local mode it
 *      does nothing. Uploaded file ids are unchanged either way.
 *    · Reads (the two download endpoints, OCR, email attachments) go through
 *      openStored()/readStored(): local file first — which is the whole story in
 *      local mode — then the bucket.
 *  Mode is decided by S3_UPLOADS_BUCKET (env var, or the Admin → Integrations
 *  secrets table). Nothing else changes between modes, so the Lightsail box is
 *  untouched until cutover flips the env var on the new containers.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { db, UPLOAD_DIR } from './db.js';

function bucket(): string {
  if (process.env.S3_UPLOADS_BUCKET) return process.env.S3_UPLOADS_BUCKET;
  try { return (db.prepare('SELECT v FROM secrets WHERE k=?').get('S3_UPLOADS_BUCKET') as any)?.v || ''; }
  catch { return ''; }
}
export const storageMode = (): 'local' | 's3' => (bucket() ? 's3' : 'local');

let s3: any = null;
let s3Bucket = '';
async function client() {
  const b = bucket();
  if (s3 && s3Bucket === b) return s3;
  const { S3Client } = await import('@aws-sdk/client-s3');
  // Credentials come from the task role on AWS (default provider chain) — no keys in code.
  s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' });
  s3Bucket = b;
  return s3;
}
const key = (id: string) => `uploads/${id}`;

/** Write a file by id (webhook + fax intake use this directly). */
export async function putFile(id: string, data: Buffer): Promise<void> {
  if (storageMode() === 'local') { fs.writeFileSync(path.join(UPLOAD_DIR, id), data); return; }
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  await (await client()).send(new PutObjectCommand({ Bucket: bucket(), Key: key(id), Body: data }));
}

/** Open a stored file as a stream, or null if it exists nowhere. Local always wins. */
export async function openStored(id: string): Promise<Readable | null> {
  const p = path.join(UPLOAD_DIR, id);
  if (fs.existsSync(p)) return fs.createReadStream(p);
  if (storageMode() === 'local') return null;
  try {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const r: any = await (await client()).send(new GetObjectCommand({ Bucket: bucket(), Key: key(id) }));
    return r.Body as Readable;
  } catch { return null; }
}

/** Whole file as a Buffer (OCR, email attachments). */
export async function readStored(id: string): Promise<Buffer | null> {
  const s = await openStored(id);
  if (!s) return null;
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

/** After-multer middleware: in S3 mode, move each staged upload into the bucket.
    In local mode it's a no-op — staged files ARE the storage. */
export async function persistUploads(req: any, res: any, next: any) {
  try {
    const files: any[] = [
      ...(req.file ? [req.file] : []),
      ...(Array.isArray(req.files) ? req.files : []),
      ...(req.files && !Array.isArray(req.files) ? Object.values(req.files as Record<string, any[]>).flat() : []),
    ];
    if (storageMode() === 's3') {
      for (const f of files) {
        await putFile(f.filename, fs.readFileSync(f.path));
        try { fs.unlinkSync(f.path); } catch { /* scratch cleanup only */ }
      }
    }
    next();
  } catch (err) { next(err); }
}
