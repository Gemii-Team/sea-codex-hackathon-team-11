# Offline: both providers are mocked, nothing calls AWS or Cloudflare.
# The registry is retained by default; the route stays off until explicitly enabled.
#   poc_registry_enabled  its own immutable ECR repository
#   poc_route_enabled     one tunnel ingress rule plus one proxied CNAME (tunnel mode only)
# Any route that has no repository or no tunnel behind it must fail the plan, not degrade quietly.
# Run: tofu -chdir=infra/hosting test

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

  # Hermetic: terraform.tfvars (live settings) must not change what these runs assert.
  poc_registry_enabled = true
  poc_route_enabled    = false
  dev_registry_enabled = true
  dev_route_enabled    = false
}

run "registry_can_be_explicitly_disabled_before_teardown" {
  command = apply

  variables {
    poc_registry_enabled = false
  }

  assert {
    condition     = length(aws_ecr_repository.poc) == 0 && length(aws_ecr_lifecycle_policy.poc) == 0
    error_message = "the PoC repository must not exist unless poc_registry_enabled"
  }
  assert {
    condition     = length(cloudflare_dns_record.poc) == 0
    error_message = "the PoC hostname must not exist unless poc_route_enabled"
  }
  assert {
    condition = (
      length(cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress) == 2 &&
      cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress[0].hostname == "sea-hackathon.voidbox.io" &&
      cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress[0].service == "http://app:8080" &&
      cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress[1].service == "http_status:404"
    )
    error_message = "with the PoC off, the tunnel config must stay exactly the original hostname rule plus the catch-all 404"
  }
  assert {
    condition     = output.poc_repository_url == null
    error_message = "poc_repository_url must be null while the registry is off"
  }
  assert {
    condition     = output.poc_fqdn == "call-sea-hackathon.voidbox.io"
    error_message = "poc_fqdn must be the fixed PoC hostname"
  }
  assert {
    condition     = aws_ecr_repository.app.name == "sea-hackathon/app" && aws_ecr_repository.app.image_tag_mutability == "IMMUTABLE"
    error_message = "the main app repository must be unchanged"
  }
}

run "registry_alone_creates_only_an_immutable_repo" {
  command = apply

  assert {
    condition = (
      aws_ecr_repository.poc[0].name == "sea-hackathon/connect-web-call" &&
      aws_ecr_repository.poc[0].image_tag_mutability == "IMMUTABLE" &&
      aws_ecr_repository.poc[0].image_scanning_configuration[0].scan_on_push == true &&
      aws_ecr_repository.poc[0].force_delete == false
    )
    error_message = "the PoC repository must be its own immutable, scanned repository that cannot be force-deleted"
  }
  assert {
    condition = (
      jsondecode(aws_ecr_lifecycle_policy.poc[0].policy).rules[0].selection.countNumber == 10 &&
      jsondecode(aws_ecr_lifecycle_policy.poc[0].policy).rules[0].action.type == "expire"
    )
    error_message = "the PoC repository needs a lifecycle policy that keeps the last 10 images"
  }
  assert {
    condition     = aws_ecr_repository.poc[0].name != aws_ecr_repository.app.name
    error_message = "the PoC must not share the app repository"
  }
  assert {
    condition     = output.poc_repository_url != null
    error_message = "poc_repository_url must be set while the registry is on"
  }
  assert {
    condition     = length(cloudflare_dns_record.poc) == 0 && length(cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress) == 2
    error_message = "the registry switch must not publish any hostname"
  }
}

run "registry_in_public_mode_adds_no_hostname" {
  command = apply

  variables {
    ingress_mode         = "public"
    poc_registry_enabled = true
  }

  assert {
    condition     = length(aws_ecr_repository.poc) == 1
    error_message = "the registry switch is independent of the ingress mode"
  }
  assert {
    condition = (
      length(cloudflare_dns_record.poc) == 0 &&
      length(cloudflare_zero_trust_tunnel_cloudflared.app) == 0 &&
      length(cloudflare_zero_trust_tunnel_cloudflared_config.app) == 0
    )
    error_message = "public mode must not gain a tunnel, an ingress rule or an extra hostname"
  }
  assert {
    condition     = toset([for r in aws_vpc_security_group_ingress_rule.web : r.from_port]) == toset([80, 443]) && cloudflare_dns_record.app.type == "A"
    error_message = "public mode must keep exactly ports 80/443 and the A record"
  }
}

run "route_with_registry_in_tunnel_mode_inserts_one_rule_before_the_404" {
  command = apply

  variables {
    poc_registry_enabled = true
    poc_route_enabled    = true
  }

  assert {
    condition = (
      length(cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress) == 3 &&
      cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress[0].hostname == "sea-hackathon.voidbox.io" &&
      cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress[0].service == "http://app:8080"
    )
    error_message = "the original hostname rule must stay first and unchanged"
  }
  assert {
    condition = (
      cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress[1].hostname == "call-sea-hackathon.voidbox.io" &&
      cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress[1].service == "http://connect-web-call:8080"
    )
    error_message = "the PoC rule must route its hostname to the connect-web-call service on 8080"
  }
  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress[2].service == "http_status:404"
    error_message = "the catch-all 404 must stay last"
  }
  assert {
    condition = (
      cloudflare_dns_record.poc[0].name == "call-sea-hackathon.voidbox.io" &&
      cloudflare_dns_record.poc[0].type == "CNAME" &&
      cloudflare_dns_record.poc[0].proxied == true &&
      cloudflare_dns_record.poc[0].content == "11111111-2222-3333-4444-555555555555.cfargotunnel.com"
    )
    error_message = "the PoC DNS must be a proxied CNAME to the existing tunnel"
  }
  assert {
    condition = (
      cloudflare_dns_record.app.name == "sea-hackathon.voidbox.io" &&
      cloudflare_dns_record.app.type == "CNAME" &&
      cloudflare_dns_record.app.proxied == true &&
      cloudflare_dns_record.app.content == cloudflare_dns_record.poc[0].content
    )
    error_message = "the original hostname must keep its proxied CNAME to the same tunnel"
  }
  assert {
    condition     = length(cloudflare_zero_trust_tunnel_cloudflared.app) == 1 && length(aws_vpc_security_group_ingress_rule.web) == 0 && length(aws_eip.app) == 0
    error_message = "the route must reuse the one tunnel and open no inbound port"
  }
}

run "route_without_registry_fails_closed" {
  command = plan

  variables {
    poc_registry_enabled = false
    poc_route_enabled    = true
  }

  expect_failures = [cloudflare_dns_record.poc]
}

run "route_in_public_mode_fails_closed" {
  command = plan

  variables {
    ingress_mode         = "public"
    poc_registry_enabled = true
    poc_route_enabled    = true
  }

  expect_failures = [cloudflare_dns_record.poc]
}

run "route_in_public_mode_without_registry_fails_closed" {
  command = plan

  variables {
    ingress_mode         = "public"
    poc_registry_enabled = false
    poc_route_enabled    = true
  }

  expect_failures = [cloudflare_dns_record.poc]
}

run "route_cannot_take_over_the_main_hostname" {
  command = plan

  variables {
    poc_registry_enabled = true
    poc_route_enabled    = true
    poc_hostname         = "sea-hackathon"
  }

  expect_failures = [cloudflare_dns_record.poc]
}

run "rejects_multi_label_poc_hostname" {
  command = plan

  variables {
    poc_hostname = "call.sea"
  }

  expect_failures = [var.poc_hostname]
}
