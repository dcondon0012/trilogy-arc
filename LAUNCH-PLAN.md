# Trilogy Platform — Portals & Launch Readiness Plan
*Prepared 08/01/2026 · planning document, nothing built yet*

---

## Part 1 — Carrier (Insurance) Portal

**Who logs in:** adjusters, claims supervisors, and a carrier admin. Each is scoped to their own carrier — a Pacific Mutual adjuster must never see another carrier's cases. This is the single most important security boundary in the whole system.

**What they see and do:**

| Feature | Notes |
|---|---|
| Case list for their carrier | Filter by adjuster, stage, claim number. Adjusters see their own by default, supervisors see all. |
| Case detail (read-only) | Demographics, treating providers, dates of service, bill totals, treatment status. **Not** your margin, payout rates, or internal notes. |
| Bills & records | View and download the bill and visit note per DOS; bulk-download a full case packet as one PDF. |
| Adjuster roster | Who's assigned what, case counts, workload — you asked for this and it doubles as a relationship-management view for Miles. |
| Submit a new patient | The referral intake form. Feeds your pipeline as a new case in "Intake" with an SLA clock and auto-assignment to a coordinator. |
| Payment | See what's outstanding, mark a payment as sent with reference/check/ACH detail, upload an EOB/remittance. |
| Message thread per case | Keeps carrier correspondence in the record instead of scattered across email. |

**Design constraint:** an adjuster handles hundreds of claims across many vendors. They will not learn a complicated tool. Target: find a case and download the packet in under three clicks, no manual.

**Reality check worth doing before building:** most carriers will *not* want another portal login. Many prefer secure email, SFTP drops, or an API. Have Miles ask two or three target carriers what they actually want. The likely answer is "portal for the few who'll use it, email/SFTP for everyone else" — which means the portal is the visible layer over an intake pipeline that also accepts email and fax. Build the pipeline first; the portal is one door into it.

---

## Part 2 — Provider Portal

**Who logs in:** office managers and billing staff at each provider; scoped to their organization, and optionally to a single branch.

**What they see and do:**

| Feature | Notes |
|---|---|
| Their patient list | Only patients they're treating, with authorization status and dollars remaining on the auth. |
| Submit bills + records | Upload per date of service, with the bill and visit note together. This directly replaces your staff's data entry. |
| Authorization requests | Request additional visits/dollars; see approvals and the cancel-auth form; sign it electronically. |
| **Payment status** | The #1 question every provider asks: *when am I getting paid?* Show submitted → received → approved → scheduled → paid, with remittance detail. Get this right and the portal sells itself. |
| Their contract & rate | Signed lien agreement on file, agreed rate, so nobody argues about terms later. |
| Onboarding | W-9, NPI, license, banking details for ACH, and the BAA — collected once, tracked for expiry. |

**Same reality check:** small chiro offices run on fax and email. The portal must be optional, not mandatory — an emailed or faxed bill has to land in the same queue as a portal upload. Otherwise you'll lose providers over software.

**Both portals additionally need:** their own login and MFA, separate audit logging of every external access (who viewed which patient, when), rate limiting, terms-of-use acceptance, session timeouts shorter than internal staff, and a documented support path when someone can't get in.

---

## Part 3 — What's currently faked, and how to make it real

Everything below works as a user interface and records the action, but nothing leaves the machine.

