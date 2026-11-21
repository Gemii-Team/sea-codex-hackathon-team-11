terraform {
  required_version = ">= 1.10, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.73"
    }
  }

  backend "s3" {}
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "sea-codex-hackathon-team-11"
      Environment = var.environment
      Owner       = var.owner
      ManagedBy   = "opentofu"
    }
  }
}

module "interaction_logs" {
  source = "./AWS/s3"

  bucket_prefix  = "web-${var.name_prefix}-logs-"
  retention_days = var.interaction_log_retention_days
}

module "conversations" {
  source = "./AWS/s3"

  bucket_prefix  = "web-${var.name_prefix}-data-"
  retention_days = var.conversation_retention_days
}

module "connect" {
  source = "./AWS/connect"

  instance_alias       = var.name_prefix
  recording_bucket     = module.interaction_logs.bucket_name
  recording_key_prefix = "connect"
}
