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
  # Remote state. Uncomment this AFTER .github/workflows/setup-infrastructure.yml
  # has run once — it creates the bucket and lock table and prints these exact
  # values. Fill in <account-id> from its summary.
  #
  # Until it is uncommented, .github/workflows/deploy.yml refuses to run: with
  # local state every CI run starts blank, so Terraform cannot see what it already
  # built and would happily create a second VPC, RDS instance and ALB while losing
  # track of the first set. Workspaces keep staging and prod state separate under
  # the same key.
  #
  # backend "s3" {
  #   bucket         = "trilogy-arc-tfstate-<account-id>"
  #   key            = "arc/terraform.tfstate"
  #   region         = "us-west-2"
  #   dynamodb_table = "trilogy-arc-tflock"
  #   encrypt        = true
  # }
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
