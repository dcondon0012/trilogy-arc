/** Integration layer — built dark, lights up with credentials.
 *
 *  Every external service (email, SMS, fax, e-sign, bill OCR, clearinghouse) is
 *  wrapped here behind one pattern:
 *    · credentials live in the `secrets` table (write-only via Admin → Integrations;
 *      env vars of the same name override) — Donny pastes keys, nothing redeploys
 *    · when a service is NOT configured, sends queue into `outbox` where admins can
 *      see them (and copy a reset link, say) instead of silently vanishing
 *    · when it IS configured, the same call really sends — no code changes
 *
 *  This is what "the APIs" activate into: the app already talks to this layer
 *  everywhere; each vendor account turns one more capability from queued → live.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, nowMST, audit, DATA_DIR } from './db.js';

/* ---------- secrets: env wins, then the admin-entered table ---------- */
export function secret(k: string): string {
  return process.env[k] || (db.prepare('SELECT v FROM secrets WHERE k=?').get(k) as any)?.v || '';
}
export function setSecret(k: string, v: string, by: string) {
  db.prepare('INSERT INTO secrets(k,v,updatedAt,updatedBy) VALUES(?,?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updatedAt=excluded.updatedAt, updatedBy=excluded.updatedBy')
    .run(k, v, nowMST(), by);
}
const mask = (v: string) => (v ? (v.length > 8 ? '••••' + v.slice(-4) : '••••') : '');

/* ---------- what each integration needs (drives the Admin panel) ---------- */
export const SECRET_KEYS = [
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'SES_FROM', 'SES_REPLY_TO',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM',
  'FAXAGE_USERNAME', 'FAXAGE_COMPANY', 'FAXAGE_PASSWORD',
  'ESIGN_VENDOR', 'ESIGN_API_KEY',
] as const;

const awsReady = () => !!(secret('AWS_ACCESS_KEY_ID') && secret('AWS_SECRET_ACCESS_KEY'));
export const emailReady = () => awsReady() && !!secret('SES_FROM');
export const smsReady = () => !!(secret('TWILIO_ACCOUNT_SID') && secret('TWILIO_AUTH_TOKEN') && secret('TWILIO_FROM'));
export const ocrReady = awsReady;

export function integrationStatus() {
  const q = (kind: string) => (db.prepare("SELECT COUNT(*) c FROM outbox WHERE kind=? AND status='queued'").get(kind) as any).c;
  return [
    { key: 'email', name: 'Email (AWS SES)', live: emailReady(), queued: q('email'),
      needs: 'AWS account → IAM access key + secret, region (us-west-2), and a verified From address. I set up domain verification and hand over the exact Porkbun DNS records once keys are in.',
      keys: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'SES_FROM'],
      unlocks: 'Auth documents emailed with the doc included · daily outbound & records chases actually send · password-reset and temp-code emails deliver · inbound email → Requests queue' },
    { key: 'sms', name: 'Texting (Twilio)', live: smsReady(), queued: q('sms'),
      needs: 'Twilio account + phone number + 10DLC registration (1–6 weeks — start early). Paste Account SID, Auth Token, and the From number.',
      keys: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'],
      unlocks: 'Post-appointment patient check-ins (no PHI in messages)' },
    { key: 'fax', name: 'Fax (Faxage)', live: !!(secret('FAXAGE_USERNAME') && secret('FAXAGE_PASSWORD')), queued: q('fax'),
      needs: 'Faxage account (Professional plan ~$8/mo, sign their BAA). Paste username, company id, and password.',
      keys: ['FAXAGE_USERNAME', 'FAXAGE_COMPANY', 'FAXAGE_PASSWORD'],
      unlocks: 'Inbound faxes to the Trilogy fax number are pulled into the Requests queue automatically (checked every 5 minutes)' },
    { key: 'esign', name: 'E-signature', live: !!secret('ESIGN_API_KEY'),
      needs: 'Vendor decision (pay-per-document with a BAA recommended) + API key. Also gated on counsel clearing the contract templates.',
      keys: ['ESIGN_VENDOR', 'ESIGN_API_KEY'],
      unlocks: 'Contracts go out for real signing; status flips itself when signed' },
    { key: 'ocr', name: 'Bill reading (AWS Textract)', live: ocrReady(),
      needs: 'Same AWS keys as email — nothing extra.',
      keys: [],
      unlocks: 'Upload a bill → CPT lines, charges, and DOS fill themselves in' },
    { key: 'clearinghouse', name: 'Clearinghouse', live: false,
      needs: 'Vendor signup (Claim.MD-class) + payer enrollment paperwork (2–6 weeks per payer — start early). Wiring follows once the account exists.',
      keys: [],
      unlocks: 'Bills to carriers electronically · carrier payments mark themselves · eventually pay providers from Arc' },
  ];
}

