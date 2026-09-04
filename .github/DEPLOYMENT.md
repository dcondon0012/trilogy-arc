# Arc deployment — setup and operations

How Arc gets from a git push to a running service on AWS, and what to do when
that goes wrong.

Two deploy paths exist during the migration:

| | Today (Lightsail) | After cutover (AWS) |
|---|---|---|
| Trigger | cron pulls `main` every 2 min | GitHub Actions on push to `dev` |
| Runs | `tsx server/index.ts` from a git checkout | ECS Fargate task from an ECR image |
| Database | Postgres on the box | RDS Postgres, Multi-AZ in prod |
| Uploads | local disk | S3 |
| Verify | `GET /api/health` → commit hash | same, checked automatically by the pipeline |

The Lightsail box keeps running untouched until stage 6. Nothing in this
directory affects it.

---

## Initial setup — COMPLETE (09/04/2026)

All four setup steps are done. Recorded here for reference.

### 1. Add the AWS credentials as repo secrets — DONE (09/04/2026)

~~Settings → Secrets and variables → Actions → New repository secret~~

No longer needed. The workflows now use GitHub OIDC to assume
`arn:aws:iam::306077570168:role/github-actions-arc`, so no AWS keys are stored
anywhere. The temporary `terraform-admin` key that bootstrapped this has been
deleted from IAM, and both `AWS_*` repo secrets have been removed.

### 2. Run `setup-infrastructure.yml` — DONE (09/04/2026)

~~Actions → Setup infrastructure (one-time) → Run workflow → type `SETUP`.~~

Completed by Donny on 09/04. Created:
- S3 state bucket: `trilogy-arc-tfstate-306077570168`
- DynamoDB lock table: `trilogy-arc-tflock`
- GitHub OIDC provider
- IAM role: `github-actions-arc` (AdministratorAccess)

The workflow is idempotent, so a re-run is harmless if needed.

### 3. Enable the remote backend — DONE (commit 389d686, 09/04/2026)

~~Uncomment the `backend "s3"` block in `deploy/terraform/main.tf`~~

The backend block is now active with:
- `bucket = "trilogy-arc-tfstate-306077570168"`
- `key = "arc/terraform.tfstate"`
- `region = "us-west-2"`
- `dynamodb_table = "trilogy-arc-tflock"`

`deploy.yml` checks for an active backend block and fails the build without one.
With local state, every run starts from an empty state file, so Terraform cannot
see what it already built — it would create a second VPC, a second RDS instance,
a second everything, and have no record of the first set. That is a genuinely
expensive mistake to unwind, so the pipeline refuses to start rather than risk it.

### 4. Switch to OIDC — COMPLETE (commit b41e191, 09/04/2026)

Both workflows now authenticate as `arn:aws:iam::306077570168:role/github-actions-arc`
via GitHub's OIDC provider. The switch included:

