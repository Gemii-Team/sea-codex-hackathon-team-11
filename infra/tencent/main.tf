terraform {
  required_version = ">= 1.10, < 2.0"
  required_providers {
    tencentcloud = {
      source  = "opentofu/tencentcloud"
      version = "= 1.82.50"
    }
  }
}

variable "region" {
  type    = string
  default = "ap-singapore"
}

variable "vpc_cidr" {
  type    = string
  default = "10.21.0.0/16"
}

provider "tencentcloud" {
  region = var.region
}

resource "tencentcloud_vpc" "sandbox" {
  name       = "orchestrator-sandbox"
  cidr_block = var.vpc_cidr

  tags = {
    ManagedBy   = "OpenTofu"
    Environment = "sandbox"
  }
}

output "vpc_id" {
  value = tencentcloud_vpc.sandbox.id
}
