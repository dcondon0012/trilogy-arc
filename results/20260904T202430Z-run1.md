# Staging ops — run 1

- commit: `77dd4aef42fab877a13c92cf457a6469ce48c29b`
- checks requested: `logs,sns,s3,suite`
- started: 2026-09-04 20:23:46Z
- ALB: `arc-staging-1968196898.us-west-2.elb.amazonaws.com`
- uploads bucket: `arc-staging-uploads-20260904165527449600000003`
- db endpoint: `arc-staging-pg.c9y4424g8g7r.us-west-2.rds.amazonaws.com:5432`

## CloudWatch — `/ecs/arc-staging`

- log group exists (retention: `90` — `None` means never expire)
- 6 recent stream(s): `arc/arc/224a91f45c18479abed30f8d5cd73990	arc/arc/aac7412fa59646ad9bd591201df80511	arc/arc/cc0d39314b414043b461ca166d5a2ddc	arc/arc/939ed399aa094de78b9
None`
- 25 event(s) in the last 2h (after 12 health probes)
- boot line seen: `Trilogy Platform API on http://localhost:4000 (build 5827692)`

### Credential scan (hard fail)
- clean — no credential pattern appears

### PHI-shaped strings (reported, not failed)
- none seen in this window

<details><summary>last 40 log lines</summary>

```
2026-09-04T19:09:36 Trilogy Platform API on http://localhost:4000 (build 5827692)
2026-09-04T19:15:54 npm error path /app
2026-09-04T19:15:54 npm error command failed
2026-09-04T19:15:54 npm error signal SIGTERM
2026-09-04T19:15:54 npm error command sh -c tsx server/index.ts
2026-09-04T19:15:54 npm error A complete log of this run can be found in: /root/.npm/_logs/2026-09-04T17_42_24_790Z-debug-0.log
2026-09-04T19:21:39 Trilogy Platform API on http://localhost:4000 (build b41e191)
2026-09-04T19:28:08 npm error path /app
2026-09-04T19:28:08 npm error command failed
2026-09-04T19:28:08 npm error signal SIGTERM
2026-09-04T19:28:08 npm error command sh -c tsx server/index.ts
2026-09-04T19:28:08 npm error A complete log of this run can be found in: /root/.npm/_logs/2026-09-04T19_09_27_022Z-debug-0.log
2026-09-04T19:44:57 Trilogy Platform API on http://localhost:4000 (build 843c9c9)
2026-09-04T19:51:30 npm error path /app
2026-09-04T19:51:30 npm error command failed
2026-09-04T19:51:30 npm error signal SIGTERM
2026-09-04T19:51:30 npm error command sh -c tsx server/index.ts
2026-09-04T19:51:30 npm error A complete log of this run can be found in: /root/.npm/_logs/2026-09-04T19_21_30_485Z-debug-0.log
2026-09-04T20:15:43 Trilogy Platform API on http://localhost:4000 (build 99e3c84)
2026-09-04T20:21:24 Trilogy Platform API on http://localhost:4000 (build 4096660)
2026-09-04T20:21:46 npm error path /app
2026-09-04T20:21:46 npm error command failed
2026-09-04T20:21:46 npm error signal SIGTERM
2026-09-04T20:21:46 npm error command sh -c tsx server/index.ts
2026-09-04T20:21:46 npm error A complete log of this run can be found in: /root/.npm/_logs/2026-09-04T19_44_47_931Z-debug-0.log
```
</details>

## S3 — `arc-staging-uploads-20260904165527449600000003`

- public access block: `True	True	True	True`
- default encryption: `aws:kms`
- versioning: `Enabled`
- direct put/get round trip: byte-identical
- probe object stored with: `aws:kms`
- probe object and its version deleted
- app objects under `uploads/` before the suite: **None**

## Full api suite against the ALB

- serving build: `4096660`
- exit code `1` · passed **7** · failed **0** (floor 313)

<details><summary>last 25 lines of suite output</summary>

```
ok: unauthenticated request rejected
ok: wrong password rejected
ok: first login → MFA enrollment
ok: bad TOTP code rejected
ok: valid TOTP code → session
ok: second login → verify (secret stored)
ok: re-auth works
TypeError: Cannot read properties of undefined (reading 'length')
    at main (/home/runner/work/trilogy-arc/trilogy-arc/scripts/api-test.ts:51:26)
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
```
</details>

- finished: 2026-09-04 20:24:30Z
