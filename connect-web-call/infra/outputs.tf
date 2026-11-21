# The only outputs. None is a secret; widget keys, snippet fields and passwords never pass through OpenTofu.

output "instance_id" {
  description = "Amazon Connect instance ID. Pass it to ListSecurityProfiles/ListRoutingProfiles, CreateUser and bin/verify-flow."
  value       = aws_connect_instance.this.id
}

output "admin_url" {
  description = "Connect admin site for this instance, where the operator configures Channels > Communication widgets."
  value       = "https://${aws_connect_instance.this.instance_alias}.my.connect.aws/"
}

output "flow_id" {
  description = "ID of the published greeting flow (named team-eleven-web-call-greeting). Select it as the widget's Web calling flow."
  value       = aws_connect_contact_flow.greeting.contact_flow_id
}