| Stub today | Recommendation | Rough cost | Notes |
|---|---|---|---|
| **Email sending** (contracts, auths, notifications) | **Buy — Amazon SES** | ~$0.10 per 1,000 emails | Already inside AWS and covered by your existing AWS BAA. Postmark or SendGrid are friendlier but are separate vendors needing separate BAAs. Keep Microsoft 365 for human email; SES is for system email only. |
| **SMS / text** | **Buy — Twilio** | ~$0.008/message + ~$2/mo number | ⚠️ **Start this early.** A2P 10DLC registration for business texting takes days to weeks and must clear before you can send. Twilio signs BAAs on paid accounts. Never put clinical detail in a text. |
| **E-signature** (lien agreements, patient bill-pay agreement, cancel-auth forms) | **Buy — DocuSign, Dropbox Sign, or SignWell** | ~$25–75/user/mo | Needs a BAA and audit-trail certificates. The status flow in your app is already built for it — it just needs the webhook wired. |
| **Sending payments to providers** | **Buy, with a decision to make** | see below | Three viable paths, below. |
| **Receiving payments from carriers** | **Mostly not software** | — | Carriers pay by check or ACH with an EOB attached, on their schedule. What you need is a **lockbox or dedicated bank account plus reconciliation**, not a payment button. The portal's job is capturing the remittance and matching it to bills — which the reconciliation feature you already have was built for. |
| **Google Maps** | **Buy — Google Maps Platform API key** | ~$7 per 1,000 map loads, ~$200/mo free credit | Unlocks real pins, distance sorting, and drive-time. Cheap at your volume. |
| **Document generation** (filled contract PDFs) | **Buy with e-sign vendor** | included | Their template engine handles merge fields; don't build a PDF generator. |
| **AI site editor** | **Keep as request queue** | — | Today it logs requests for admin review; it does not change the site. Honest framing: it's a feature-request inbox. Real self-service editing is a much larger project — revisit post-launch. |
| **File previews on demo records** | Resolved by real usage | — | Cosmetic; seeded demo rows have no underlying file. |

**Provider payment paths — pick one:**

1. **Bank bulk ACH / QuickBooks Bill Pay** — cheapest and simplest, low engineering. Manual-ish, fine under ~100 payments/month.
2. **Payment API (Increase, Column, Modern Treasury)** — programmatic ACH, full audit trail, scales cleanly. Most engineering, best long-run fit.
3. **Checks** — some small providers still insist. Whatever you choose, support a check path.

Whichever you pick: require **dual approval above a dollar threshold**, and never let one person both create and release a payment. That control belongs in the software before real money moves.

---

## Part 4 — What you didn't ask about, and should

### 4a. This industry runs on things the app doesn't speak yet

- **Fax.** Your own demo data says it: *"Corporate said fax only for auths over 6 visits."* Providers and carriers still fax constantly. You need an inbound fax number that drops documents into the right case, and outbound fax for auths. Buy it — SRFax, Documo, or eFax with an API and a BAA (~$20–50/mo).
- **Clearinghouse / EDI.** Bills to carriers move as **837** files; remittances come back as **835** files. That's the plumbing of medical billing, and Echo is already in your world through Marrick. Right now your bills are PDFs and manual entry. Integrating Echo (or equivalent) is what makes billing scale past a few hundred cases.
- **CPT and ICD codes.** Your bills store a total dollar amount and nothing else. Real bills are line items with procedure codes and diagnosis codes. Without them you can't validate against a fee schedule, can't detect duplicate or upcoded billing, and can't submit electronically. **This is a data-model change and it gets more painful the longer you wait.**
- **Provider credentialing.** No NPI, license number, license expiry, malpractice coverage, or W-9 on file. Carriers will ask, and paying an unlicensed or lapsed provider is a real risk.
- **State fee schedules.** PIP fee schedules vary by state and cap what's payable. Oregon-only at launch makes this manageable; multi-state expansion without a rules engine will hurt.
- **Denials and appeals.** Nothing in the app handles a denied or short-paid bill — no denial reason capture, no appeal tracking, no resubmission. This is a routine part of the business and it's completely absent.

### 4b. Your business model needs instrumentation the app doesn't have

Your PIP launch is supposed to prove a thesis to carriers: *claimants routed through Trilogy retain attorneys less often and escalate less than the carrier's baseline.* **The platform currently cannot produce that number.** There's no field for whether a patient retained an attorney, when, or why; no escalation flag; no way to export a cohort for analysis.

This is the highest-value thing missing, and it costs almost nothing to add now: a few fields, captured from day one. If you launch without it, you'll be reconstructing it from notes a year later when it's time to make the pitch — or you won't have it at all.

Related gaps: no lien or settlement tracking on the Trilogy/BI side (settlement amount, lien reduction, net recovery), and no attorney/law-firm record when one is involved.

### 4c. Money and accounting

