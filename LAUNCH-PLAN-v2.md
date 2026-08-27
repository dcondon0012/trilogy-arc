# Trilogy Platform — Launch Plan v2
*Revised 08/01/2026 after Donny's line-by-line review · planning document, nothing built yet*

---

## Decisions locked in this round

| Question | Decision |
|---|---|
| Clearinghouse | **Not Echo.** Naul and Perry both advise against — too old, doesn't integrate. Alternatives below. |
| Provider payments | **Payment API.** Volume needs to exceed ~100 payments/month to be profitable, which rules out manual bill pay. Checks supported for providers who demand them; deprioritize those providers over time. |
| Carrier payments | Land in a bank account, **auto-reconciled** in the platform. The only workflow allowed to live outside the portal. |
| E-signature | Whatever integrates cleanest and is cheapest **without hurting usability**. |
| AWS account owner | **Trilogy entity account** (not personal). |
| Portal vs. intake | **Build concurrently** — they're the same backend. |
| Everything else | Staff work in **one place: the portal.** |

**The organizing principle for everything below:** your team touches the portal and nothing else. Whatever channel a document arrives on, it lands in the portal. Whatever you send, it goes out from the portal.

---

## Part 1 — The Communication Hub (the backbone)

This is now the centerpiece of the build, not a side feature. Every other piece plugs into it.

### Inbound — everything lands in the portal

```
Email  ─┐
Fax    ─┼──▶  Intake queue  ──▶  auto-matched to case  ──▶  portal
Portal ─┘         (unmatched items go to a triage queue)
```

- **Email:** Amazon SES receives mail at addresses like `bills@`, `records@`, `auths@`, writes the raw message and attachments to S3, and triggers processing that files it against the right case. *(Answering your question: yes — SES receives, not just sends. Details in Part 5.)*
- **Fax:** an inbound fax number from a fax API vendor delivers the PDF into the exact same queue. Nobody handles paper.
- **Portal upload:** provider or carrier uploads directly — same queue, same downstream handling.

**Auto-matching** works off claim number, patient name + DOB, provider identity, and the sending address. Anything the system can't confidently match goes to a **triage queue** where a coordinator assigns it in one click. Expect 10–20% needing triage early, dropping fast as sender addresses get learned.

**The "Bills Waiting to be Processed" queue** you described becomes a real screen: every inbound bill regardless of channel, showing patient, provider, DOS, amount, parse confidence, and what's missing. Coordinators work top to bottom — review, approve, pay. This screen is where your team will spend most of their day.

### Outbound — everything sends from the portal

One "Send" action on any case, with channel selection: **email · text · fax · e-signature**. Same template library, same recipient auto-fill you already have. Every send is logged to the case automatically, as it is today.

### Two-way threading (the piece that makes it actually work)

Replies have to come back to the right case without anyone re-filing them. The technique is **per-case reply addresses** — outbound mail uses a reply-to like `case-PT10042@in.trilogymed.com`, so when the adjuster hits reply it routes straight back to that case's thread. Your team then reads and replies **inside the portal**, never opening a mail client for case work.

**Note on Outlook:** keep Microsoft 365 for normal human business email — Miles's carrier relationships, calendar, contracts, internal mail. Don't try to replace it. SES handles *case-channel* mail only. Two systems, but your staff only ever works case correspondence in the portal.

---

## Part 2 — AI bill parsing (PDF → structured data)

Bills arrive as PDFs. Rather than typing CPT codes by hand, the platform reads them.

**Pipeline:** PDF lands in the queue → **Amazon Textract** extracts text and table structure → **Amazon Bedrock (Claude)** converts that into structured fields: CPT codes, ICD codes, units, charge per line, DOS, rendering provider, NPI, total.

Both services are HIPAA-eligible and covered by your existing AWS BAA, so no new vendor, no new agreement, and PHI never leaves your AWS account.

**Non-negotiable control: a human confirms before money moves.** The parse populates the bill; a coordinator sees the extracted fields side by side with the PDF and approves or corrects. High-confidence parses can be one-click; anything below threshold gets flagged. Corrections feed back as examples, so accuracy climbs. **Never auto-pay a parsed bill without review** — that's how a mis-read decimal becomes a five-figure mistake.

