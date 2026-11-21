variable "aws_region" {
  description = "AWS Region for Web Calling and conversation storage."
  type        = string
  default     = "ap-southeast-1"
}

variable "name_prefix" {
  description = "Connect instance alias and shared part of the bucket names."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$", var.name_prefix))
    error_message = "Use 3 to 24 lowercase letters, digits, or hyphens, with a letter or digit at each end."
  }
}

variable "environment" {
  description = "Environment tag for this stack."
  type        = string
  default     = "demo"
}

variable "owner" {
  description = "Team responsible for these resources."
  type        = string
  default     = "team-11"
}

variable "interaction_log_retention_days" {
  description = "Days to retain source interaction logs in S3."
  type        = number
  default     = 7
}

variable "conversation_retention_days" {
  description = "Days to retain processed conversation JSON in S3."
  type        = number
  default     = 30
}
