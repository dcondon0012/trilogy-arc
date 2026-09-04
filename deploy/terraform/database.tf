# RDS PostgreSQL — Multi-AZ in prod, encrypted, automated backups.
resource "aws_db_subnet_group" "db" {
  name       = "${local.name}-db"
  subnet_ids = aws_subnet.private[*].id
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_instance" "pg" {
  identifier              = "${local.name}-pg"
  engine                  = "postgres"
  engine_version          = "16"
  instance_class          = local.db_instance
  allocated_storage       = 20
  max_allocated_storage   = 100 # storage autoscaling headroom
  db_name                 = "trilogy"
  username                = "trilogy"
  password                = random_password.db.result
  multi_az                = local.db_multi_az
  storage_encrypted       = true
  backup_retention_period = local.db_retention
  deletion_protection     = local.is_prod
  skip_final_snapshot     = !local.is_prod
  final_snapshot_identifier = local.is_prod ? "${local.name}-final" : null
  db_subnet_group_name    = aws_db_subnet_group.db.name
  vpc_security_group_ids  = [aws_security_group.db.id]
  apply_immediately       = !local.is_prod
}

# Connection string delivered to the task via Secrets Manager, never plaintext env.
resource "aws_secretsmanager_secret" "db_url" {
  name = "${local.name}/DATABASE_URL"
}
resource "aws_secretsmanager_secret_version" "db_url" {
  secret_id = aws_secretsmanager_secret.db_url.id
  # sslmode=require is NOT optional: RDS Postgres 16 defaults rds.force_ssl=1
  # and rejects plaintext connections, so without it the app crash-loops at
  # boot and the ALB never has a healthy target (found on the first staging
  # deploy, 09/04). pgdb.ts reads sslmode from the URL; encrypted without CA
  # verification until PGSSLROOTCERT ships in the task definition.
  secret_string = "postgres://trilogy:${random_password.db.result}@${aws_db_instance.pg.endpoint}/trilogy?sslmode=require"
}