Realistic accuracy on clean HCFA-1500 forms is high; handwritten or poor-quality faxes will always need more review. Budget roughly $0.02–0.10 per bill.

---

## Part 3 — Provider Portal *(build first)*

Providers are the higher-value, lower-risk starting point: it removes your team's data entry immediately and providers are motivated to use anything that gets them paid faster.

| Feature | Notes |
|---|---|
| Their patient list | Only their patients; auth status and dollars remaining. |
| Submit bills + records | Upload per DOS. Feeds the same queue as email and fax. |
| **Payment status** | Submitted → received → approved → scheduled → paid, with remittance detail. The #1 provider question; get it right and adoption follows. |
| Authorization requests | Request more visits/dollars; see approvals; sign the cancel-auth form electronically. |
| Messages | Threaded per case, mirrored to email/fax for providers who won't log in. |
| Contract & rate | Signed lien agreement and agreed rate visible, so terms never get argued. |
| **Credentialing vault** | W-9, NPI, license + expiry, malpractice, BAA, banking details for ACH. Lives in the provider's business area so you can produce it the moment a carrier asks. |

Scoped per organization, optionally per branch. Providers who never log in are fully supported through fax/email — the portal is one door, not the only door.

---

## Part 4 — Carrier Portal

| Feature | Notes |
|---|---|
| Case list for their carrier | Hard boundary: never another carrier's data. |
| Case detail (read-only) | Demographics, providers, DOS, bill totals, treatment status. **Never** your margin or payout rates. |
| Bills & records | Per-DOS download plus full case packet as a single PDF. |
| Adjuster roster | Who's assigned what, case counts, workload. |
| Submit a new patient | Referral intake → new case in Intake with SLA clock and auto-assignment. |
| Payment | See outstanding balance, report a payment with check/ACH reference, upload the EOB. Money itself moves bank-to-bank. |
| Messages | Threaded per case, same hub. |

Still worth having Miles ask two or three target carriers what they'd actually use before the UI is finalized — but since the intake pipeline is being built regardless, that question no longer blocks anything.

---

## Part 5 — Integrations, concrete

| Need | Pick | Cost | Notes |
|---|---|---|---|
| **Email send + receive** | **Amazon SES** | ~$0.10/1,000 sent; receiving ~$0.10/1,000 + S3 | Receives into S3 and triggers processing — exactly what the hub needs. Must run in an SES receiving-enabled region; 40 MB max per message (relevant for big fax-to-email batches). Covered by your AWS BAA. |
| **SMS** | **Twilio** | ~$0.008/msg + ~$2/mo/number | ⚠️ **Start A2P 10DLC registration in week one** — multi-week approval, blocks nothing else but gates go-live. BAA on paid accounts. Never put clinical detail in a text; use it for "document ready, log in to view." |
| **Fax (send + receive)** | **Documo/mFax, SRFax, or Phaxio** | ~$20–50/mo + per-page | Must have a real API and sign a BAA. Inbound number feeds the queue; outbound sends from the portal. |
| **E-signature** | **SignWell or Dropbox Sign** | ~$15–40/user/mo | Both far cheaper than DocuSign with solid APIs and BAAs. DocuSign only if a carrier contractually demands it. |
| **Provider payments** | **Payment API — Modern Treasury, Increase, or Column** | ~$0.25–1.00/ACH + platform fee | Programmatic ACH with full audit trail. Requires encrypted storage of provider bank details, **dual approval above a dollar threshold**, and separation between whoever creates and whoever releases a payment. Check printing as a fallback. |
| **Accounting** | **QuickBooks Online sync** | ~$100/mo | Bills, payments, receipts flow to QBO. Also where 1099s for providers come from. |
| **Carrier payments in** | **Bank account + auto-reconciliation** | — | Dedicated account or lockbox; automated matching against open bills using the reconciliation engine already built. |
| **Maps** | **Google Maps Platform** | ~$7/1,000 loads, ~$200/mo free credit | Real pins, distance sort, drive time. Effectively free at your volume. |
| **Clearinghouse (not Echo)** | **Jopari** or **P2P Link (Mitchell)** | quote-based | See below. |

