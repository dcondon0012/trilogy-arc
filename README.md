# Trilogy Platform — Production Codebase

Real client-server application: TypeScript API (Express + SQLite), React front end, real authentication with authenticator-app MFA, role-based permissions, file uploads, and a full audit log. The same codebase deploys to a HIPAA-eligible cloud host with PostgreSQL when you're ready for the team.

## One-time setup (Mac, ~5 minutes)

1. Install Node.js: go to <https://nodejs.org> and download the LTS installer, or run `brew install node` if you use Homebrew. (Node 20 or newer.)
2. Put the `trilogy-app` folder wherever you want it (e.g. Documents).
3. Open Terminal, then:

```bash
cd path/to/trilogy-app
npm install
npm start
```

4. Open <http://localhost:4000> in your browser.

`npm start` builds the interface and runs everything as one server. Day to day, that's the only command you need.

## Signing in

| Role | Email | Password |
|---|---|---|
| Admin | donny@trilogymed.com | admin123 |
| Coordinator | nicole@trilogymed.com | coord123 |

**Change these passwords before real use** (ask me to add a password-change screen, or update them in the database).

First sign-in shows a QR code — scan it with Google Authenticator, 1Password, or any authenticator app, then enter the 6-digit code. That's real TOTP MFA; every login after that asks for the current code from your app.

Admin sees internal financials, insurance business stats, the audit log, and AI request approvals. Coordinators don't — the server enforces it, not just the interface.

## Where your data lives

Everything is stored in the `data/` folder next to the app: `trilogy.db` (the database) and `data/uploads/` (attached bills, visit notes, documents). **Back up that folder** — copy it anywhere, or use the in-app export (avatar menu → Export data backup).

To move data in from the old single-file version: export a JSON backup from it, then run
`npm run import-backup -- path/to/trilogy-backup-2026-07-14.json`

## What's real vs. stubbed

Real: login + TOTP MFA, roles, every workflow (notes with auto-logged system events in MST, tasks, underwriting auto-math, bill/note file uploads with payment gating, the authorization status flow, contract send tracking, auto-computed insurance and branch stats, widget color/size preferences per user), audit log of every action, search, JSON export/import.

Stubbed until deployment: actual e-sign/email/SMS delivery (sends are logged and tracked, nothing leaves the machine), ACH payments (the Pay button records the payment), Google Maps pins (live map embed works; pins need an API key), and multi-user sync (everyone must use this one machine until it's hosted).

## Developer notes

- `npm run dev` — hot-reload development mode (API on :4000, UI on :5173)
- `npm run seed` — seed demo data into an empty database
- `npx tsx scripts/api-test.ts` — integration test suite (server must be running)
- `TRILOGY_SEED=empty npm start` — first boot with no demo data
- Structure: `server/` (Express API, SQLite via better-sqlite3), `client/` (React + Vite), `scripts/`
- Postgres migration path: the schema in `server/db.ts` is standard SQL; swapping better-sqlite3 for `pg` + connection string is the deployment step, along with S3 for `data/uploads/` and a BAA-covered host.

## Before real patient data (PHI)

This build is for workflow testing and internal dry-runs. Before entering real PHI: deploy to a HIPAA-eligible host with a signed BAA, enable HTTPS, get an independent security review, and change all default passwords. The audit log, access controls, and MFA required by the HIPAA Security Rule are already built in.
