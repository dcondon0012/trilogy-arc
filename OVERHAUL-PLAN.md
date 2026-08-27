# Trilogy 2.0 — The Overhaul Plan
*08/25/2026 · based on deep review of marrick-rebuild (strategy doc), marrick-proto (working prototype v6), and the JSF Enterprise Onboarding packet · current platform snapshotted in `BACKUP-pre-overhaul-2026-08-25.zip` + git*

---

## What the Marrick material actually is, and the translation key

**marrick-rebuild** is a strategy manifesto: "The system owns the work. People own the outcomes." Their claim: 57–79% of task volume is eliminable — 207 people doing what ~125 could do. **marrick-proto** is the working demo of that idea. The **JSF packet** is a 25-question partner-configuration interview whose answers *become the program*.

The translation for us is nearly 1:1 with one substitution: **their law firm = our insurance carrier** (the referring partner whose preferences configure everything). Their provider side maps directly. Their lien economics map to our contracted-rate economics — arguably *simpler* for us, since Perry's model locks margin per CPT.

Our current platform is a good **records system**. What Marrick's material shows is the difference between a records system and an **operating system**: today our software stores what happened; theirs decides what should happen next and asks a human only when it can't.

---

## Part 1 — The paradigm shift: from task list to Decision Deck

**The single biggest change.** Replace our Home page (stat cards + task list) with the role-based **"Today"** screen:

- "Good morning, Donny · Wednesday · 13 things on your plate"
- **Overnight receipts:** "The system handled 33 tasks · sent 11 carrier updates · confirmed 12 appointments · auto-cleared 4 referrals" — with an expandable timestamped log. Trust is built by showing the work.
- **Outcomes strip** (the ends, not the means): "9 cases ready to close · 4 stalled in treatment · 2 patients at risk of dropping out · 3 bills stuck"
- **The Decision Deck:** one card at a time (keyboard ↑↓, A to approve), each with: colored urgency stripe · type tag (⚡ system / ◉ you / ↪ handed) · SLA age ("8 hrs · 16 left") · an **outcome statement** · a **"System recommends"** band with its reasoning · four context tiles (coverage, used, carrier tier, score) · one-click actions ("✓ Approve $1,400" / Counter / Decline / Escalate) · "Do something else" chips.
- **Above & beyond** when the deck is empty: pull-forward work and relationship touches.
- Role variants: Coordinator, Exec (Donny/Miles/Perry/Naul — deployment vs plan, drift, escalations), Biller, BDM (Miles — see Part 6).

Every existing screen stays reachable (Cases, Directory, entity pages become slide-over panels), but **the deck becomes the front door.** The glyph grammar — ⚡ system did it / ◉ you decide / ↪ system prepped it, you call it — becomes our house language.

## Part 2 — The guardrail engine (automation you can see and veto)

- **Rules panel** (evolves our Admin): every automation as a named rule with trigger, on/off toggle, runs/month, time saved. "Anything the system does automatically, you can also do by hand."
- **Decision audit:** every automated decision shows its inputs, output, reasoning, and reviewer — click any decision to "see the math." (Extends our audit log.)
- **One-click override + reason**, logged, with an override-rate health band (their 0.4–1.2%).
- KPI header: "Tasks completed this month · staff hours saved · active rules · override rate."

## Part 3 — Intake → decision as a pipeline (target: minutes, not days)

Their flow, ours to copy: **Parse referral → Score & underwrite → Pick provider → Authorize → human reviews only exceptions.** ("Intake → decision in 11 min.")

1. **Referral scoring** — a transparent factor model per case (coverage confirmed, state rules, carrier tier, injury type, attorney risk) producing a score + recommendation card, not a hidden verdict.
2. **Provider optimizer** — rank by contracted-rate cost + distance + preferred status + availability; auto-propose; **auto-rollover** to next-best when scheduling fails within the window.
3. **Auto-authorization within the envelope** — dollar-based auth envelope per case (we have the pieces: limit − outside − usage); requests within it auto-approve in seconds and notify; beyond it → a pre-decisioned card.
4. **Carrier SLA clock** — "processed within one hour of receipt" as a measured, displayed number (the JSF commitment page, but live).

