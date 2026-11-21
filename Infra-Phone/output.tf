output "connect_instance_id" {
  description = "Amazon Connect instance ID for configuring the Thai bot, flow, and widget."
  value       = module.connect.instance_id
}

output "connect_instance_arn" {
  description = "Amazon Connect instance ARN."
  value       = module.connect.instance_arn
}

output "interaction_log_bucket_name" {
  description = "Private S3 bucket configured for Connect interaction logs."
  value       = module.interaction_logs.bucket_name
}

output "conversation_bucket_name" {
  description = "Private S3 bucket reserved for processed conversation JSON."
  value       = module.conversations.bucket_name
}

output "conversation_key_prefix" {
  description = "S3 prefix for one versioned JSON record per contact ID."
  value       = "v1/conversations/"
}
