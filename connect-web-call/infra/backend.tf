# State for this stack lives in the existing hosting state bucket under its own key, so it never shares a
# state file with infra/hosting (infra/terraform.tfstate) or the team's Infra-Phone stack. The bucket is
# created and secured by infra/hosting/bin/bootstrap-state; this stack neither creates nor changes it.
# The key separates the stacks but is not an IAM boundary: whoever holds the hosting profile can read and
# write every key in the bucket. Locking uses S3's native lock file (connect-web-call/terraform.tfstate.tflock).
#
# Backend blocks cannot use variables or locals, so the pins are literals. profile and allowed_account_ids
# tie the backend to the hosting account; the AWS provider uses the separate Connect profile (versions.tf).
# Nothing secret is configured here or passed with -backend-config.
terraform {
  backend "s3" {
    bucket                  = "sea-hackathon-tfstate-157264476192"
    key                     = "connect-web-call/terraform.tfstate"
    region                  = "ap-southeast-1"
    encrypt                 = true
    use_lockfile            = true
    profile                 = "poc-hosting"
    allowed_account_ids     = ["157264476192"]
    skip_metadata_api_check = true
  }
}