## Part 4 — Money: four-check auto-pay + gap-driven one-time agreements

Upgrade our pay-gating to their formal **four-check**: ① authorization exists ② available envelope covers it ③ rate matches contract (CPT rates we already built) ④ **agreement on file**. All green → auto-queue for payment (one-click release at first; true auto-pay later with dual approval). Failures become a small **typed exception queue** ("rate 84% above contract → Reduce to contracted $640" / "no agreement → Start one-time agreement").

- **Gap detection → one-time lien engine** (their SCA system): bill or referral from an uncontracted provider triggers: find candidates, verify (NPI/license/exclusions at deployment), generate the one-time agreement, e-sign, file — and **recurring gaps escalate**: "4 one-time agreements with this provider in 90 days → worth a full contract" lands in Miles's queue.
- **EOB capture** on the Trilopay side: reads EOBs, logs plan-paid per DOS (deployment parser; UI now).
- Duplicate-bill detection (same provider+DOS+amount) — blocks silently, logs.

## Part 5 — Cases that manage themselves

- **Auto-status, three dimensions:** lifecycle phase detected from signals (notes arriving, treatment cadence, time since last DOS) · phase events parsed from comms · funding state derived from money events. **No one updates dropdowns.**
- **Case health score** (green/amber/red) with auto-surfaced reds: patient gone dark, bills exceeding auth, no signals too long, coverage nearly exhausted. (Our alerts bell grows into this.)
- **Slide-over case panel** replaces the full-page patient screen: breadcrumb, context strip (Coverage · Used · Day in case · SOL · Carrier tier), tabs with counts, K/J prev-next. Everything we built (transactions, contracts, auths, messages) lives inside it.
- **Note reading on arrival** (deployment AI, UI now): extract CPTs and care recommendations (auto-auth within envelope or 1-click queue), and **hold case-damaging findings internally** — never auto-shared outward.
- **Post-appointment check-ins** (SMS at deployment): conversational, feeds provider sentiment + downstream-care capture + auto-drafted carrier updates.
- **Consolidated outbound:** one batched daily touch per provider and per carrier — "instead of five people emailing one provider about five patients." Queue visible, "sends 4pm," responses parsed back to the right cases.

## Part 6 — Partner machinery (the JSF packet, digitized — for carriers AND providers)

**The insight from the PDF: onboarding answers shouldn't be notes — they should be configuration that executes.**

**Carrier onboarding wizard** (replaces our thin signup): multi-step, save-and-resume, fillable by the carrier self-serve *or* by us during the call (answer provenance tracked):
1. Goals & volume projections (feeds capacity planning + their enterprise report)
2. Intake preferences — channels, required fields, **custom screening questions injected into our intake form** (their "head injury screening"), templates
3. Metrics & thresholds — structured, e.g. "flag at 33% of coverage or $20,000," "MRI by 90 days" → **these literally arm our alert engine**
4. Reporting — cadence dropdown, recipients with per-person detail tiers → auto-scheduled delivery
5. Case-level comms — milestone checkboxes (MRI resulted, surgery, no-show, stalled >X days), high-value protocol threshold, channel prefs, adjuster routing
6. Contacts — primary/backup with roles, required-field validation (no blank Q20s)
7. Provider steering — preferred lists, exclusions **including carrier-conditional rules** ("exclude X when carrier is Allstate")
8. Settlement/reduction expectations (BI side)
9. Tech stack + planned migrations → integration follow-up tasks
10. **Digital SLA acceptance** — our commitments page, e-signed, with a live SLA dashboard behind it

**Provider onboarding: the 10-minute path** — guided self-service: org info → NPI/license/malpractice (auto-verified at deployment) → branches → rate agreement → banking (deployment) → e-sign → live. Credentialing expiry tracking with auto-renewal chases.

**Tiers & continuous scoring** — carrier tier as a transparent weighted score (volume 35 · margin 30 · pay reliability 15 · denial behavior 10 · referral quality 10, recomputed continuously, weights adjustable); provider score recomputed daily (bill cleanliness = four-check pass rate, scheduling responsiveness, sentiment, rate vs. benchmark). Consequential actions (de-preferring) stay human — "rate is king."

