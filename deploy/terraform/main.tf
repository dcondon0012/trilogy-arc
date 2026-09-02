# ─────────────────────────────────────────────────────────────────────────────
# Trilogy Arc — carrier-grade AWS environment (approved by Donny 09/02/2026)
#
# Shape: ECS Fargate (2+ tasks across AZs) behind an ALB with WAF, RDS Postgres
# Multi-AZ, S3 for uploads, CloudWatch alarms. One workspace per environment:
#   terraform workspace new staging   → small dials, single-AZ RDS
#   terraform workspace new prod      → the real thing
#
# NOTHING here is applied automatically. `terraform plan/apply` is run by hand,
# and the first apply happens only after Donny approves the spend (~$300–450/mo
# prod, ~$40–70/mo staging). Until then this directory is documentation-as-code.
# ─────────────────────────────────────────────────────────────────────────────

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # Remote state (S3 + lock table) is configured at `terraform init` time once the
  # account's state bucket exists — see stage 5 in the migration state doc.
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "trilogy-arc", Env = local.env, ManagedBy = "terraform" }
  }
}

locals {
  env     = terraform.workspace == "default" ? "staging" : terraform.workspace
  is_prod = local.env == "prod"
  name    = "arc-${local.env}"

  # The dials: same shape everywhere, size differs.
  task_count    = local.is_prod ? 2 : 1
  task_cpu      = local.is_prod ? 512 : 256   # 0.5 / 0.25 vCPU
  task_mem      = local.is_prod ? 1024 : 512
  db_instance   = local.is_prod ? "db.t4g.small" : "db.t4g.micro"
  db_multi_az   = local.is_prod
  db_retention  = local.is_prod ? 14 : 3
}
