import bcrypt from 'bcryptjs';
import { db } from './db.js';

/** Founding-team accounts. Created if missing on every boot (existing accounts untouched). */
export function ensureCoreUsers() {
  const core: Array<[string, string, string, string, string]> = [
    ['u1', 'Donny C.', 'donny@trilogymed.com', 'admin123', 'admin'],
    ['u2', 'Nicole M.', 'nicole@trilogymed.com', 'coord123', 'coordinator'],
    ['u3', 'Miles', 'miles@trilogymed.com', 'miles123', 'admin'],
    ['u4', 'Naul Manthe', 'naul@trilogymed.com', 'naul123', 'admin'],
    ['u5', 'Perry Rickel', 'perry@trilogymed.com', 'perry123', 'admin'],
  ];
  for (const [id, name, email, pw, role] of core) {
    const exists = db.prepare('SELECT 1 FROM users WHERE lower(email)=lower(?)').get(email);
    // Everyone except the original two must set their own password at first login.
    const mustChange = id === 'u1' || id === 'u2' ? 0 : 1;
    if (!exists) db.prepare('INSERT INTO users(id,name,email,pwHash,role,active,mustChangePw) VALUES(?,?,?,?,?,1,?)')
      .run(id, name, email, bcrypt.hashSync(pw, 10), role, mustChange);
  }
}

/** One-time (per database): with the site gate retired, a seed account still on its
 *  default password is a real exposure — force those to set a new one at next login. */
export function flagSeedPasswords() {
  if (db.prepare("SELECT 1 FROM counters WHERE k='mig_weakpw'").get()) return;
  const weak: Record<string, string> = {
    'donny@trilogymed.com': 'admin123', 'nicole@trilogymed.com': 'coord123',
    'miles@trilogymed.com': 'miles123', 'naul@trilogymed.com': 'naul123', 'perry@trilogymed.com': 'perry123',
  };
  for (const [email, pw] of Object.entries(weak)) {
    const u = db.prepare('SELECT id, pwHash FROM users WHERE lower(email)=lower(?)').get(email) as any;
    if (u && bcrypt.compareSync(pw, u.pwHash)) db.prepare('UPDATE users SET mustChangePw=1 WHERE id=?').run(u.id);
  }
  db.prepare("INSERT INTO counters(k,v) VALUES('mig_weakpw',1)").run();
}

