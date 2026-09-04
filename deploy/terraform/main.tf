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
  # Remote state — bucket and lock table created by setup-infrastructure.yml
  # (run 09/04/2026, account 306077570168). Workspaces keep staging and prod
  # state separate under the same key. deploy.yml refuses to run if this block
  # is ever commented out again: with local state every CI run starts blank and
  # Terraform would rebuild everything as duplicates it can't track.
  backend "s3" {
    bucket         = "trilogy-arc-tfstate-306077570168"
    key            = "arc/terraform.tfstate"
    region         = "us-west-2"
    dynamodb_table = "trilogy-arc-tflock"
    encrypt        = true
  }
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
