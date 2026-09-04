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

## Initial setup

Do these in order. Steps 1–3 happen once, ever.

### 1. Add the AWS credentials as repo secrets

Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `AWS_ACCESS_KEY_ID` | the `terraform-admin` key id |
| `AWS_SECRET_ACCESS_KEY` | the `terraform-admin` secret |

Both values are in the Claude project doc `claude/17_Arc_Ops_Access.md`. They are
not written down here — this file is in the repo, and the repo is the thing we are
trying not to leak credentials into.

These are temporary by design. Step 4 replaces them with a role, and then the key
gets deleted.

### 2. Run `setup-infrastructure.yml`

Actions → Setup infrastructure (one-time) → Run workflow → type `SETUP`.

It creates the Terraform state bucket, the DynamoDB lock table, the GitHub OIDC
provider, and the `github-actions-arc` IAM role. It prints exactly what to paste
into step 3. It is idempotent, so a re-run is harmless.

### 3. Enable the remote backend

Uncomment the `backend "s3"` block in `deploy/terraform/main.tf` and fill in the
bucket and table names the setup workflow printed. Commit and push to `dev`.

**This is not optional.** `deploy.yml` checks for an active backend block and
fails the build without one. With local state, every run starts from an empty
state file, so Terraform cannot see what it already built — it would create a
second VPC, a second RDS instance, a second everything, and have no record of
the first set. That is a genuinely expensive mistake to unwind, so the pipeline
refuses to start rather than risk it.

### 4. Switch to OIDC

In both workflow files, replace:

```yaml
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
```

with the role the setup workflow printed:

```yaml
          role-to-assume: arn:aws:iam::<account>:role/github-actions-arc
```

Push, confirm a run still works, then:

- delete the `terraform-admin` access key (IAM → Users → terraform-admin → Security credentials)
- delete both repo secrets
- update `claude/17_Arc_Ops_Access.md` to say the key is gone

After this there are no long-lived AWS keys anywhere. Actions mints a short-lived
token per run.

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

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Build fails on "no active S3 backend" | step 3 not done | uncomment the backend block in `main.tf` |
| `terraform init` fails on the bucket | setup workflow not run, or wrong region | re-run setup, check `AWS_REGION` matches |
| Suite fails only in CI | Postgres service container not ready | check the uploaded `server-log` artifact |
| `services-stable` times out | tasks crash-looping | CloudWatch logs; usually a bad `DATABASE_URL` or a missing secret |
| ALB health check never matches | rollout failed, or the image predates `GIT_COMMIT` | check the ECS deployment events, then rebuild |
| Tasks start then die immediately | secret ARN unreadable by the exec role | confirm `read-app-secrets` covers both secrets |
| 503 from the ALB | no healthy targets yet | normal for ~60s after a deploy; longer means the container fails its own health check |

---

## Stage 5 checklist

- [x] Workflows written and typecheck/suite verified locally
- [ ] AWS credentials added as repo secrets
- [ ] `setup-infrastructure.yml` run once
- [ ] Backend block uncommented and pushed
- [ ] OIDC migration done, `terraform-admin` key deleted
- [ ] First staging deploy green end to end
- [ ] Staging ALB health check + CloudWatch logs inspected
- [ ] S3 upload/download live test against the staging bucket
- [ ] Full suite against the staging ALB (needs staging RDS)
- [ ] RDS backup/restore drill
- [ ] prod path built but not applied (stage 6 gate)

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
