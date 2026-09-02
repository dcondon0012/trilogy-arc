output "alb_dns" {
  value       = aws_lb.app.dns_name
  description = "Point the domain's CNAME/ALIAS here at cutover"
}
output "ecr_repo" {
  value = aws_ecr_repository.arc.repository_url
}
output "db_endpoint" {
  value = aws_db_instance.pg.endpoint
}
output "uploads_bucket" {
  value = aws_s3_bucket.uploads.bucket
}
