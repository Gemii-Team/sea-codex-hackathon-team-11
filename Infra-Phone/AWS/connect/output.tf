output "instance_id" {
  description = "Amazon Connect instance ID."
  value       = aws_connect_instance.this.id
}

output "instance_arn" {
  description = "Amazon Connect instance ARN."
  value       = aws_connect_instance.this.arn
}
