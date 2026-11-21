# Provisions only the Connect destination for the browser-call proof: one inbound-only CONNECT_MANAGED
# instance and one published inbound flow (greeting, then disconnect). No phone numbers, no outbound
# calling, no recording or transcript storage, no S3, no IAM, no users. The widget, its signing key and the
# first admin login are created by an operator outside OpenTofu and never enter this state (see README.md).

locals {
  flow_name    = "team-eleven-web-call-greeting"
  flow_content = file("${path.module}/flows/web-call.json")
}

# Fails the plan if the Connect profile resolves to any account other than the pinned Connect account
# (allowed_account_ids in the provider is the first guard, this keeps the check visible to offline tests).
data "aws_caller_identity" "connect" {
  lifecycle {
    postcondition {
      condition     = self.account_id == local.connect_account_id
      error_message = "The AWS provider authenticated as account ${self.account_id}, not the Connect account ${local.connect_account_id}. Run through the credential wrapper so only the poc-connect profile is used."
    }
  }
}

# Inbound on, outbound off. Every instance attribute the provider writes is explicit so nothing relies on a
# provider default: no outbound or early media, no Contact Lens analytics, no flow logs, no conferencing.
# Do not recreate this instance to work around a failed create: Connect limits instance creates and
# deletes. Read the error, fix its cause, and apply again.
resource "aws_connect_instance" "this" {
  identity_management_type       = "CONNECT_MANAGED"
  instance_alias                 = var.instance_alias
  inbound_calls_enabled          = true
  outbound_calls_enabled         = false
  early_media_enabled            = false
  contact_lens_enabled           = false
  contact_flow_logs_enabled      = false
  multi_party_conference_enabled = false

  tags = {
    Name = var.instance_alias
  }

  depends_on = [data.aws_caller_identity.connect]
}

# An ordinary inbound flow. The provider cannot set or read a flow's publication status, so
# bin/verify-flow must confirm PUBLISHED after the first apply.
resource "aws_connect_contact_flow" "greeting" {
  instance_id = aws_connect_instance.this.id
  name        = local.flow_name
  description = "Plays the Team Eleven greeting, then disconnects."
  type        = "CONTACT_FLOW"
  content     = local.flow_content

  tags = {
    Name = local.flow_name
  }
}
