terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.73"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.29"
    }
  }
}

# Credentials come from the environment (bin/tf loads .env); nothing secret is declared here.
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "opentofu"
    }
  }
}

provider "cloudflare" {}
