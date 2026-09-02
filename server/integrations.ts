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
import { db, nowMST, audit } from './db.js';

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
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'SES_FROM',
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
      unlocks: 'A Trilogy fax number — inbound faxes land in the Requests queue' },
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
    new MailComposer({ from: secret('SES_FROM'), to: m.to, subject: m.subject, text: m.text, html: m.html, attachments: m.attachments })
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

/* ---------- bill OCR (Textract AnalyzeExpense) ---------- */
export async function parseBillFile(bytes: Buffer): Promise<{ dos: string | null; total: number | null; lines: Array<{ cpt: string; units: number; charge: number }> } | null> {
  if (!ocrReady()) return null;
  const { TextractClient, AnalyzeExpenseCommand } = await import('@aws-sdk/client-textract');
  const tx = new TextractClient({
    region: secret('AWS_REGION') || 'us-west-2',
    credentials: { accessKeyId: secret('AWS_ACCESS_KEY_ID'), secretAccessKey: secret('AWS_SECRET_ACCESS_KEY') },
  });
  const out: any = await tx.send(new AnalyzeExpenseCommand({ Document: { Bytes: bytes } }));
  const doc = out.ExpenseDocuments?.[0];
  if (!doc) return null;
  const summary: Record<string, string> = {};
  for (const f of doc.SummaryFields || []) {
    const k = f.Type?.Text || f.LabelDetection?.Text || '';
    if (k) summary[k.toUpperCase()] = f.ValueDetection?.Text || '';
  }
  const dosRaw = summary['INVOICE_RECEIPT_DATE'] || summary['SERVICE_DATE'] || summary['DATE'] || '';
  const d = new Date(dosRaw);
  const dos = dosRaw && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;
  const total = parseFloat(String(summary['TOTAL'] || '').replace(/[^0-9.]/g, '')) || null;
  const lines: Array<{ cpt: string; units: number; charge: number }> = [];
  for (const group of doc.LineItemGroups || []) {
    for (const item of group.LineItems || []) {
      let cpt = '', charge = 0, units = 1, desc = '';
      for (const f of item.LineItemExpenseFields || []) {
        const t = f.Type?.Text || '';
        const v = f.ValueDetection?.Text || '';
        if (t === 'PRODUCT_CODE') cpt = v;
        if (t === 'ITEM') desc = v;
        if (t === 'PRICE' || t === 'AMOUNT') charge = parseFloat(v.replace(/[^0-9.]/g, '')) || charge;
        if (t === 'QUANTITY') units = parseFloat(v) || 1;
      }
      if (!cpt) cpt = (desc.match(/\b\d{5}\b/) || [''])[0];   // CPT codes are 5 digits, often in the description
      if (cpt || charge) lines.push({ cpt, units, charge });
    }
  }
  return { dos, total, lines };
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
