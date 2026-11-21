variable "project" {
  description = "Name prefix and Project tag for every resource."
  type        = string
  default     = "sea-hackathon"
}

variable "aws_region" {
  type    = string
  default = "ap-southeast-1"
}

variable "availability_zone" {
  type    = string
  default = "ap-southeast-1a"
}

variable "instance_type" {
  description = "Must be arm64 (Graviton): the AMI and images are arm64."
  type        = string
  default     = "t4g.small"
}

variable "root_volume_gb" {
  type    = number
  default = 20
}

variable "ingress_mode" {
  description = "\"tunnel\": Cloudflare Tunnel, no inbound ports. \"public\": Elastic IP, ports 80/443, Caddy + Let's Encrypt."
  type        = string
  default     = "tunnel"

  validation {
    condition     = contains(["tunnel", "public"], var.ingress_mode)
    error_message = "ingress_mode must be \"tunnel\" or \"public\"."
  }
}

variable "zone_name" {
  type    = string
  default = "voidbox.io"
}

variable "hostname" {
  description = "Single label under zone_name, so Cloudflare's free certificate covers it."
  type        = string
  default     = "sea-hackathon"

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.hostname))
    error_message = "hostname must be one DNS label (no dots)."
  }
}

variable "app_port" {
  description = "Port the app container listens on."
  type        = number
  default     = 8080
}

variable "compose_version" {
  description = "Docker compose plugin release installed at first boot."
  type        = string
  default     = "5.8.0"
}

variable "compose_sha256" {
  description = "SHA-256 of docker-compose-linux-aarch64 for compose_version."
  type        = string
  default     = "1a9c918b2fb49b9c87f0018c64b5abd0d30715155e98dc939779fbaee6c414d3"
}

variable "budget_email" {
  description = "Address that receives AWS Budgets alerts."
  type        = string
}

variable "budget_limit_usd" {
  type    = number
  default = 30
}

# The registry has been provisioned in this hosting stack. Publishing the hostname remains opt-in.

variable "poc_registry_enabled" {
  description = "Retain the shared stack's immutable PoC registry. Disable only for an explicitly reviewed teardown."
  type        = bool
  default     = true
}

variable "poc_route_enabled" {
  description = "Publish poc_hostname through the existing tunnel: one ingress rule before the final 404 plus one proxied CNAME. Needs poc_registry_enabled and ingress_mode = \"tunnel\"; any other combination fails the plan. Deploy and verify the origin first."
  type        = bool
  default     = false
}

variable "poc_hostname" {
  description = "Single label under zone_name for the Connect web-call PoC. Its PUBLIC_ORIGIN is fixed to https://call-sea-hackathon.voidbox.io."
  type        = string
  default     = "call-sea-hackathon"

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.poc_hostname))
    error_message = "poc_hostname must be one DNS label (no dots)."
  }
}