export function seedIfEmpty(withDemo = true) {
  const hasUsers = (db.prepare('SELECT COUNT(*) c FROM users').get() as any).c > 0;
  if (hasUsers) return false;

  const hash = (pw: string) => bcrypt.hashSync(pw, 10);
  const insUser = db.prepare('INSERT INTO users(id,name,email,pwHash,role) VALUES(?,?,?,?,?)');
  insUser.run('u1', 'Donny C.', 'donny@trilogymed.com', hash('admin123'), 'admin');
  insUser.run('u2', 'Nicole M.', 'nicole@trilogymed.com', hash('coord123'), 'coordinator');
  db.prepare('INSERT OR REPLACE INTO counters(k,v) VALUES(?,?),(?,?),(?,?)')
    .run('pt', 10047, 'md', 2030, 'ins', 3005);

  if (!withDemo) return true;

  db.prepare(`INSERT INTO insurers(id,name,hq,phone,email,relationship,payRate,states,rules,avgDays,disputes,denialRate)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'INS-3005', 'Pacific Mutual Insurance', '900 SW Fifth Ave, Portland, OR 97204',
    '(800) 555-4400', 'claims@pacificmutual.com', 'Regional claims VP — Sandra Liu',
    'Fee schedule — 100% of contract rate, net 30',
    JSON.stringify(['OR', 'WA', 'ID', 'UT', 'AZ']),
    JSON.stringify([
      'Submit bills through Echo clearinghouse only',
      'One claim number per patient — always reference it',
      'Adjusters rotate; check assignment before calling',
      'Pre-authorization required for imaging over $1,500',
      'Escalations go to Sandra Liu, not adjuster supervisors',
    ]), 18, 2, 3);

  const insAdj = db.prepare('INSERT INTO adjusters(id,insurerId,name,phone,email,contract,notes) VALUES(?,?,?,?,?,?,?)');
  insAdj.run('a1', 'INS-3005', 'Tanya Ruiz', '(800) 555-4411', 't.ruiz@pacificmutual.com', 'Adjuster agreement — T. Ruiz.pdf', 'Responsive; prefers email');
  insAdj.run('a2', 'INS-3005', "Kevin O'Dell", '(800) 555-4418', 'k.odell@pacificmutual.com', null, 'Call mornings only');
  insAdj.run('a3', 'INS-3005', 'Priya Nair', '(800) 555-4423', 'p.nair@pacificmutual.com', null, 'Handles settled files');

  const insIC = db.prepare('INSERT INTO ins_contracts(insurerId,name,meta,status) VALUES(?,?,?,?)');
  insIC.run('INS-3005', 'Trilopay master services agreement — 2026.pdf', 'Signed May 2026 · renews annually', 'Active');
  insIC.run('INS-3005', 'PIP referral addendum.pdf', 'Signed June 2026', 'Active');
  insIC.run('INS-3005', 'Rate schedule 2027 renewal.pdf', 'Draft — in negotiation', 'Draft');

  const insProv = db.prepare('INSERT INTO providers(id,name,type,status,corpAddress,corpPhone,corpEmail,taxId,rules) VALUES(?,?,?,?,?,?,?,?,?)');
  const insBrStmt = db.prepare('INSERT INTO branches(providerId,name,address,phone,email,contacts,rate,status,contract,disputes,ratePct,rateCap) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  const RATES: Record<string, [number, number | null]> = {
    'SE Portland — 4th & Division': [60, 280], 'Beaverton': [60, 280], 'Gresham': [55, null],
    'Lloyd District': [65, null], 'NE Sandy': [58, null], 'Happy Valley': [62, null],
  };
  const insBr = { run: (...args: any[]) => {
    const [pct, cap] = RATES[args[1] as string] || [null, null];
    return insBrStmt.run(...args, pct, cap);
  } };

  insProv.run('MD-2007', 'Summit Spine & Rehab', 'Chiropractic', JSON.stringify(['Preferred', 'Under contract']),
    '7200 SW Macadam Ave, Ste 300, Portland, OR 97219', '(503) 555-0100', 'billing@summitspine.com', '93-4127412',
    JSON.stringify([
      'Bills submitted in batches of 3 visits via email (HCFA-1500)',
      'Payment within 30 days of batch acceptance',
      'Auth requests answered by corporate, not branches',
      'Do NOT contact treating DCs directly — go through office mgr',
      'Prefers e-signature contracts',
    ]));
  insBr.run('MD-2007', 'SE Portland — 4th & Division', '3480 SE Division St, Portland, OR 97202', '(503) 555-0122', 'division@summitspine.com', 'Dr. A. Chen (treating) · Kayla R. (office mgr)', '60% of billed / $280 per visit cap', 'Preferred', 'Signed lien agreement.pdf', 1);
  insBr.run('MD-2007', 'Beaverton', '12655 SW Canyon Rd, Beaverton, OR 97005', '(503) 555-0131', 'beaverton@summitspine.com', 'Dr. M. Okafor · Denise T. (office mgr)', '60% of billed / $280 per visit cap', 'Preferred', 'Signed lien agreement.pdf', 0);
  insBr.run('MD-2007', 'Gresham', '2001 NE Burnside Rd, Gresham, OR 97030', '(503) 555-0140', 'gresham@summitspine.com', 'Dr. L. Park', '55% of billed (renegotiation pending)', 'Single case agreement', 'Single case agreement — D. Boone.pdf', 1);

  insProv.run('MD-2015', 'NW Imaging Center', 'Imaging / MRI', JSON.stringify(['Single case agreement']),
    '825 NE Multnomah St, Portland, OR 97232', '(503) 555-0177', 'records@nwimaging.com', '93-8841002',
    JSON.stringify(['Pre-pay required for MRI', 'Results delivered within 48 hrs', 'Scheduling via portal only']));
  insBr.run('MD-2015', 'Lloyd District', '825 NE Multnomah St, Portland, OR 97232', '(503) 555-0177', 'records@nwimaging.com', 'Front desk', '65% of billed', 'Single case agreement', null, 0);

  insProv.run('MD-2021', 'Rose City PT', 'PT / Rehab', JSON.stringify(['Preferred', 'Under contract']),
    '5010 NE Sandy Blvd, Portland, OR 97213', '(503) 555-0190', 'admin@rosecitypt.com', '93-2216654',
    JSON.stringify(['Weekly billing', 'Auths answered within 24 hrs']));
  insBr.run('MD-2021', 'NE Sandy', '5010 NE Sandy Blvd, Portland, OR 97213', '(503) 555-0190', 'admin@rosecitypt.com', 'Gina S. (office mgr)', '58% of billed', 'Preferred', 'Signed lien agreement.pdf', 0);

  insProv.run('MD-2030', 'Cascade Orthopedics', 'Orthopedic', JSON.stringify(['Under contract']),
    '9300 SE 91st Ave, Happy Valley, OR 97086', '(503) 555-0201', 'office@cascadeortho.com', '93-7710236',
    JSON.stringify(['Consult required before surgery auth']));
  insBr.run('MD-2030', 'Happy Valley', '9300 SE 91st Ave, Happy Valley, OR 97086', '(503) 555-0201', 'office@cascadeortho.com', 'Dr. R. Imani', '62% of billed', 'Under contract', 'Signed lien agreement.pdf', 0);

  // Contracted demo providers carry signed BAA + rate agreements (the Under-contract gate);
  // MD-2015 stays single-case on purpose — the one-time-agreement flows exercise it.
  for (const pid of ['MD-2007', 'MD-2021', 'MD-2030'])
    db.prepare('UPDATE providers SET baaSignedAt=?, rateAgreementSignedAt=? WHERE id=?')
      .run('Signed (demo) · 06/2026', 'Signed (demo) · 06/2026', pid);

  const insPt = db.prepare(`INSERT INTO patients(id,name,caseType,phone,email,address,dob,doi,state,insurerId,claimNumber,policyNumber,adjusterId,coordinator,companionId,stage,accident,uwStatus,uwCoverage,uwLimit,uwRiskFlags,uwApprovedBy)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  insPt.run('PT-10042', 'Sarah Mitchell', 'trilopay', '(503) 555-0187', 'sarah.mitchell88@gmail.com',
    '2214 SE Hawthorne Blvd, Portland, OR 97214', '1988-03-22', '2026-06-02', 'Oregon',
    'INS-3005', 'PM-88231', 'POL-4471820', 'a1', 'u1', 'PT-10043', 2,
    'Rear-ended at a stoplight on I-84 off-ramp. Neck and lower back pain, onset within 24 hrs. Passenger (James Whitfield, companion claim) also injured. Vehicle drivable; police report filed.',
    'Approved', 'PIP — $15,000 limit', 15000, 'Prior back injury 2021', 'P. Rickel · 06/29/2026');

  insPt.run('PT-10043', 'James Whitfield', 'trilopay', '(503) 555-0244', 'jwhitfield@gmail.com',
    '2214 SE Hawthorne Blvd, Portland, OR 97214', '1990-08-14', '2026-06-02', 'Oregon',
    'INS-3005', 'PM-88232', 'POL-4471820', 'a1', 'u2', 'PT-10042', 2,
    'Passenger in PT-10042 accident. Neck strain.',
    'Approved', 'PIP — $15,000 limit', 15000, 'None', 'P. Rickel · 06/29/2026');

  insPt.run('PT-10047', 'Maria Alvarez', 'trilogy', '(503) 555-0311', 'malvarez@yahoo.com',
    '8814 N Lombard St, Portland, OR 97203', '1979-11-02', '2026-07-06', 'Oregon',
    'INS-3005', 'PM-89002', 'POL-9902231', 'a2', 'u1', null, 1,
    'T-boned at intersection, other driver ran red light. Shoulder and hip pain. Third-party liability claim.',
    'In review', 'BI — 3rd party', 25000, 'None', null);

  const insOB = db.prepare('INSERT INTO outside_bills(patientId,descr,amt) VALUES(?,?,?)');
  insOB.run('PT-10042', 'Providence ER', 2410);
  insOB.run('PT-10042', 'AMR ambulance', 830);
  insOB.run('PT-10047', 'Urgent care', 410);

  const insLink = db.prepare('INSERT INTO prov_links(patientId,providerId,branch,authAmount,authCount,billed,status) VALUES(?,?,?,?,?,?,?)');
  insLink.run('PT-10042', 'MD-2007', 'SE Portland — 4th & Division', 2240, 2, 2305, 'authorized');
  insLink.run('PT-10042', 'MD-2015', 'Lloyd District', 1900, 1, 0, 'pending');
  insLink.run('PT-10043', 'MD-2007', 'SE Portland — 4th & Division', 1400, 1, 980, 'authorized');

  const insBill = db.prepare('INSERT INTO bills(id,patientId,providerId,dos,billed,rate,hasBill,hasNote,status,paidDate) VALUES(?,?,?,?,?,?,?,?,?,?)');
  insBill.run('b1', 'PT-10042', 'MD-2007', '2026-06-18', 580, 348, 1, 1, 'paid', '06/20/2026');
  insBill.run('b2', 'PT-10042', 'MD-2007', '2026-06-25', 585, 351, 1, 1, 'paid', '07/03/2026');
  insBill.run('b3', 'PT-10042', 'MD-2007', '2026-07-10', 560, 336, 1, 1, 'unpaid', null);
  insBill.run('b4', 'PT-10042', 'MD-2007', '2026-07-13', 580, 348, 1, 0, 'unpaid', null);

  const insRec = db.prepare('INSERT INTO receipts(patientId,date,ref,amount,status) VALUES(?,?,?,?,?)');
  insRec.run('PT-10042', '2026-06-24', 'Claim PM-88231 · batch 1', 1500, 'Cleared');
  insRec.run('PT-10042', '2026-07-09', 'Claim PM-88231 · batch 2', 1150, 'Pending');

  const insSD = db.prepare('INSERT INTO sent_docs(patientId,name,toStr,time,status,method) VALUES(?,?,?,?,?,?)');
  insSD.run('PT-10042', 'Lien Agreement', 'Summit Spine (corporate)', '06/10/2026, 2:11 PM MST', 'Signed', 'Email');
  insSD.run('PT-10042', 'Medical Bill Pay Agreement', 'Sarah Mitchell', '06/11/2026, 9:30 AM MST', 'Signed', 'Email');
  insSD.run('PT-10042', 'One-Time Lien', 'NW Imaging', '07/10/2026, 4:02 PM MST', 'Viewed', 'Email');
  insSD.run('PT-10042', "Add'l Authorization Request Form", 'Summit Spine (corporate)', '07/12/2026, 2:45 PM MST', 'Sent', 'Email');

  const insDoc = db.prepare('INSERT INTO documents(patientId,name,cat,meta) VALUES(?,?,?,?)');
  insDoc.run('PT-10042', 'Police report — 26-114532.pdf', 'Other', '06/05/2026, 11:20 AM MST · Donny C.');
  insDoc.run('PT-10042', 'Signed Medical Bill Pay Agreement.pdf', 'Contract', '06/12/2026, 10:22 AM MST');
  insDoc.run('PT-10042', 'Vehicle damage photos (4).zip', 'Other', '06/05/2026, 11:24 AM MST');
  insDoc.run('PT-10042', 'PIP application — Pacific Mutual.pdf', 'Insurance', '06/08/2026, 3:44 PM MST');

  const insTask = db.prepare('INSERT INTO tasks(id,patientId,title,due,created,by) VALUES(?,?,?,?,?,?)');
  insTask.run('t1', 'PT-10042', "Send add'l auth to Summit Spine", '2026-07-13', '07/12/2026, 2:38 PM MST', 'Donny C.');
  insTask.run('t2', 'PT-10042', 'Follow up Pacific Mutual payment', '2026-07-14', '07/09/2026, 11:02 AM MST', 'Nicole M.');
  insTask.run('t3', 'PT-10042', 'Request visit notes — 07/13 appt', '2026-07-17', '07/11/2026, 8:45 AM MST', 'Donny C.');
  insTask.run('t4', 'PT-10043', 'Upload signed lien agreement — NW Imaging', '2026-07-14', '07/10/2026, 9:00 AM MST', 'Donny C.');
  insTask.run('t5', 'PT-10047', 'Underwriting review — new intake', '2026-07-16', '07/08/2026, 10:12 AM MST', 'Nicole M.');

  const insTC = db.prepare('INSERT INTO task_comments(taskId,text,by,time) VALUES(?,?,?,?)');
  insTC.run('t1', 'Corporate said fax only for auths over 6 visits.', 'Nicole M.', '07/13/2026, 9:05 AM MST');
  insTC.run('t1', 'Fax sent, waiting on confirmation.', 'Donny C.', '07/13/2026, 1:22 PM MST');

  const insNote = db.prepare('INSERT INTO notes(patientId,text,by,time,sys) VALUES(?,?,?,?,?)');
  const N: Array<[string, string, string, string, number]> = [
    ['PT-10042', 'Intake complete. Companion claim linked (passenger). Assigned Summit Spine as primary treating.', 'Donny C.', '06/30/2026, 3:05 PM MST', 0],
    ['PT-10042', 'Payment sent: $351.00 to Summit Spine (DOS 06/25/2026)', 'Donny C.', '07/03/2026, 11:47 AM MST', 1],
    ['PT-10042', 'Adjuster (T. Ruiz) confirmed PIP limits at $15k. Payment for first bill batch in process.', 'Nicole M.', '07/08/2026, 9:12 AM MST', 0],
    ['PT-10042', 'Contract sent: "One-Time Lien — NW Imaging" via e-sign', 'Donny C.', '07/10/2026, 4:02 PM MST', 1],
    ['PT-10042', 'Document added: "NW Imaging — MRI estimate.pdf"', 'Nicole M.', '07/11/2026, 10:15 AM MST', 1],
    ['PT-10042', 'Task created: "Send add\'l auth to Summit Spine"', 'Donny C.', '07/12/2026, 2:38 PM MST', 1],
    ['PT-10042', 'Spoke with pt — chiro says 6 more visits likely. Asked about MRI referral; sent auth request to Summit.', 'Donny C.', '07/12/2026, 2:41 PM MST', 0],
    ['PT-10043', 'Intake complete, linked as companion to Sarah Mitchell.', 'Donny C.', '06/30/2026, 3:10 PM MST', 0],
    ['PT-10047', 'New Trilogy (BI) intake. Awaiting underwriting.', 'Nicole M.', '07/08/2026, 10:10 AM MST', 0],
  ];
  for (const n of N) insNote.run(...n);

  const insAI = db.prepare('INSERT INTO ai_requests(text,time,status,by) VALUES(?,?,?,?)');
  insAI.run('Add "denial reason" column to insurance receipts', '07/13/2026, 4:10 PM MST', 'pending', 'Nicole M.');
  insAI.run('Recolor underwriting widget to green', '07/11/2026, 9:32 AM MST', 'approved', 'Donny C.');

  return true;
}

// Run directly: `npm run seed`
if (process.argv[1] && process.argv[1].endsWith('seed.ts')) {
  const created = seedIfEmpty(true);
  console.log(created ? 'Database seeded with demo data.' : 'Database already has users — skipped.');
}