export function secretsMasked() {
  return SECRET_KEYS.map(k => {
    const row = db.prepare('SELECT v, updatedAt, updatedBy FROM secrets WHERE k=?').get(k) as any;
    const envSet = !!process.env[k];
    return { key: k, set: envSet || !!row?.v, masked: envSet ? '(set on server)' : mask(row?.v || ''), updatedAt: row?.updatedAt || null };
  });
}

/* ---------- email (SES raw send; MIME built by nodemailer's MailComposer) ---------- */
async function buildMime(m: Mail): Promise<Buffer> {
  // MailComposer handles headers, encoding, and attachments; SES just carries the bytes.
  const MailComposer = (await import('nodemailer/lib/mail-composer/index.js') as any).default;
  return new Promise((resolve, reject) => {
    // Replies to anything Arc sends land in a real inbox (Donny's, unless overridden).
    new MailComposer({ from: secret('SES_FROM'), replyTo: secret('SES_REPLY_TO') || 'donny@trilogyconnections.com', to: m.to, subject: m.subject, text: m.text, html: m.html, attachments: m.attachments })
      .compile().build((err: any, msg: Buffer) => (err ? reject(err) : resolve(msg)));
  });
}
async function sesSendRaw(mime: Buffer) {
  const { SESClient, SendRawEmailCommand } = await import('@aws-sdk/client-ses');
  const ses = new SESClient({
    region: secret('AWS_REGION') || 'us-west-2',
    credentials: { accessKeyId: secret('AWS_ACCESS_KEY_ID'), secretAccessKey: secret('AWS_SECRET_ACCESS_KEY') },
  });
  await ses.send(new SendRawEmailCommand({ RawMessage: { Data: mime } }));
}

export interface Mail {
  to: string; subject: string; text?: string; html?: string;
  attachments?: Array<{ filename: string; content: string | Buffer; contentType?: string }>;
  patientId?: string | null; meta?: any;
}

/** Queue-always, send-when-live. Returns { sent } so callers can adapt copy. */
export async function sendMail(m: Mail): Promise<{ sent: boolean; outboxId: number }> {
  const info = db.prepare(`INSERT INTO outbox(kind,toAddr,subject,body,patientId,meta,status,createdAt)
    VALUES('email',?,?,?,?,?,'queued',?)`)
    .run(m.to, m.subject, m.text || m.html || '', m.patientId || null, JSON.stringify(m.meta || {}), nowMST());
  const id = Number(info.lastInsertRowid);
  if (!emailReady() || !m.to) return { sent: false, outboxId: id };
  try {
    await sesSendRaw(await buildMime(m));
    db.prepare("UPDATE outbox SET status='sent', sentAt=? WHERE id=?").run(nowMST(), id);
    return { sent: true, outboxId: id };
  } catch (err: any) {
    db.prepare("UPDATE outbox SET status='failed', detail=? WHERE id=?").run(String(err?.message || err).slice(0, 300), id);
    audit(null, 'email.sendFailed', 'outbox', String(id), String(err?.message || err).slice(0, 120));
    return { sent: false, outboxId: id };
  }
}

/* ---------- SES identity management: domain verification, sandbox status, test sends ----------
   Lets an admin do the whole email go-live from the Integrations panel:
   set up domain DKIM (we hand back the exact DNS records for Porkbun), watch verification
   status, verify individual addresses while the account is still in the SES sandbox, and
   send a test email. */
async function sesv2Client() {
  const { SESv2Client } = await import('@aws-sdk/client-sesv2');
  return new SESv2Client({
    region: secret('AWS_REGION') || 'us-west-2',
    credentials: { accessKeyId: secret('AWS_ACCESS_KEY_ID'), secretAccessKey: secret('AWS_SECRET_ACCESS_KEY') },
  });
}
export const sesDomain = () => (secret('SES_FROM').split('@')[1] || 'trilogyconnections.com').toLowerCase();

