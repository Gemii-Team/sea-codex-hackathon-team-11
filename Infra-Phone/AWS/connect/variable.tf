variable "instance_alias" {
  description = "Alias for the Amazon Connect instance."
  type        = string
}

variable "recording_bucket" {
  description = "S3 bucket for the CALL_RECORDINGS association, which also stores interaction logs."
  type        = string
}

variable "recording_key_prefix" {
  description = "Bucket prefix configured on the CALL_RECORDINGS association."
  type        = string
}
