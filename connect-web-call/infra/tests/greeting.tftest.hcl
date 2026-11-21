# Offline: the AWS provider is mocked, so nothing calls AWS and no credentials are read.
# Run: tofu -chdir=connect-web-call/infra init -backend=false -input=false
#      tofu -chdir=connect-web-call/infra test

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "086971655102" }
  }
  mock_data "aws_connect_instance" {
    defaults = {
      instance_alias        = "sea-team11-phone-demo"
      status                = "ACTIVE"
      inbound_calls_enabled = true
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

run "hosting_account_credentials_are_rejected" {
  command = plan

  providers = {
    aws = aws.hosting_account
  }

  expect_failures = [data.aws_caller_identity.connect]
}

run "inactive_instance_is_rejected" {
  command = plan

  override_data {
    target = data.aws_connect_instance.team
    values = { instance_alias = "sea-team11-phone-demo", status = "FAILED", inbound_calls_enabled = true }
  }

  expect_failures = [data.aws_connect_instance.team]
}

run "flow_is_the_greeting_then_disconnect" {
  command = apply

  assert {
    condition = (
      aws_connect_contact_flow.greeting.type == "CONTACT_FLOW" &&
      aws_connect_contact_flow.greeting.instance_id == "de120632-5aca-4f3e-96fa-5d201b7f3708"
    )
    error_message = "the greeting must be a separate inbound flow on the team's existing instance"
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
      output.instance_id == "de120632-5aca-4f3e-96fa-5d201b7f3708" &&
      output.admin_url == "https://sea-team11-phone-demo.my.connect.aws/" &&
      output.flow_id == "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
    )
    error_message = "outputs must be the instance ID, its admin URL and the bare flow ID"
  }
}