/** Create (or fetch) the domain identity and return the DNS records to add at the registrar. */
export async function sesSetupDomain() {
  const domain = sesDomain();
  const c = await sesv2Client();
  const { CreateEmailIdentityCommand, GetEmailIdentityCommand } = await import('@aws-sdk/client-sesv2');
  let tokens: string[] = [];
  try {
    const r: any = await c.send(new CreateEmailIdentityCommand({ EmailIdentity: domain }));
    tokens = r.DkimAttributes?.Tokens || [];
  } catch (err: any) {
    if (!String(err?.name || '').includes('AlreadyExists')) throw err;
    const g: any = await c.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
    tokens = g.DkimAttributes?.Tokens || [];
  }
  const records = tokens.map(t => ({
    type: 'CNAME', host: `${t}._domainkey.${domain}`, value: `${t}.dkim.amazonses.com`,
    note: 'DKIM — proves Trilogy sent it',
  }));
  records.push({
    type: 'TXT', host: `_dmarc.${domain}`, value: 'v=DMARC1; p=none;',
    note: 'DMARC — recommended; add only if one does not already exist',
  } as any);
  return { domain, records };
}

/** Verification + sandbox status for the panel. */
export async function sesStatus() {
  const domain = sesDomain();
  const c = await sesv2Client();
  const { GetEmailIdentityCommand, GetAccountCommand } = await import('@aws-sdk/client-sesv2');
  let identity: any = null;
  try { identity = await c.send(new GetEmailIdentityCommand({ EmailIdentity: domain })); } catch { /* not created yet */ }
  const acct: any = await c.send(new GetAccountCommand({}));
  return {
    domain,
    domainCreated: !!identity,
    dkimStatus: identity?.DkimAttributes?.Status || 'NOT_STARTED',      // PENDING → SUCCESS once DNS records land
    verified: !!identity?.VerifiedForSendingStatus,
    production: !!acct.ProductionAccessEnabled,                          // false = sandbox: only verified addresses receive
    sendQuota: acct.SendQuota?.Max24HourSend ?? null,
  };
}

/** Sandbox helper: sends an AWS verification email to one address so tests can deliver to it. */
export async function sesVerifyAddress(email: string) {
  const c = await sesv2Client();
  const { CreateEmailIdentityCommand } = await import('@aws-sdk/client-sesv2');
  try { await c.send(new CreateEmailIdentityCommand({ EmailIdentity: email })); }
  catch (err: any) { if (!String(err?.name || '').includes('AlreadyExists')) throw err; }
  return { ok: true };
}

/* ---------- SMS (Twilio REST — no SDK needed) ---------- */
export async function sendSms(to: string, body: string, patientId?: string | null): Promise<{ sent: boolean }> {
  const info = db.prepare(`INSERT INTO outbox(kind,toAddr,subject,body,patientId,status,createdAt)
    VALUES('sms',?,?,?,?,'queued',?)`).run(to, null, body, patientId || null, nowMST());
  const id = Number(info.lastInsertRowid);
  if (!smsReady()) return { sent: false };
  try {
    const sid = secret('TWILIO_ACCOUNT_SID');
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(sid + ':' + secret('TWILIO_AUTH_TOKEN')).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: secret('TWILIO_FROM'), Body: body }).toString(),
    });
    if (!res.ok) throw new Error(`Twilio ${res.status}`);
    db.prepare("UPDATE outbox SET status='sent', sentAt=? WHERE id=?").run(nowMST(), id);
    return { sent: true };
  } catch (err: any) {
    db.prepare("UPDATE outbox SET status='failed', detail=? WHERE id=?").run(String(err?.message || err).slice(0, 300), id);
    return { sent: false };
  }
}

/* ---------- bill OCR (Textract) ----------
   Handles the three shapes bills actually arrive in:
   · a normal invoice → AnalyzeExpense reads date/total/lines directly
   · an HCFA-1500 / CMS-1500 claim form → it's a TABLE, not an invoice; AnalyzeExpense finds
     nothing useful, so we fall back to AnalyzeDocument(TABLES) and pull CPT + charge + DOS
     out of the service-line grid (box 24), where charges are written "175 00" style
   · a general invoice with no CPT codes at all → returned as kind:'invoice' with a
     description, so the bill modal switches to General-invoice mode instead of
     presenting blank CPT lines.
   Textract only accepts PNG/JPEG/PDF/TIFF — anything else (webp, gif, bmp, heic) is
   converted to PNG first. */
