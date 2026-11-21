output "project" {
  value = var.project
}

output "region" {
  value = var.aws_region
}

output "instance_id" {
  value = aws_instance.app.id
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "ingress_mode" {
  value = var.ingress_mode
}

output "fqdn" {
  value = local.fqdn
}

output "app_port" {
  value = var.app_port
}

output "public_ip" {
  value = local.public ? aws_eip.app[0].public_ip : aws_instance.app.public_ip
}

output "cloudflare_account_id" {
  value = data.cloudflare_zone.this.account.id
}

output "tunnel_id" {
  value = local.tunnel ? cloudflare_zero_trust_tunnel_cloudflared.app[0].id : null
}

output "poc_repository_url" {
  description = "ECR repository of the Connect web-call PoC; null until poc_registry_enabled."
  value       = one(aws_ecr_repository.poc[*].repository_url)
}

output "poc_fqdn" {
  description = "Hostname the PoC is published on once poc_route_enabled is applied (planned name, not proof of DNS)."
  value       = local.poc_fqdn
}

output "dev_repository_url" {
  description = "ECR repository of the Yai Mali dev app; null until dev_registry_enabled."
  value       = one(aws_ecr_repository.dev[*].repository_url)
}

output "dev_fqdn" {
  description = "Hostname the dev app is published on; null until dev_route_enabled (planned name, not proof of DNS)."
  value       = var.dev_route_enabled ? local.dev_fqdn : null
}
