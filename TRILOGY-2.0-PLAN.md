# Trilogy 2.0 — Build Plan
*08/25/2026 · supersedes the analysis in OVERHAUL-PLAN.md as the working plan · rollback snapshot: BACKUP-pre-overhaul-2026-08-25.zip*

---

## 0 · The North Star inversion (read this first)

**Marrick funds. We contain.** Marrick's system is tuned to deploy as much capital as it safely can — their metrics celebrate dollars out the door. Trilogy is paid by carriers to do the opposite: **get the claimant into care fast, resolve the case quickly, and keep the total cost to the carrier as low as defensibly possible** — while our margin stays locked per procedure via contracted rates.

Every automation we copy from them gets re-aimed:

| Engine | Marrick's aim | Trilogy's aim |
|---|---|---|
| Underwriting/scoring | "Can we safely fund more?" | "Is this care necessary, conservative, and on-plan?" |
| Provider optimizer | Capture funding volume | **Lowest contracted cost** + conservative-care philosophy + speed + proximity |
| Auth envelope | Dynamic cap that grows (find more coverage) | **Containment guardrail**: flag over-utilization, plateau, discharge readiness |
| Note parsing | Find fundable downstream care | Find plateau/discharge signals AND necessary care — catch both over- and under-treatment |
| Drift detection | Charge drift (protect margin) | Charge drift **and utilization drift** (visits-per-case creeping up by provider) |
| Executive metrics | Deployed $, face value, profit multiple | **Carrier savings vs. baseline, cost per case vs. fee schedule, time-to-treatment, attorney-retention rate** |
| Partner report | "Look how much care we coordinated" | "Look how much we saved you, how fast, with zero attorneys" |

Two guardrails on the guardrails: we never direct care (doctors decide — we pick *which conservative doctors are in the network*, per Perry/DJ-Beach strategy), and speed stays a first-class goal — under-treating or slow-walking claimants creates attorneys, which destroys the whole thesis. **Cheap, fast, and cared-for — the system optimizes all three, and flags whenever they conflict so a human decides.**

---

## 1 · Phase plan

### Phase 1 — Design system + shell *(everything instantly looks like the new company)*
- **Brand:** trilogy wordmark (rounded lowercase, slate `#3D4A5F`, sky-blue `#45A8E8` triangle as the o) everywhere — login, sidebar, portals, favicon.
- **Editorial design language:** warm paper background, white cards with warm hairlines, serif display type (Fraunces) for headlines and stat numbers, Inter Tight for UI, **JetBrains Mono for IDs/CPTs/money/dates**, slate primary + triangle-blue as the "automation" accent color, dot-badges, soft slate shadows, uppercase letter-spaced table headers.
- **Shell:** left sidebar (Today · Cases · Carriers · Providers · Requests · Intelligence · Admin), user card with role, ⌘K command palette (jump to any patient/carrier/provider/action), alerts bell.
- Same treatment applied to the provider and carrier portals (their view keeps the professional look).
- Restyled login page.

### Phase 2 — The Today Decision Deck *(the new front door)*
- "Good morning · N things on your plate" with **overnight receipts** ("system handled X — see the log") built from the audit trail.
- **Outcomes strip**, cost-containment edition: cases ready to close · claimants not yet in care (speed risk) · **cases trending over plan (cost risk)** · patients at risk of dropping out · attorney-risk flags.
- **Decision cards**, one at a time, keyboard-driven, each with outcome statement, "System recommends" + reasoning, context tiles (coverage used, envelope, carrier tier, days-in-case), one-click actions, "do something else" chips. Card sources at launch: bills ready to pay (with margin shown) · bills blocked on records · auth requests (with **utilization check**: visits vs. norm for injury type) · **cost-saver redirects** (cheaper contracted provider available) · **discharge-review flags** (plateau/visit-count signals) · overdue tasks · new referrals awaiting intake · receipts pending · portal access approvals · denials awaiting appeal decision.
- Role variants: Coordinator deck and Exec deck (escalations, drift, plan-vs-actual).
- "Above & beyond" section when the deck is clear.