const CPT_RE = /^(\d{5}|[A-Z]\d{4})$/;                       // CPT or HCPCS code
const cptFrom = (s: string) => {
  for (const tok of String(s || '').toUpperCase().split(/[\s,;:]+/)) if (CPT_RE.test(tok)) return tok;
  return '';
};
// Money on claim forms is often "175 00" (space for the decimal point).
const moneyFrom = (s: string): number | null => {
  const m = String(s || '').replace(/[$,]/g, '').match(/(\d+)(?:[.\s](\d{2}))?\s*$/);
  if (!m) return null;
  const v = parseFloat(m[1] + '.' + (m[2] || '00'));
  return Number.isFinite(v) && v > 0 ? v : null;
};
const dateFrom = (s: string): string | null => {
  const m = String(s || '').match(/\b(\d{1,2})[\/\- ](\d{1,2})[\/\- ](\d{2,4})\b/);
  if (!m) return null;
  let [, mo, dd, yy] = m;
  if (yy.length === 2) yy = (Number(yy) > 50 ? '19' : '20') + yy;
  const d = new Date(Number(yy), Number(mo) - 1, Number(dd));
  return isNaN(d.getTime()) ? null : `${yy}-${mo.padStart(2, '0')}-${dd.padStart(2, '0')}`;
};

async function toTextractBytes(bytes: Buffer, mime?: string): Promise<Buffer> {
  // sniff, don't trust the extension: PDF, PNG, JPEG, TIFF pass straight through
  const head = bytes.subarray(0, 4);
  if (head.toString('latin1').startsWith('%PDF')) return bytes;
  if (head[0] === 0x89 && head[1] === 0x50) return bytes;                        // PNG
  if (head[0] === 0xff && head[1] === 0xd8) return bytes;                        // JPEG
  if ((head[0] === 0x49 && head[1] === 0x49) || (head[0] === 0x4d && head[1] === 0x4d)) return bytes; // TIFF
  const sharp = (await import('sharp')).default;                                 // webp/gif/bmp/heic → PNG
  return await sharp(bytes).flatten({ background: '#ffffff' }).png().toBuffer();
}

async function txClient() {
  const { TextractClient } = await import('@aws-sdk/client-textract');
  return new TextractClient({
    region: secret('AWS_REGION') || 'us-west-2',
    credentials: { accessKeyId: secret('AWS_ACCESS_KEY_ID'), secretAccessKey: secret('AWS_SECRET_ACCESS_KEY') },
  });
}

export interface ParsedBill {
  kind: 'itemized' | 'invoice';
  dos: string | null; total: number | null;
  lines: Array<{ cpt: string; units: number; charge: number; desc?: string }>;
  descr: string | null;
}

/* Claim-form fallback: read the tables and mine service-line rows for CPT + charge (+ DOS). */
async function parseClaimFormTables(tx: any, bytes: Buffer): Promise<{ lines: ParsedBill['lines']; dos: string | null }> {
  const { AnalyzeDocumentCommand } = await import('@aws-sdk/client-textract');
  const out: any = await tx.send(new AnalyzeDocumentCommand({ Document: { Bytes: bytes }, FeatureTypes: ['TABLES'] }));
  const blocks: any[] = out.Blocks || [];
  const byId = new Map(blocks.map(b => [b.Id, b]));
  const textOf = (b: any): string => (b.Relationships || [])
    .filter((r: any) => r.Type === 'CHILD')
    .flatMap((r: any) => r.Ids.map((id: string) => byId.get(id)))
    .filter((c: any) => c && (c.BlockType === 'WORD' || c.BlockType === 'SELECTION_ELEMENT'))
    .map((c: any) => c.Text || '').join(' ').trim();

  const lines: ParsedBill['lines'] = [];
  let dos: string | null = null;
  for (const table of blocks.filter(b => b.BlockType === 'TABLE')) {
    const rows = new Map<number, string[]>();
    for (const rel of table.Relationships || []) {
      if (rel.Type !== 'CHILD') continue;
      for (const id of rel.Ids) {
        const cell = byId.get(id);
        if (cell?.BlockType !== 'CELL') continue;
        const row = rows.get(cell.RowIndex) || [];
        row[cell.ColumnIndex] = textOf(cell);
        rows.set(cell.RowIndex, row);
      }
    }
    for (const cells of rows.values()) {
      const texts = cells.filter(Boolean);
      const cpt = texts.map(cptFrom).find(Boolean);
      if (!cpt) continue;
      // charge = biggest strict money value ("175 00" / "175.00") in a non-date cell —
      // strictness keeps years, NPIs, and the CPT itself from being mistaken for dollars
      const strictMoney = (s: string): number | null => {
        const m = String(s || '').replace(/[$,]/g, '').match(/(\d+)[.\s](\d{2})\s*$/);
        if (!m) return null;
        const v = parseFloat(m[1] + '.' + m[2]);
        return Number.isFinite(v) && v > 0 ? v : null;
      };
      const monies = texts.filter(t => !dateFrom(t) && !cptFrom(t))
        .map(strictMoney).filter((v): v is number => v != null);
      const charge = monies.length ? Math.max(...monies) : 0;
      const units = (() => {
        const u = texts.map(t => t.trim()).find(t => /^\d{1,2}$/.test(t) && Number(t) >= 1 && Number(t) <= 99);
        return u ? Number(u) : 1;
      })();
      const rowDate = texts.map(dateFrom).find(Boolean) || null;
      if (!dos && rowDate) dos = rowDate;
      if (charge > 0) lines.push({ cpt, units, charge });
    }
  }
  return { lines, dos };
}

