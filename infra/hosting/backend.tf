# State lives in S3 (created by bin/bootstrap-state, outside tofu so `tofu destroy` cannot delete it).
# Locking uses S3's native lock file; no DynamoDB table. Backend blocks cannot use variables:
# bin/bootstrap-state reads bucket and region from this file.
terraform {
  backend "s3" {
    bucket       = "sea-hackathon-tfstate-157264476192"
    key          = "infra/terraform.tfstate"
    region       = "ap-southeast-1"
    encrypt      = true
    use_lockfile = true
  }
}