### Do you even need a clearinghouse? *(Probably not at launch.)*

First, a category correction: **QuickBooks and the payment API cannot replace a clearinghouse, because they do unrelated jobs.**

| Tool | Job |
|---|---|
| Clearinghouse | Transmits bills **to carriers** in standard medical format (837) and receives remittance/denial files (835) back |
| Payment API | Moves money **out to providers** by ACH |
| QuickBooks | Records all of it for **accounting** |

None of them overlaps with another. So the real question isn't "which tool replaces it" — it's **do you need the function a clearinghouse performs at all?**

**Likely not at launch, because of your structure.** You aren't a provider billing an insurer. You're a contracted network partner invoicing a carrier under a master services agreement. If your carriers accept a consolidated invoice with supporting documentation — sent by email, SFTP, or their portal — then no clearinghouse is required. Two or three carriers at launch volume is entirely manageable that way.

**You'd add one when any of these becomes true:**
- A carrier requires 837 EDI submission because their claims system expects it (common for PIP, since that's how they apply fee schedules)
- A state mandates electronic billing for auto/PIP claims
- Volume makes manual submission and manual payment posting painful
- You want **automated 835 remittance posting** — this is the real prize. It auto-posts payments and denial reasons instead of your team keying EOBs by hand. Worth it at volume; unnecessary at 25 cases a month.

**Action:** have Miles ask each target carrier one question — *"How do you want to receive our bills, and do you require e-billing through a clearinghouse?"* If they all accept direct invoicing, skip it entirely and save the setup cost and integration work. If any require it, the auto/workers' comp specialists are **Jopari Solutions** and **P2P Link (Mitchell/Enlyte)** — note that general-purpose clearinghouses like Availity, Office Ally, and Waystar are built for health plans, not auto. Pick whichever your carriers already connect to.

**Recommendation: defer this decision.** Build the invoicing and remittance-capture flow so it works manually, and design it so a clearinghouse can slot in later without a rewrite.

---

## Part 6 — Data model changes (do these while data is still small)

1. **Bill line items** — CPT code, ICD code(s), units, charge per line, modifier, rendering provider NPI. Replaces the single dollar total. Feeds the AI parser, fee-schedule validation, duplicate detection, and e-billing.
2. **Provider credentialing** — NPI, license number and expiry, taxonomy, W-9 on file, malpractice carrier and expiry, BAA signed date, banking details (encrypted). Lives in the provider's business area, per your note.
3. **State fee schedule linked to the patient** — schedule attaches to the case based on state of accident, so allowed amounts validate automatically. Oregon at launch; the structure makes multi-state expansion additive rather than a rewrite.
4. **Denials and appeals** — denial reason codes, appeal status, resubmission tracking, deadline clock. Routine business, currently absent entirely.
5. **Lien and settlement** (Trilogy/BI side) — settlement amount, lien asserted, lien reduction, net recovery.
6. **Attorney tracking** — whether the claimant retained counsel, **when** (relative to intake), firm name, and how you learned. This is a *thesis metric*, not admin trivia — see Part 7.
7. **Case velocity timestamps** — every stage transition already logs to the audit trail; promote them to queryable fields so days-per-stage is a report, not an archaeology project.

---

## Part 7 — The three metrics you're actually selling

You named these as the priority: **case velocity, attorney retention, and carrier savings.** All three need capture designed *before* case #1, even though the reports come later.

- **Case velocity** — days from referral to first treatment, per stage, to case closure. Straightforward once stage timestamps are queryable. Also your best internal operations metric.
- **Attorney retention** — the percentage of Trilogy-managed claimants who retain counsel, and how that compares to the carrier's own baseline. Requires the attorney fields above plus a disciplined intake habit of asking and recording.
- **Carrier savings** — the hardest and most valuable. **Define the methodology before you collect a single data point**, because carriers will scrutinize it: billed charges vs. what the carrier paid through Trilogy vs. a defensible baseline of what they'd have paid otherwise. Work the baseline definition out with your regulatory attorney and ideally validate it with a friendly carrier contact. A savings number you can't defend is worse than none.

**Reporting home:** A/R aging by carrier, days-to-pay, and denial rates belong in the Admin area as a carrier-management view, as you suggested. The three thesis metrics deserve their own exportable report for the carrier pitch deck.

---

## Part 8 — Operations *(you agreed with all of this)*

Automated backups with a **tested restore**; a staging environment; error monitoring (Sentry ~$26/mo) and uptime alerts (~$25/mo); formal database migrations; an incident runbook naming who does what at 7am. None of it is glamorous and all of it is cheaper than the first outage.

---

## Part 9 — For the attorney *(flagged, not decided)*

**Compliance questions:** BAAs with every provider and carrier (tracked with expiry); patient right of access and accounting of disclosures; data retention and legal hold; breach notification workflow; terms of service and privacy policy for portal users; accessibility standards that appear on carrier vendor questionnaires.

**Contracts that still need drafting — none of these exist yet:**
- Provider lien agreement and one-time lien
- Patient medical bill-pay agreement, HIPAA release, and consent
- Carrier agreements for both Trilopay (PIP) and Trilogy (BI)
- Adjuster-level agreements, if you pursue them *(previously flagged as a possible gray area — confirm with the attorney)*
- BAA templates for providers and carriers

The platform's templates are placeholders until real executed documents replace them. This is on the critical path to launch and depends on nobody but the attorney — **start it now.**

---

## Part 10 — Product gaps *(you agreed with all of this)*

Case file export as a single PDF (you'll be asked constantly); merge duplicate patients; bulk import for onboarding a provider network; print-friendly views; mobile testing; duplicate bill detection (same provider + same DOS); self-service password reset.

---

## Part 11 — Revised sequence

**Phase 0 — Deploy to AWS.** Trilogy-owned account, BAA accepted, Postgres, S3, HTTPS, automated backups, staging, monitoring. Nothing else is safely buildable first. *~$100–150/mo.*

**Phase 1 — Communication hub foundation.** The unified intake queue and data model, SES send + receive, per-case reply addresses, fax vendor, outbound email/text/fax from the portal, triage queue. **Start Twilio 10DLC registration on day one of this phase.** This is the backbone — most later work plugs into it.

**Phase 2 — Data model + AI bill parsing.** Bill line items with CPT/ICD, credentialing fields, state fee schedules, denial/appeal structures, attorney and velocity tracking fields, lien/settlement fields. Then Textract + Bedrock parsing into the review queue. *Tracking fields go in now even though the reports come in Phase 6 — capture has to start with case #1.*

**Phase 3 — Provider portal + intake, concurrently.** Same backend, so yes — these build in parallel. The queue and data model from Phases 1–2 are the shared foundation; portal UI and the email/fax channels then proceed side by side.

**Phase 4 — Payments.** Payment API for provider ACH with dual approval, check fallback, carrier payment auto-reconciliation, QuickBooks sync.

**Phase 5 — Carrier portal + referral intake.** Including the adjuster roster view and new-patient submission.

**Phase 6 — Denials/appeals workflow and the reporting layer** — A/R aging, case velocity, attorney retention, carrier savings. **Clearinghouse only if a carrier requires it** (Part 5) — build invoicing so it works manually and a clearinghouse can slot in later without a rewrite.

**Running in parallel throughout, owned by you and the attorney, not by the software:** contract drafting, BAA templates, clearinghouse selection conversations with carriers, and the penetration test before real PHI at volume.

---

## Part 12 — Cost model and unit economics

### Fixed monthly costs (flat regardless of volume)

| Item | Cost/mo |
|---|---|
| AWS — Postgres, compute, load balancer, S3, logs | $100–150 |
| QuickBooks Online | ~$100 |
| Monitoring — Sentry + uptime | ~$50 |
| E-signature | ~$40 |
| Fax — base subscription | ~$30 |
| Twilio number + SES base | ~$10 |
| Google Maps | $0 *(under the free credit at any realistic volume)* |
| **Fixed total** | **~$350–400** |

### Variable cost per case

| Item | Assumption | Per case |
|---|---|---|
| AI bill parsing | ~6 bills × $0.05 | $0.30 |
| Fax pages in/out | ~20 pages × $0.06 | $1.20 |
| ACH payments to providers | ~6 × $0.50 | $3.00 |
| SMS | ~10 × $0.008 | $0.08 |
| Email + document storage | — | $0.05 |
| **Variable total** | | **~$5** |

### Total by volume

| Active cases/mo | Fixed | Variable | **Total/mo** | **Software cost per case** |
|---|---|---|---|---|
| 25 — launch | $375 | $125 | **~$500** | **$20** |
| 100 — ramp | $400 | $500 | **~$900** | **$9** |
| 500 — scale | $600 | $2,500 | **~$3,100** | **$6** |
| 2,000 — $100M trajectory | $1,500 | $10,000 | **~$11,500** | **$5.75** |

Software cost per case *falls* as you grow — fixed costs amortize and the variable component is genuinely small. Even at 2,000 cases a month, the entire platform costs about what one part-time employee does.

### What you actually need to earn per case

**The honest headline: software is not your cost driver. Labor is — by roughly 20 to 50 times.**

Illustrative model *(substitute real Marrick figures before relying on any of this)*:

| Cost component | Per case |
|---|---|
| Software | $6–20 |
| Coordinator labor — manual process | ~$310 |
| Coordinator labor — with the automation in this plan | ~$190 |
| **Case-level cost floor** | **~$200–330** |

The labor figure assumes a loaded coordinator cost of ~$4,600/month, ~60 concurrent cases handled manually, and a ~4-month average case duration — about 15 completed cases per coordinator per month. Push concurrent caseload to 100 through the unified inbox, AI bill parsing, and the portals, and throughput rises to ~25/month, dropping labor to ~$190 per case.

**That's the real ROI of this build.** The automation isn't worth building to save the $5 of software cost — it's worth building because it moves roughly **$120 per case** from labor into margin, and lets you grow headcount slower than caseload. At 500 cases a month that's about $60,000 a month in avoided labor.

**Break-even guidance:** your gross spread per case needs to clear roughly **$350** to cover case-level costs with any margin — and meaningfully more at low volume, where founder salaries, legal, insurance, and other overhead spread across few cases. Overhead per case at 25 cases/month is brutal; at 500 it's noise. This is the ordinary shape of the business, and it's why getting to volume matters more than trimming any line item above.

### The constraint that actually matters: working capital

You pay providers before carriers pay you. That gap, not software cost, is your binding financial constraint.

Illustratively, at 100 cases/month with ~$1,900 paid out per case and a 30–45 day collection lag, you'd have roughly **$190,000–285,000 continuously tied up in float**. At 500 cases/month it's north of a million. Every day you shave off carrier days-to-pay frees real cash.

This is precisely what the A/R aging report, days-to-pay tracking, and carrier payment alerts are for — they're not reporting niceties, they're cash-flow instruments. It's also the strongest argument for eventually adding automated 835 remittance posting: faster posting means faster follow-up on slow payers.

*All figures above are illustrative modeling assumptions, not projections. Ground them in actual Marrick billing data before using them for planning or in any investor material — and note that I'm not a financial advisor; the unit-economics framework is yours and your accountant's to validate.*

---

## Part 13 — Still open

1. **Do your carriers require e-billing at all?** Miles asks each one: *"How do you want to receive our bills, and do you require a clearinghouse?"* If they accept direct invoicing, skip it entirely (see Part 5).
2. **Payment API vendor** — Modern Treasury, Increase, or Column. I can compare on pricing and ACH limits when you're ready.
3. **Carrier savings methodology** — needs defining with the attorney before data collection starts.
4. **Fax vendor** — pick one and get the number provisioned early; porting and BAA take longer than the integration.
5. **Do adjuster-level agreements survive attorney review?** Affects the carrier portal's contract features.

---

*Full cost model in Part 12. Summary: **~$500/month at launch volume, ~$900 at 100 cases/month, ~$3,100 at 500** — falling from $20 to $6 per case as you scale. Plus a one-time penetration test ($8–25k) before real PHI at volume.*
