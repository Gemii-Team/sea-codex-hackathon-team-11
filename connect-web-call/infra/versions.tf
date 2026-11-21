terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.73"
    }
  }
}

# Hard pins. These are constants, not variables: aiming this stack at another account, profile or Region
# must be a reviewed edit. The backend pins its own account in backend.tf (blocks there cannot use locals).
locals {
  aws_region         = "ap-southeast-1"
  connect_profile    = "poc-connect"
  connect_account_id = "086971655102"
}

# Only the named Connect profile is used. The wrapper creates it in an ephemeral shared-credentials file and
# clears every other credential source. A missing profile aborts instead of falling back to the default
# profile, and skip_metadata_api_check = true keeps EC2 instance-profile credentials out of the chain.
# allowed_account_ids makes the provider fail if the profile resolves to any account but the Connect one.
provider "aws" {
  region                  = local.aws_region
  profile                 = local.connect_profile
  allowed_account_ids     = [local.connect_account_id]
  skip_metadata_api_check = true

  default_tags {
    tags = {
      Project   = "sea-hackathon-connect-web-call"
      ManagedBy = "opentofu"
    }
  }
}