**Drift detection** — provider charge drift ("avg per-visit up 22% QoQ, ~$X projected over-cost"), carrier pay-cycle drift ("48 → 71 days — relationship check-in before tier downgrade"), each with evidence rows + recommended action.

## Part 7 — Growth workspace (Miles's Texas machine)

Directly from their BDM tab, arriving just in time for October 1:
- **"Who to work today"** — carriers/providers ranked overnight: going-cold flags ("no referral in 31 days against a steady pattern"), hot prospects (fit-scored), thank-you-call triggers.
- **Meeting prep cards** — full relationship profile + **nearby clustering** ("3 other targets within 15 minutes — plan a day around this").
- **Market expansion campaigns** — the Texas launch as a tracked funnel: identify providers from public NPI data → outreach waves → responded → contracted → soft-launch threshold ("~20 PT + 5 imaging contracted = go"). Kentucky/Tennessee screens in their proto are exactly our Texas/Oregon.
- **Network gap map** — recurring one-time agreements and referral ZIPs vs. coverage → "build out Pueblo MRI."

## Part 8 — Reporting & the executive layer

- **Saved parameterized reports** with schedules ("every Monday 7am" email), scoped by permission. Their starter list maps directly: case aging by stage, provider rate vs. benchmark outliers, carrier margin trailing-12, SOL-approaching.
- **Per-carrier enterprise report** — leads with *the carrier's own stated goals* from onboarding, then care metrics (time-to-first-MRI, imaging by day 90, balance at 90 days, no-shows), delivered on their chosen cadence. This is the carrier-retention product.
- **Board pack** — live: deployed vs. plan, margin by line of business, **realized-only loss rate**, concentration risk (carrier/provider/state), drift, thesis metrics (attorney retention vs. baseline, case velocity, carrier savings). One button: "Board pack."

## Part 9 — Design overhaul + branding

Adopt the Marrick design language with **Trilogy's brand**: the trilogy wordmark (lowercase rounded sans, slate `#3D4A5F`, sky-blue triangle `#45A8E8` as the o) in the top-left of everything, favicon, login page, portals.

- **Palette:** warm paper background (`#F7F6F1`), white cards with warm hairlines, **slate** as our navy-equivalent primary, **triangle blue** as the accent/automation color (their green role), amber/red semantics; navy-tinted soft shadows.
- **Type:** serif display (Fraunces) for headlines and big stat numbers · Inter Tight for UI · **JetBrains Mono for case IDs, CPTs, money, timestamps.** This trio is what makes their sites feel expensive.
- **Components:** stat-card KPI grids, dot-badges, decision cards with stripes and bands, slide-over entity panels, uppercase letter-spaced table headers, "watch it work" step animations, ⌘K command palette.
- Density and polish: sharp editorial spacing, mono data, one accent per screen. Kill our gray-boxy look entirely.

## Part 10 — Carried forward untouched

The tested backend survives: schema, auth/roles/approvals, portals' security boundaries (consent gate, payout privacy, adjuster scoping), CPT rate engine, void/reconciliation, audit log, alerts, state minimums, 148-test suite. This overhaul is a new **brain and face** on a spine that already works. Rollback = the zip + git snapshot.

## Sequencing (proposed)

1. **Design system + shell** — brand, palette, type, sidebar nav, ⌘K, slide-over case panel. Everything instantly looks like the new company.
2. **Today decision deck** (Coordinator + Exec) + overnight receipts + outcomes strip, powered by existing data.
3. **Onboarding wizards** (carrier + provider) with config-that-executes, SLA acceptance + live SLA clock.
4. **Four-check + envelope auto-auth + gap→one-time-agreement engine + typed exception queue.**
5. **Auto-status + health score + consolidated outbound + scheduling board.**
6. **Tiers, scoring, drift, growth workspace, enterprise reports, board pack.**
7. **Deployment-dependent intelligence** (note parsing, check-ins, EOB capture, assistant) — UI built in 1–6, brains at AWS.
