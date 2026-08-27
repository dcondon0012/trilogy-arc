export interface User {
  id: string; name: string; email: string;
  role: 'admin' | 'coordinator' | 'sales' | 'provider' | 'carrier';
  mustChangePw?: boolean; orgId?: string | null; perms?: string[];
}
export const canUseFees = (u?: User | null) =>
  !!u && (u.role === 'admin' || u.role === 'sales' || (u.perms || []).includes('fees'));
export interface BillItem { id: number; billId: string; cpt: string | null; icd: string | null; units: number; charge: number; modifier: string | null; }
export interface CaseMessage { id: number; patientId: string; authorName: string; authorType: 'staff' | 'provider' | 'carrier'; text: string; time: string; }
export interface IntakeItem {
  id: number; channel: 'portal' | 'email' | 'fax'; kind: string;
  status: 'triage' | 'queued' | 'processed' | 'rejected';
  patientId: string | null; providerId: string | null;
  fileId: string | null; fileName: string | null; fromInfo: string | null;
  note: string | null; receivedAt: string; parsed: string | null; processedBy: string | null;
  patientName?: string | null; providerName?: string | null;
}
export interface AlertItem { severity: 'high' | 'med'; patientId: string; patientName: string; text: string; }
export interface RosterPatient {
  id: string; name: string; caseType: string; stage: number; coordinator: string | null;
  doi: string | null; insurerId: string | null; openTasks: number; unpaidBills: number;
}
export interface PatientSummary {
  id: string; name: string; caseType: string; stage: number;
  insurerId: string | null; adjusterId?: string | null; coordinator: string | null;
  phone?: string; email?: string;
}
export interface OutsideBill { id: number; desc: string; amt: number; }
export interface Note { id: number; text: string; by: string; time: string; sys: number; }
export interface TaskComment { id: number; text: string; by: string; time: string; }
export interface Task { id: string; title: string; due: string | null; created: string; by: string; comments: TaskComment[]; }
export interface ProvLink {
  id: number; providerId: string; branch: string | null;
  authAmount: number; authCount: number; billed: number;
  status: 'pending' | 'authorized' | 'canceled' | 'finalized';
}
export interface Bill {
  id: string; providerId: string; dos: string; billed: number; rate: number;
  hasBill: number; hasNote: number;
  billFileId: string | null; billFileName: string | null;
  noteFileId: string | null; noteFileName: string | null;
  status: 'unpaid' | 'paid'; paidDate: string | null;
  voided: number; voidReason: string | null; coveredBy: number[];
  items: BillItem[]; denied: number; denialReason: string | null; appealStatus: string;
}
export interface Receipt {
  id: number; date: string; ref: string; amount: number; status: string;
  voided: number; voidReason: string | null; billIds: string[];
}
export interface SentDoc { id: number; name: string; to: string; time: string; status: string; method: string; }
export interface PtDocument { id: number; name: string; cat: string; meta: string; fileId: string | null; }
export interface Patient extends PatientSummary {
  address?: string; dob?: string; doi?: string; state?: string;
  claimNumber?: string; policyNumber?: string; adjusterId?: string | null;
  companionId?: string | null; accident?: string;
  attorneyRetained?: number; attorneyDate?: string | null; attorneyFirm?: string | null; escalated?: number;
  agentName?: string | null; agentContact?: string | null; agentAuth?: number;
  referralSource?: string | null; carrierConfirmed?: number; consentSharing?: number;
  messages: CaseMessage[];
  appointments: { id: number; providerId: string | null; whenAt: string; note: string | null; createdBy: string }[];
  uw: { status: string; coverage: string; limit: number; riskFlags: string; approvedBy: string; outsideBills: OutsideBill[] };
  notes: Note[]; tasks: Task[]; provLinks: ProvLink[]; bills: Bill[];
  receipts: Receipt[]; sentDocs: SentDoc[]; documents: PtDocument[];
}
export interface Branch {
  id: number; providerId: string; name: string; address: string; phone: string; email: string;
  contacts: string; rate: string; status: string; contract: string | null; disputes: number;
  ratePct: number | null; rateCap: number | null;
}
export interface Provider {
  id: string; name: string; type: string; status: string[];
  corpAddress: string; corpPhone: string; corpEmail: string; taxId: string;
  rules: string[]; branches: Branch[];
}
export interface Adjuster { id: string; insurerId: string; name: string; phone: string; email: string; contract: string | null; notes: string; }
export interface InsContract { id: number; name: string; meta: string; status: string; }
export interface Insurer {
  id: string; name: string; hq: string; phone: string; email: string;
  relationship: string; payRate: string; states: string[]; rules: string[];
  avgDays: number; disputes: number; denialRate: number;
  adjusters: Adjuster[]; contracts: InsContract[];
}
export interface WidgetPref { key: string; color: string | null; size: string | null; }
export interface AiRequest { id: number; text: string; time: string; status: string; by: string; }
export interface HomeTask { id: string; patientId: string; patientName: string; title: string; due: string | null; created: string; by: string; }
export interface Bootstrap {
  user: User; users: User[]; patients: PatientSummary[];
  providers: Provider[]; insurers: Insurer[]; prefs: WidgetPref[];
}
export const STAGES = ['Intake', 'Underwriting', 'Treating', 'Done Treating', 'Paid Out'];

export const fmtDate = (iso?: string | null) => {
  if (!iso) return '—';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso);
};
export const fmt$ = (n: number) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtK = (n: number) => (n >= 1000 ? '$' + (n / 1000).toFixed(1) + 'k' : fmt$(n));
export const todayISO = () => new Date().toISOString().slice(0, 10);
export const initials = (name: string) => name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
