terraform {
  required_version = ">= 1.10, < 2.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

variable "region" {
  type    = string
  default = "ap-southeast-1"
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

provider "aws" {
  region = var.region
}

resource "aws_vpc" "sandbox" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name        = "orchestrator-sandbox"
    ManagedBy   = "OpenTofu"
    Environment = "sandbox"
  }
}

output "vpc_id" {
  value = aws_vpc.sandbox.id
}