- ✅ Workflows updated to use `aws-actions/configure-aws-credentials@v4` with `role-to-assume`
- ✅ Trust policy updated to accept GitHub's immutable-ID sub claim pattern
- ✅ First keyless deploy verified green (deploy run #7+)
- ✅ `terraform-admin` IAM access key deleted
- ✅ Both `AWS_*` repo secrets removed
- ✅ `claude/17_Arc_Ops_Access.md` updated

**There are no long-lived AWS keys anywhere.** Actions mints a short-lived token
per run (valid ~1 hour), scoped to this repo.

---

## How a deploy runs

Push to `dev`, and `deploy.yml` runs four jobs in order. Any failure stops the
rest — nothing reaches AWS unless the gate passes first.

1. **verify** — `tsc --noEmit` on root and client, then the full api suite
   against a Postgres 16 service container. Fails if the suite reports fewer
   than `EXPECTED_ASSERTIONS` (313 today), so a suite that quietly stops
   testing things is caught. No AWS credentials in this job: the suite has to
   pass without touching S3 or SES.
2. **build** — builds `deploy/Dockerfile` and pushes to ECR tagged with the
   short commit SHA (tags are immutable, so that is the only tag; a re-run
   reuses an already-pushed image). The SHA is baked in as `GIT_COMMIT`.
3. **plan** — `terraform validate` + `plan`, saved as a run artifact. Read this
   before approving anything for prod.
4. **deploy** — `terraform apply`, wait for the ECS service to stabilize, then
   confirm through the ALB that `/api/health` reports this exact commit.

### Why the health check matters

`/api/health` returns `{ok, build, fees}`, where `build` is the commit the
running process came from. The image has no `.git` in it (`.dockerignore`
excludes it), so the build stamps the SHA in at build time and the server
prefers that value.

This is what makes a deploy *verified* rather than merely *started*. A rolling
deploy that half-failed, or a service still running yesterday's task, shows up
as a build hash that does not match — and the job fails. It is also the
access-continuity proof stage 6 needs: a Claude-pushed commit reaching the new
site is exactly this check going green.

### Staging vs prod

Staging is approved and deploys automatically on every push to `dev`.

Prod is not. `main` is deliberately absent from the push triggers, because today
`main` auto-deploys to the live Lightsail site every two minutes — wiring it to a
prod apply would turn a routine review merge into a production spend. A prod
deploy needs all three of:

- a manual `workflow_dispatch` run with `environment: prod`
- `confirm_prod` typed as `APPLY-PROD`
- an approval on the `prod` GitHub Environment

Set that reviewer up before stage 6: Settings → Environments → New environment →
`prod` → Required reviewers.

---

## Operations

**Where the logs are.** CloudWatch → Log groups → `/ecs/arc-staging` (or
`arc-prod`). Streams are prefixed `arc/`. Container Insights is on for the
cluster, so CPU and memory are under ECS → Clusters → Metrics.

**Alarms.** CloudWatch alarms publish to an SNS topic subscribed to
`donny@trilogyconnections.com` (`alert_email` in `variables.tf`). The
subscription needs confirming by email once, at first apply, or alarms go
nowhere.

**Rolling back.** Every image is tagged with its commit, so a rollback is a
manual run of `deploy.yml` from the last good commit. Faster, if the service is
actively broken: point the task definition back at the previous image tag in the
console and let ECS roll forward. Then fix the commit properly — a console
change is invisible to Terraform and gets overwritten by the next apply.

**Database.** RDS Postgres, automated backups (14 days prod, 3 staging),
Multi-AZ in prod only. `DATABASE_URL` lives in Secrets Manager and is injected
into the task; it is never in the image or in a workflow file.

### Verifying a deployed environment

`staging-ops.yml` runs the checks that need AWS itself: CloudWatch (group,
streams, recent events, and a credential scan of the real logs), S3 (public
access block, KMS default encryption, versioning, and a put/get round trip),
the alarm path (subscription confirmed, alarms wired, then one alarm pushed
into ALARM for real so the topic publishes), and an RDS snapshot/restore
drill that tears its own restore back down.

Run it from Actions → Staging ops once the file reaches `main` at stage 6.
Before then, `workflow_dispatch` is invisible, so a session triggers it by
writing `.github/ops-request.json` and pushing to the `ops-run` branch:

```json
{ "tasks": "logs,sns,s3,rds-drill" }
```

Findings come back two ways, because a sandboxed session cannot read Actions
logs or artifacts (`results-receiver.actions.githubusercontent.com` and
`*.blob.core.windows.net` are both off the egress allowlist): each check is
its own step that exits on its own verdict, and the detail is pushed as
markdown to the `ops-results` branch (`results/latest.md`).

### Secure cookies need TLS, and fail silently without it

`SECURE_COOKIES` is set from `certificate_arn` — `"1"` when a certificate is
configured, `"0"` when there is none. That is not a preference. `cookie-session`
will not emit a `secure` cookie on a request it considers plaintext, and with
`trust proxy` on it believes `X-Forwarded-Proto`, which a cert-less listener
sets to `http`. It does not raise: `POST /api/auth/login` answers **200 with a
valid body and no `Set-Cookie` header**, so every following request is a 401 and
nothing appears in the logs. Staging ran that way from its first deploy —
`/api/health` needs no session, so the pipeline's hash check stayed green over
the top of an app nobody could log into.

If you put a certificate on staging, this flips to `"1"` on the next apply and
needs no code change.

### Running the api suite against a deployed environment

`scripts/api-test.ts` is pure HTTP — it takes `BASE` and imports no database —
so pointing it at an ALB needs no secret and no database reachability. It still
cannot serve as a gate on a deployed environment, for two independent reasons:

- **Production mode flags the demo passwords.** With `NODE_ENV=production`,
  `flagSeedPasswords()` sets `mustChangePw` on any seed account still on its
  default, and `requireAuth` then 403s every path outside `/api/auth/*`. The
  suite authenticates as exactly such an account, so it gets through login and
  MFA and then fails on the first real endpoint.
- **Its opening assertions encode a virgin database.** "First login → MFA
  enrollment" holds once per database; the secret persists by design, so a
  second run against the same environment cannot pass it.

The suite is therefore a pre-deploy gate — CI runs it against a fresh Postgres
on every push, which is the right place for it. Verifying the deployed stack is
`staging-ops.yml`'s job.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Login 200s but every later call is 401, nothing logged | `SECURE_COOKIES=1` with no TLS at the ALB — no `Set-Cookie` is sent | see the secure-cookie note above; the env var tracks `certificate_arn` |
| Build fails on "no active S3 backend" | step 3 not done | uncomment the backend block in `main.tf` |
| `terraform init` fails on the bucket | setup workflow not run, or wrong region | re-run setup, check `AWS_REGION` matches |
| Suite fails only in CI | Postgres service container not ready | check the uploaded `server-log` artifact |
| `services-stable` times out | tasks crash-looping | CloudWatch logs; usually a bad `DATABASE_URL` or a missing secret |
| ALB health check never matches | rollout failed, or the image predates `GIT_COMMIT` | check the ECS deployment events, then rebuild |
| Tasks start then die immediately | secret ARN unreadable by the exec role | confirm `read-app-secrets` covers both secrets |
| 503 from the ALB | no healthy targets yet | normal for ~60s after a deploy; longer means the container fails its own health check |

---

## Stage 5 checklist

- [x] Workflows written and typecheck/suite verified locally (df9ef62, reviewed 0c1f3a3)
- [x] AWS credentials added as repo secrets (Donny, 09/04 — now removed after OIDC)
- [x] `setup-infrastructure.yml` run once (Donny, 09/04 — account 306077570168)
- [x] Backend block uncommented and pushed (389d686)
- [x] OIDC migration done, `terraform-admin` key deleted (b41e191)
- [x] First staging deploy green end to end (1aa41f0, run #6)
- [ ] Staging ALB health check + CloudWatch logs inspected (health check yes, logs no)
- [ ] S3 upload/download live test against the staging bucket
- [ ] Full test suite against the staging ALB (needs staging DATABASE_URL secret)
- [ ] RDS backup/restore drill
- [x] prod path built but not applied (stage 6 gate)

## Running cost

Rough monthly, us-west-2, before tax:

| | Staging | Prod |
|---|---|---|
| Fargate | ~$9 (1 × 0.25 vCPU) | ~$36 (2 × 0.5 vCPU) |
| ALB | ~$17 | ~$17 |
| RDS | ~$13 (t4g.micro, single-AZ) | ~$50 (t4g.small, Multi-AZ) |
| NAT gateway | ~$35 (one, shared) | ~$35 (one, shared) |
| S3 + Secrets + CloudWatch + WAF | ~$5 | ~$25 |
| **Total** | **~$75–105** | **~$250–400** |

Staging can be torn down between test cycles (`terraform destroy` in the staging
workspace) if it is not being used — the state bucket and ECR images survive, so
bringing it back is one workflow run.