export async function parseBillFile(rawBytes: Buffer, mime?: string): Promise<ParsedBill | null> {
  if (!ocrReady()) return null;
  const bytes = await toTextractBytes(rawBytes, mime);
  const tx = await txClient();
  const { AnalyzeExpenseCommand } = await import('@aws-sdk/client-textract');
  const out: any = await tx.send(new AnalyzeExpenseCommand({ Document: { Bytes: bytes } }));
  const doc = out.ExpenseDocuments?.[0];

  const summary: Record<string, string> = {};
  for (const f of doc?.SummaryFields || []) {
    const k = f.Type?.Text || f.LabelDetection?.Text || '';
    if (k) summary[k.toUpperCase()] = f.ValueDetection?.Text || '';
  }
  const dosRaw = summary['INVOICE_RECEIPT_DATE'] || summary['SERVICE_DATE'] || summary['DATE'] || '';
  let dos = dateFrom(dosRaw) || (dosRaw && !isNaN(new Date(dosRaw).getTime()) ? new Date(dosRaw).toISOString().slice(0, 10) : null);
  let total = moneyFrom(summary['TOTAL'] || '') || null;

  const expLines: ParsedBill['lines'] = [];
  for (const group of doc?.LineItemGroups || []) {
    for (const item of group.LineItems || []) {
      let cpt = '', charge = 0, units = 1, desc = '';
      for (const f of item.LineItemExpenseFields || []) {
        const t = f.Type?.Text || '';
        const v = f.ValueDetection?.Text || '';
        if (t === 'PRODUCT_CODE') cpt = cptFrom(v) || cpt;
        if (t === 'ITEM') desc = v;
        if (t === 'PRICE' || t === 'AMOUNT') charge = moneyFrom(v) ?? charge;
        if (t === 'QUANTITY') units = parseFloat(v) || 1;
      }
      if (!cpt) cpt = cptFrom(desc);
      if (cpt || charge) expLines.push({ cpt, units, charge, desc: desc || undefined });
    }
  }

  let cptLines = expLines.filter(l => l.cpt && l.charge > 0);
  // No CPT codes from the invoice reader? Could be a claim form (HCFA/CMS-1500) — read its tables.
  if (!cptLines.length) {
    try {
      const t = await parseClaimFormTables(tx, bytes);
      if (t.lines.length) { cptLines = t.lines; if (!dos && t.dos) dos = t.dos; }
    } catch { /* table pass is best-effort */ }
  }

  if (cptLines.length) {
    // Our validation requires lines to equal the billed total exactly — derive total from lines.
    const sum = Math.round(cptLines.reduce((s, l) => s + l.charge * (l.units || 1), 0) * 100) / 100;
    return { kind: 'itemized', dos, total: sum, lines: cptLines, descr: null };
  }
  // A real bill but with no CPT codes anywhere → general invoice.
  const descr = expLines.map(l => l.desc).filter(Boolean).join(' · ').slice(0, 200)
    || summary['VENDOR_NAME'] || null;
  if (!total && expLines.length) total = Math.round(expLines.reduce((s, l) => s + l.charge * (l.units || 1), 0) * 100) / 100 || null;
  if (!dos && !total && !descr) return null;
  return { kind: 'invoice', dos, total, lines: [], descr };
}