### Phase 3 — Partner onboarding as configuration *(the JSF packet, digitized, both sides, dual-mode)*
- **Carrier wizard** (self-serve or filled by us on a call, provenance tracked): goals & volume → intake preferences incl. **custom screening questions injected into our intake** → metrics & thresholds (structured numbers that literally arm the alert engine: "flag at 33% of coverage or $20,000") → reporting cadence + recipients with detail tiers → milestone notifications (checkbox list) + high-value protocol threshold → contacts with routing roles (required fields — no blanks) → provider steering incl. carrier-conditional exclusions → settlement/reduction expectations (BI) → tech stack + migration follow-ups → **digital SLA acceptance** backed by a live SLA clock (intake processed within 1 hour, measured and displayed).
- **Provider 10-minute path:** org → credentialing (NPI/license/malpractice — auto-verified at deployment) → branches → **per-CPT rate agreement** → e-sign (stub) → live. Expiry tracking with auto-chases.
- Config executes immediately: thresholds fire alerts, cadences schedule reports, milestones queue notifications, steering rules feed the optimizer.

### Phase 4 — The containment money engines
- **Four-check auto-pay:** ① auth exists ② envelope covers ③ **rate ≤ contract** ④ agreement on file → all green auto-queues payment (one-click release; true auto-pay post-AWS with dual approval). Typed exception queue ("rate 84% over contract → reduce to contracted $640" / "no agreement → start one-time agreement").
- **Envelope as guardrail:** auto-approve within envelope in seconds; over-envelope triggers the utilization check (visits vs. injury-type norm, plateau signals) before a human sees a pre-decisioned card. The envelope never silently grows.
- **Gap → one-time agreement engine:** uncontracted provider detected → candidates → verify → generate one-time agreement → e-sign → file (becomes check #4). Recurring gaps escalate to "worth a full contract" in the Growth queue.
- **Provider optimizer v1:** rank contracted providers by cost-at-contracted-rates + distance + conservative-philosophy tag + preferred status; auto-rollover when scheduling stalls. Cost-saver redirect cards when a cheaper equivalent exists mid-case.
- Duplicate-bill detection; EOB capture UI (Trilopay side).

### Phase 5 — Cases that manage themselves
- **Auto-status** (lifecycle from signals · events parsed · funding state derived) + **case health score** with auto-surfaced reds — where red includes *cost reds* (trending over plan, utilization drift) not just care reds.
- Slide-over case panel with context strip (Coverage · Used · Day-in-case · SOL · Carrier tier · **Cost vs. plan**).
- Consolidated daily outbound per provider/carrier; responses parsed back to cases.
- Scheduling board (hosted availability, patient text-to-book at deployment) with the anti-self-pay referral sheet flow.

### Phase 6 — Growth, intelligence, and the carrier-savings story
- **Growth workspace** (Miles): who-to-work-today ranked queue, cold-partner flags, meeting-prep profiles with nearby clustering, **Texas expansion campaign tracker** (identify → outreach → contracted → soft-launch threshold), network-gap map fed by one-time-agreement patterns.
- **Tiers & scoring:** carrier tier (transparent weighted: volume, pay reliability, denial behavior, referral quality); provider daily score (bill cleanliness, scheduling responsiveness, **cost vs. benchmark, utilization discipline**, sentiment). De-preferring stays human.
- **Drift detection:** provider charge drift, **utilization drift**, carrier pay-cycle drift — evidence + recommended action.
- **Per-carrier enterprise report** that leads with THEIR goals and **savings vs. baseline**, then speed metrics (time-to-first-treatment, imaging by day X), attorney-retention rate vs. their book. This is the renewal weapon.
- **Board pack:** margin by line of business, cost-per-case vs. fee schedule, realized-only losses, concentration, drift, thesis metrics.
- Saved scheduled reports.

### Phase 7 — Deployment-dependent brains *(UI built in 1–6, intelligence at AWS)*
Note parsing on arrival (plateau + care-rec + red-flag extraction, damaging info held internally) · post-appointment check-ins via SMS · EOB reading · bill OCR into CPT lines · the cited internal Assistant · real e-sign/email/fax through the hub.

---

## 2 · What survives untouched
Schema and data · auth/roles/approvals · portal security boundaries (payout privacy, adjuster scoping, consent gate) · CPT rate engine · void/reconciliation · audit log · 148-test suite (grows every phase). Rollback = the snapshot zip + git.

## 3 · This session's target
Phases 1–3 built, tested, and deployed to your Mac. Phases 4–6 next sessions. Phase 7 rides with the AWS migration.
