# The team's instance is a read-only dependency. This state owns only the PoC flow.

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

data "aws_connect_instance" "team" {
  instance_id = "de120632-5aca-4f3e-96fa-5d201b7f3708"

  lifecycle {
    postcondition {
      condition     = self.instance_alias == "sea-team11-phone-demo" && self.status == "ACTIVE" && self.inbound_calls_enabled
      error_message = "Expected the existing, active, inbound-enabled sea-team11-phone-demo instance."
    }
  }

  depends_on = [data.aws_caller_identity.connect]
}

# An ordinary inbound flow. The provider cannot set or read a flow's publication status, so
# bin/verify-flow must confirm PUBLISHED after the first apply.
resource "aws_connect_contact_flow" "greeting" {
  instance_id = data.aws_connect_instance.team.instance_id
  name        = local.flow_name
  description = "Plays the Team Eleven greeting, then disconnects."
  type        = "CONTACT_FLOW"
  content     = local.flow_content

  tags = {
    Name = local.flow_name
  }
}
