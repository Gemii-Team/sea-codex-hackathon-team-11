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