- **No accounting integration.** Every payment and receipt will need to reach QuickBooks. Buy the sync — don't hand-key it twice.
- **No 1099 workflow.** You're paying providers; that's 1099 territory. W-9 collection and year-end reporting need a home.
- **No aging or collections report** for carriers who are slow to pay — the alerts flag individual cases but there's no A/R view by carrier.
- **No revenue recognition or period close** — fine now, needed when there's an outside accountant or investor.

### 4d. Operations you'll wish you'd built before the first outage

- **Automated backups with a tested restore.** Today: a manual JSON export. This is the gap most likely to actually hurt you.
- **Staging environment.** Right now every change goes straight to the system your team depends on.
- **Error monitoring and uptime alerts** (Sentry ~$26/mo, BetterStack ~$25/mo). Without these, you learn about outages from a coordinator's text.
- **Formal database migrations.** Schema changes are currently ad-hoc; with real data that's how you lose a column.
- **Incident runbook + on-call.** Who does what at 7am when it's down, and who's allowed to touch production.

### 4e. Compliance beyond the technical build

- **BAAs with providers and carriers**, tracked with expiry — you'll be exchanging PHI with every one of them.
- **Patient right of access.** HIPAA gives patients the right to their records and an accounting of disclosures. There's no way to produce either today.
- **Data retention and legal hold** policy — and the ability to enforce it.
- **Breach notification workflow** — required, and you don't want to design it during a breach.
- **Terms of service and privacy policy** in-app, especially for portal users.
- **Accessibility (WCAG)** — larger carriers' vendor questionnaires ask.

### 4f. Product gaps that will bite at volume

- **Case file export** — one PDF of an entire case for an attorney, carrier, or subpoena. You will be asked for this constantly and there's no way to produce it.
- **Merge duplicate patients** — the app now warns about duplicates but can't merge them once created.
- **Bulk import** — when you onboard a provider network or migrate existing cases, there's no path but manual entry.
- **Printing** — no print-friendly views at all.
- **Mobile** — untested on phones; coordinators and Miles will be in the field.
- **Duplicate bill detection** — same provider, same DOS, billed twice would sail through today.
- **Self-service password reset** — currently an admin has to do it for every forgotten password.
- **Inbound email/fax-to-case intake** — the low-tech door into the same pipeline (see Parts 1 and 2).

---

## Part 5 — Suggested sequence

**Phase 1 — Deploy (before anything else).** AWS with the BAA, Postgres, S3, HTTPS, automated backups, staging, monitoring. Nothing else is safely buildable until the app isn't living on one laptop. ~$100–150/mo.

**Phase 2 — Make the stubs real, in revenue order.** Email (SES) → e-signature → fax → Google Maps key → payments to providers. Start Twilio 10DLC registration in week one of this phase since it's a waiting game.

**Phase 3 — Data model corrections, while data is still small.** CPT/ICD line items, provider credentialing fields, **attorney-retention and escalation instrumentation**, lien/settlement fields. Cheap now, expensive later.

**Phase 4 — Provider portal.** Start here rather than carriers: it removes your own data-entry burden immediately, providers are more motivated to use it, and it's lower-risk to get wrong.

**Phase 5 — Carrier portal + referral intake.** After Miles has validated what carriers actually want.

**Phase 6 — Clearinghouse/EDI, accounting sync, denials workflow, reporting warehouse.**

---

## Part 6 — Decisions I need from you

1. **Provider payments:** bank/QuickBooks bill pay, a payment API, or checks? (Drives Phase 2 scope.)
2. **E-sign vendor:** DocuSign, or a cheaper alternative like SignWell?
3. **Does Marrick's Echo relationship extend to Trilogy**, or do you need your own clearinghouse contract?
4. **Portal-first or intake-first?** My recommendation: build the intake pipeline (email/fax/portal all landing in one queue) rather than a portal alone.
5. **Who owns the AWS account** and holds the credentials — this should be a Trilogy entity account, not a personal one.
6. **Attorney-retention tracking:** confirm the exact fields you'll want to prove the thesis, so we capture them from case #1.

---

*Recurring software cost once live, rough: AWS ~$100–150/mo · e-sign ~$40/mo · fax ~$30/mo · Twilio ~$20/mo + usage · SES a few dollars · monitoring ~$50/mo · maps typically free at your volume. Call it **$300–400/month all-in**, plus the one-time penetration test ($8–25k) before real patient data at volume.*
