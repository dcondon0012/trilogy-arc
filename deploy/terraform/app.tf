# ECS Fargate service behind an ALB, WAF in front, image from ECR.
resource "aws_ecr_repository" "arc" {
  name                 = "trilogy-arc"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  # Shared across workspaces — import into the second workspace rather than recreate.
  lifecycle { prevent_destroy = true }
}

resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.name}"
  retention_in_days = 90
}

# Task role: what the APP may do (S3 uploads bucket, SES, Textract).
resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}
resource "aws_iam_role" "exec" {
  name               = "${local.name}-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}
resource "aws_iam_role_policy_attachment" "exec_managed" {
  role       = aws_iam_role.exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
resource "aws_iam_role_policy" "exec_secrets" {
  name = "read-app-secrets"
  role = aws_iam_role.exec.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [aws_secretsmanager_secret.db_url.arn, aws_secretsmanager_secret.session.arn]
    }]
  })
}
resource "aws_iam_role_policy" "task_app" {
  name = "app-services"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.uploads.arn}/*" },
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.uploads.arn },
      { Effect = "Allow", Action = ["ses:SendRawEmail", "ses:SendEmail"], Resource = "*" },
      { Effect = "Allow", Action = ["textract:AnalyzeExpense", "textract:AnalyzeDocument"], Resource = "*" },
    ]
  })
}

resource "random_password" "session" {
  length  = 64
  special = false
}
resource "aws_secretsmanager_secret" "session" {
  name = "${local.name}/SESSION_SECRET"
}
resource "aws_secretsmanager_secret_version" "session" {
  secret_id     = aws_secretsmanager_secret.session.id
  secret_string = random_password.session.result
}

resource "aws_ecs_task_definition" "app" {
  family                   = local.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = local.task_cpu
  memory                   = local.task_mem
  execution_role_arn       = aws_iam_role.exec.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{
    name      = "arc"
    image     = var.image != "" ? var.image : "${aws_ecr_repository.arc.repository_url}:latest"
    essential = true
    portMappings = [{ containerPort = 4000, protocol = "tcp" }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "4000" },
      { name = "SECURE_COOKIES", value = "1" },
      { name = "TRUST_PROXY", value = "1" },
      { name = "S3_UPLOADS_BUCKET", value = aws_s3_bucket.uploads.bucket },
      { name = "AWS_REGION", value = var.region },
    ]
    secrets = [
      { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.db_url.arn },
      { name = "SESSION_SECRET", valueFrom = aws_secretsmanager_secret.session.arn },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "arc"
      }
    }
    healthCheck = {
      command  = ["CMD-SHELL", "curl -fsS http://localhost:4000/api/health || exit 1"]
      interval = 30, timeout = 5, retries = 3, startPeriod = 30
    }
  }])
}

resource "aws_ecs_service" "app" {
  name                              = local.name
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.app.arn
  desired_count                     = local.task_count
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 60
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.app.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "arc"
    container_port   = 4000
  }
  deployment_minimum_healthy_percent = 100 # zero-downtime deploys
  deployment_maximum_percent         = 200
}

resource "aws_lb" "app" {
  name               = local.name
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
}

resource "aws_lb_target_group" "app" {
  name        = local.name
  port        = 4000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"
  health_check {
    path                = "/api/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
  }
}

resource "aws_lb_listener" "https" {
  count             = var.certificate_arn != "" ? 1 : 0
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}
