variable "bucket_prefix" {
  description = "Prefix for a provider-generated, globally unique S3 bucket name."
  type        = string
}

variable "retention_days" {
  description = "Number of days before S3 expires objects in the dedicated bucket."
  type        = number

  validation {
    condition     = var.retention_days >= 1 && floor(var.retention_days) == var.retention_days
    error_message = "Retention must be a positive whole number of days."
  }
}