/* ---------- inbound fax (Faxage) — polls when credentials exist, lands in Requests ---------- */
export const faxReady = () => !!(secret('FAXAGE_USERNAME') && secret('FAXAGE_PASSWORD'));
const faxCreds = () => new URLSearchParams({
  username: secret('FAXAGE_USERNAME'), company: secret('FAXAGE_COMPANY'), password: secret('FAXAGE_PASSWORD'),
});

async function faxage(params: Record<string, string>): Promise<Response> {
  const body = faxCreds();
  for (const [k, v] of Object.entries(params)) body.set(k, v);
  const r = await fetch('https://api.faxage.com/httpsfax.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!r.ok) throw new Error(`Faxage ${r.status}`);
  return r;
}

/** Pull any new received faxes into the Requests (intake) queue. Never throws. */
export async function pollInboundFaxes(): Promise<{ imported: number } | null> {
  if (!faxReady()) return null;
  try {
    const list = await (await faxage({ operation: 'listfax' })).text();
    if (/^ERR/m.test(list)) { audit(null, 'fax.pollError', undefined, undefined, list.slice(0, 120)); return null; }
    let imported = 0;
    for (const line of list.split('\n').map(l => l.trim()).filter(Boolean)) {
      const f = line.split('\t');                    // recvid, recvdate, [starttime,] CID, DNIS, ...
      const recvid = f[0];
      if (!/^\d+$/.test(recvid) || db.prepare('SELECT 1 FROM fax_seen WHERE recvid=?').get(recvid)) continue;
      const from = f.length >= 4 ? f[f.length >= 5 ? 3 : 2] : 'unknown';
      const bytes = Buffer.from(await (await faxage({ operation: 'getfax', faxid: recvid })).arrayBuffer());
      if (!bytes.length || /^ERR/.test(bytes.subarray(0, 8).toString())) continue;
      const fid = crypto.randomUUID();
      const name = `fax-${recvid}.pdf`;
      fs.writeFileSync(path.join(DATA_DIR, 'uploads', fid), bytes);
      db.prepare('INSERT INTO files(id,name,mime,size,uploadedBy,time) VALUES(?,?,?,?,?,?)')
        .run(fid, name, 'application/pdf', bytes.length, 'inbound-fax', nowMST());
      db.prepare(`INSERT INTO intake_items(channel,kind,status,fileId,fileName,fromInfo,note,receivedAt)
        VALUES('fax','bill','triage',?,?,?,?,?)`)
        .run(fid, name, `Fax from ${from}`, `Received ${f[1] || ''}`.trim(), nowMST());
      db.prepare('INSERT INTO fax_seen(recvid,at) VALUES(?,?)').run(recvid, nowMST());
      audit(null, 'inbound.fax', undefined, undefined, `${name} from ${from}`);
      imported++;
    }
    return { imported };
  } catch (err: any) {
    audit(null, 'fax.pollError', undefined, undefined, String(err?.message || err).slice(0, 120));
    return null;
  }
}
export function scheduleFaxPolling() {
  if (process.env.NODE_ENV !== 'production' || process.env.TRILOGY_NO_FAXPOLL === '1') return;
  setInterval(() => { pollInboundFaxes(); }, 5 * 60 * 1000);
  setTimeout(() => { pollInboundFaxes(); }, 60 * 1000);
}

/* ---------- post-appointment SMS check-ins (runs dark until Twilio is live) ---------- */
export function queueAppointmentCheckins() {
  const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT a.id aid, a.patientId, p.name, p.phone FROM appointments a
    JOIN patients p ON p.id=a.patientId
    WHERE substr(a.whenAt,1,10)=? AND p.phone IS NOT NULL AND p.stage<4`).all(yday) as any[];
  for (const r of rows) {
    const already = db.prepare("SELECT 1 FROM outbox WHERE kind='sms' AND patientId=? AND body LIKE '%checking in%' AND substr(createdAt,1,10)=substr(?,1,10)").get(r.patientId, nowMST());
    if (already) continue;
    // No PHI in the message body — a courtesy check-in only.
    const first = String(r.name).split(' ')[0];
    sendSms(r.phone, `Hi ${first}, this is Trilogy checking in after your recent appointment. If you need anything or want help scheduling your next visit, just call or text us back.`, r.patientId)
      .catch(() => { /* recorded in outbox */ });
  }
}
export function scheduleCheckins() {
  if (process.env.NODE_ENV !== 'production' || process.env.TRILOGY_NO_CHECKINS === '1') return;
  setInterval(queueAppointmentCheckins, 6 * 60 * 60 * 1000);
  setTimeout(queueAppointmentCheckins, 90 * 1000);
}
