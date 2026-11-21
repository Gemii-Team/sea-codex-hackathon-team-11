# Offline: both providers are mocked, nothing calls AWS or Cloudflare.
# Run: tofu -chdir=infra test

mock_provider "aws" {
  mock_data "aws_ssm_parameter" {
    defaults = { insecure_value = "ami-0123456789abcdef0" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_eip" {
    defaults = { public_ip = "203.0.113.10" }
  }
}

mock_provider "cloudflare" {
  mock_data "cloudflare_zone" {
    defaults = { id = "zone0000", account = { id = "acct0000", name = "test" } }
  }
  mock_resource "cloudflare_zero_trust_tunnel_cloudflared" {
    defaults = { id = "11111111-2222-3333-4444-555555555555" }
  }
}

variables {
  budget_email = "alerts@example.com"
}

run "tunnel_mode_has_no_inbound_path" {
  command = apply

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.web) == 0
    error_message = "tunnel mode must not open any inbound port"
  }
  assert {
    condition     = length(aws_eip.app) == 0
    error_message = "tunnel mode must not allocate an Elastic IP"
  }
  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared.app[0].config_src == "cloudflare"
    error_message = "tunnel must be remotely managed"
  }
  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared.app[0].tunnel_secret == null
    error_message = "tunnel_secret must stay unset so no secret reaches state"
  }
  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress[0].hostname == "sea-hackathon.voidbox.io"
    error_message = "ingress rule must route the app hostname"
  }
  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress[0].service == "http://app:8080"
    error_message = "ingress rule must target the compose service app on app_port"
  }
  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress[1].service == "http_status:404"
    error_message = "ingress must end with a catch-all 404"
  }
  assert {
    condition = (
      cloudflare_dns_record.app.name == "sea-hackathon.voidbox.io" &&
      cloudflare_dns_record.app.type == "CNAME" &&
      cloudflare_dns_record.app.proxied == true &&
      cloudflare_dns_record.app.content == "11111111-2222-3333-4444-555555555555.cfargotunnel.com"
    )
    error_message = "DNS must be a proxied CNAME to the tunnel"
  }
}

run "server_and_budget_guards" {
  command = plan

  assert {
    condition     = aws_instance.app.metadata_options[0].http_tokens == "required" && aws_instance.app.metadata_options[0].http_put_response_hop_limit == 1
    error_message = "IMDSv2 must be required with hop limit 1"
  }
  assert {
    condition = (
      aws_instance.app.root_block_device[0].encrypted == true &&
      aws_instance.app.root_block_device[0].volume_type == "gp3" &&
      aws_instance.app.root_block_device[0].volume_size == 20
    )
    error_message = "root volume must be encrypted gp3, 20 GiB"
  }
  assert {
    condition     = aws_instance.app.credit_specification[0].cpu_credits == "standard"
    error_message = "CPU credits must be standard so bursts are not billed"
  }
  assert {
    condition     = aws_instance.app.instance_type == "t4g.small" && aws_instance.app.associate_public_ip_address == true
    error_message = "t4g.small with a public IPv4 for egress (there is no NAT gateway)"
  }
  assert {
    condition     = aws_budgets_budget.monthly.cost_types[0].include_credit == false
    error_message = "budget must ignore credits, or alerts never fire on the free plan"
  }
  assert {
    condition     = length(aws_budgets_budget.monthly.notification) == 3
    error_message = "expected alerts at 50% actual, 100% actual, 100% forecast"
  }
}

run "public_mode_opens_80_443_and_points_a_record_at_eip" {
  command = apply

  variables {
    ingress_mode = "public"
  }

  assert {
    condition     = toset([for r in aws_vpc_security_group_ingress_rule.web : r.from_port]) == toset([80, 443])
    error_message = "public mode must open exactly 80 and 443"
  }
  assert {
    condition     = length(aws_eip.app) == 1
    error_message = "public mode needs one Elastic IP"
  }
  assert {
    condition     = length(cloudflare_zero_trust_tunnel_cloudflared.app) == 0 && length(cloudflare_zero_trust_tunnel_cloudflared_config.app) == 0
    error_message = "public mode must not keep a tunnel"
  }
  assert {
    condition = (
      cloudflare_dns_record.app.type == "A" &&
      cloudflare_dns_record.app.proxied == false &&
      cloudflare_dns_record.app.content == "203.0.113.10"
    )
    error_message = "DNS must be a DNS-only A record to the Elastic IP"
  }
}

run "rejects_unknown_ingress_mode" {
  command = plan

  variables {
    ingress_mode = "nat"
  }

  expect_failures = [var.ingress_mode]
}

run "rejects_multi_label_hostname" {
  command = plan

  variables {
    hostname = "app.sea"
  }

  expect_failures = [var.hostname]
}
