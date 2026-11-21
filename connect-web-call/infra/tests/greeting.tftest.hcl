# Offline: the AWS provider is mocked, so nothing calls AWS and no credentials are read.
# Run: tofu -chdir=connect-web-call/infra init -backend=false -input=false
#      tofu -chdir=connect-web-call/infra test

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "086971655102" }
  }
  mock_resource "aws_connect_instance" {
    defaults = {
      id  = "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f"
      arn = "arn:aws:connect:ap-southeast-1:086971655102:instance/0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f"
    }
  }
  mock_resource "aws_connect_contact_flow" {
    defaults = {
      contact_flow_id = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
    }
  }
}

# The hosting account: what the stack would see if the hosting credentials were substituted.
mock_provider "aws" {
  alias = "hosting_account"
  mock_data "aws_caller_identity" {
    defaults = { account_id = "157264476192" }
  }
}

run "alias_must_be_project_specific" {
  command = plan

  variables {
    instance_alias = "demo"
  }

  expect_failures = [var.instance_alias]
}

run "hosting_account_credentials_are_rejected" {
  command = plan

  providers = {
    aws = aws.hosting_account
  }

  expect_failures = [data.aws_caller_identity.connect]
}

run "instance_is_inbound_only_and_connect_managed" {
  command = apply

  assert {
    condition = (
      aws_connect_instance.this.identity_management_type == "CONNECT_MANAGED" &&
      aws_connect_instance.this.inbound_calls_enabled == true &&
      aws_connect_instance.this.outbound_calls_enabled == false &&
      aws_connect_instance.this.early_media_enabled == false
    )
    error_message = "the instance must be Connect-managed, inbound only, with no outbound calling or early media"
  }
  assert {
    condition = (
      aws_connect_instance.this.contact_lens_enabled == false &&
      aws_connect_instance.this.contact_flow_logs_enabled == false &&
      aws_connect_instance.this.multi_party_conference_enabled == false
    )
    error_message = "analytics, flow logs and conferencing must stay off"
  }
}

run "flow_is_the_greeting_then_disconnect" {
  command = apply

  assert {
    condition = (
      aws_connect_contact_flow.greeting.type == "CONTACT_FLOW" &&
      aws_connect_contact_flow.greeting.instance_id == aws_connect_instance.this.id
    )
    error_message = "the flow must be an ordinary inbound CONTACT_FLOW on the dedicated instance"
  }
  assert {
    condition = (
      length(jsondecode(aws_connect_contact_flow.greeting.content).Actions) == 2 &&
      jsondecode(aws_connect_contact_flow.greeting.content).StartAction ==
      jsondecode(aws_connect_contact_flow.greeting.content).Actions[0].Identifier
    )
    error_message = "the flow must have exactly two actions and start at the greeting"
  }
  assert {
    condition = (
      jsondecode(aws_connect_contact_flow.greeting.content).Actions[0].Type == "MessageParticipant" &&
      jsondecode(aws_connect_contact_flow.greeting.content).Actions[0].Parameters.Text == "Team Eleven. Your browser is connected to Amazon Connect." &&
      toset(keys(jsondecode(aws_connect_contact_flow.greeting.content).Actions[0].Parameters)) == toset(["Text"])
    )
    error_message = "the greeting must be exactly the static phrase, with no prompt, SSML or media source"
  }
  assert {
    condition = (
      jsondecode(aws_connect_contact_flow.greeting.content).Actions[0].Transitions.NextAction ==
      jsondecode(aws_connect_contact_flow.greeting.content).Actions[1].Identifier &&
      length(jsondecode(aws_connect_contact_flow.greeting.content).Actions[0].Transitions.Errors) == 1 &&
      jsondecode(aws_connect_contact_flow.greeting.content).Actions[0].Transitions.Errors[0].NextAction ==
      jsondecode(aws_connect_contact_flow.greeting.content).Actions[1].Identifier
    )
    error_message = "after the greeting, and after a playback error, the flow must go to the disconnect"
  }
  assert {
    condition = (
      jsondecode(aws_connect_contact_flow.greeting.content).Actions[1].Type == "DisconnectParticipant" &&
      length(keys(jsondecode(aws_connect_contact_flow.greeting.content).Actions[1].Transitions)) == 0
    )
    error_message = "the second action must be a terminal disconnect"
  }
}

run "outputs_are_the_ids_the_operator_needs" {
  command = apply

  assert {
    condition = (
      output.instance_id == "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f" &&
      output.admin_url == "https://sea-hackathon-team-11-web-call-5102.my.connect.aws/" &&
      output.flow_id == "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
    )
    error_message = "outputs must be the instance ID, its admin URL and the bare flow ID"
  }
}
