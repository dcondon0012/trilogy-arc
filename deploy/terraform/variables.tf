variable "region" {
  type    = string
  default = "us-west-2"
}

variable "domain" {
  description = "Public hostname for this environment (prod: trilogyconnections.com)"
  type        = string
  default     = ""
}

variable "certificate_arn" {
  description = "ACM certificate ARN for the ALB HTTPS listener (issued in-region)"
  type        = string
  default     = ""
}

variable "image" {
  description = "Full ECR image URI (with tag) for the Arc container"
  type        = string
  default     = ""
}

variable "alert_email" {
  description = "Where CloudWatch alarms send (SNS subscription)"
  type        = string
  default     = "donny@trilogyconnections.com"
}
