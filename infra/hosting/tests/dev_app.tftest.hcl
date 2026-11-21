# Offline: both providers are mocked, nothing calls AWS or Cloudflare.
# The Yai Mali dev app is a second sidecar beside the PoC, with its own switches:
#   dev_registry_enabled  its own immutable ECR repository (default on)
#   dev_route_enabled     one tunnel ingress rule plus one proxied CNAME (tunnel mode only, default off)
# The main and PoC rules must never change; any route that has no repository, no tunnel or a
# colliding hostname behind it must fail the plan, not degrade quietly.
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

run "registry_alone_creates_only_an_immutable_repo" {
  command = apply

  assert {
    condition = (
      length(aws_ecr_repository.dev) == 1 &&
      aws_ecr_repository.dev[0].name == "sea-hackathon/yai-mali-dev" &&
      aws_ecr_repository.dev[0].image_tag_mutability == "IMMUTABLE" &&
      aws_ecr_repository.dev[0].image_scanning_configuration[0].scan_on_push == true &&
      aws_ecr_repository.dev[0].force_delete == false
    )
    error_message = "the dev repository must be its own immutable, scanned repository that cannot be force-deleted"
  }
  assert {
    condition = (
      jsondecode(aws_ecr_lifecycle_policy.dev[0].policy).rules[0].selection.countNumber == 10 &&
      jsondecode(aws_ecr_lifecycle_policy.dev[0].policy).rules[0].action.type == "expire"
    )
    error_message = "the dev repository needs a lifecycle policy that keeps the last 10 images"
  }
  assert {
    condition = (
      aws_ecr_repository.dev[0].name != aws_ecr_repository.app.name &&
      aws_ecr_repository.dev[0].name != aws_ecr_repository.poc[0].name
    )
    error_message = "the dev app must not share the app or PoC repository"
  }
  assert {
    condition     = length(cloudflare_dns_record.dev) == 0
    error_message = "the registry switch must not create the dev hostname"
  }
  assert {
    condition = (
      length(cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress) == 2 &&
      cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress[0].hostname == "sea-hackathon.voidbox.io" &&
      cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress[0].service == "http://app:8080" &&
      cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress[1].service == "http_status:404"
    )
    error_message = "the registry switch must leave the tunnel config as the original hostname rule plus the catch-all 404"
  }
  assert {
    condition     = output.dev_repository_url != null && output.dev_fqdn == null
    error_message = "dev_repository_url must be set and dev_fqdn null while only the registry is on"
  }
  assert {
    condition     = aws_ecr_repository.app.name == "sea-hackathon/app" && aws_ecr_repository.poc[0].name == "sea-hackathon/connect-web-call"
    error_message = "the app and PoC repositories must be unchanged"
  }
}

run "registry_can_be_explicitly_disabled_before_teardown" {
  command = apply

  variables {
    dev_registry_enabled = false
  }

  assert {
    condition     = length(aws_ecr_repository.dev) == 0 && length(aws_ecr_lifecycle_policy.dev) == 0
    error_message = "the dev repository must not exist unless dev_registry_enabled"
  }
  assert {
    condition     = output.dev_repository_url == null && output.dev_fqdn == null
    error_message = "the dev outputs must be null while the registry and route are off"
  }
}

run "registry_in_public_mode_adds_no_hostname" {
  command = apply

  variables {
    ingress_mode = "public"
  }

  assert {
    condition     = length(aws_ecr_repository.dev) == 1
    error_message = "the registry switch is independent of the ingress mode"
  }
  assert {
    condition = (
      length(cloudflare_dns_record.dev) == 0 &&
      length(cloudflare_zero_trust_tunnel_cloudflared.app) == 0 &&
      length(cloudflare_zero_trust_tunnel_cloudflared_config.app) == 0
    )
    error_message = "public mode must not gain a tunnel, an ingress rule or an extra hostname"
  }
}

run "route_inserts_one_rule_after_the_poc_rule_and_before_the_404" {
  command = apply

  variables {
    poc_route_enabled = true
    dev_route_enabled = true
  }

  assert {
    condition     = length(cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress) == 4
    error_message = "with both routes on the tunnel config must be main, PoC, dev and the 404"
  }
  assert {
    condition = (
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
    error_message = "the PoC rule must stay second and unchanged"
  }
  assert {
    condition = (
      cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress[2].hostname == "sea-hackathon-dev.voidbox.io" &&
      cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress[2].service == "http://yai-mali-dev:8080"
    )
    error_message = "the dev rule must route its hostname to the yai-mali-dev service on 8080, after the PoC rule"
  }
  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress[3].service == "http_status:404"
    error_message = "the catch-all 404 must stay last"
  }
  assert {
    condition = (
      cloudflare_dns_record.dev[0].name == "sea-hackathon-dev.voidbox.io" &&
      cloudflare_dns_record.dev[0].type == "CNAME" &&
      cloudflare_dns_record.dev[0].proxied == true &&
      cloudflare_dns_record.dev[0].content == "11111111-2222-3333-4444-555555555555.cfargotunnel.com"
    )
    error_message = "the dev DNS must be a proxied CNAME to the existing tunnel"
  }
  assert {
    condition = (
      cloudflare_dns_record.app.type == "CNAME" &&
      cloudflare_dns_record.app.proxied == true &&
      cloudflare_dns_record.app.content == cloudflare_dns_record.dev[0].content &&
      cloudflare_dns_record.poc[0].content == cloudflare_dns_record.dev[0].content
    )
    error_message = "the main and PoC hostnames must keep their proxied CNAMEs to the same tunnel"
  }
  assert {
    condition     = length(cloudflare_zero_trust_tunnel_cloudflared.app) == 1 && length(aws_vpc_security_group_ingress_rule.web) == 0 && length(aws_eip.app) == 0
    error_message = "the route must reuse the one tunnel and open no inbound port"
  }
  assert {
    condition     = output.dev_fqdn == "sea-hackathon-dev.voidbox.io" && output.dev_repository_url != null
    error_message = "dev_fqdn must name the published hostname once the route is on"
  }
}

run "route_alone_leaves_the_poc_off" {
  command = apply

  variables {
    dev_route_enabled = true
  }

  assert {
    condition = (
      length(cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress) == 3 &&
      cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress[0].hostname == "sea-hackathon.voidbox.io" &&
      cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress[1].hostname == "sea-hackathon-dev.voidbox.io" &&
      cloudflare_zero_trust_tunnel_cloudflared_config.app[0].config.ingress[2].service == "http_status:404"
    )
    error_message = "with the PoC route off the tunnel config must be main, dev and the 404"
  }
  assert {
    condition     = length(cloudflare_dns_record.poc) == 0
    error_message = "the dev route must not publish the PoC hostname"
  }
}

run "route_without_registry_fails_closed" {
  command = plan

  variables {
    dev_registry_enabled = false
    dev_route_enabled    = true
  }

  expect_failures = [cloudflare_dns_record.dev]
}

run "route_in_public_mode_fails_closed" {
  command = plan

  variables {
    ingress_mode      = "public"
    dev_route_enabled = true
  }

  expect_failures = [cloudflare_dns_record.dev]
}

run "route_cannot_take_over_the_main_hostname" {
  command = plan

  variables {
    dev_route_enabled = true
    dev_hostname      = "sea-hackathon"
  }

  expect_failures = [cloudflare_dns_record.dev]
}

run "route_cannot_take_over_the_poc_hostname" {
  command = plan

  variables {
    dev_route_enabled = true
    dev_hostname      = "call-sea-hackathon"
  }

  expect_failures = [cloudflare_dns_record.dev]
}

run "rejects_multi_label_dev_hostname" {
  command = plan

  variables {
    dev_hostname = "dev.sea"
  }

  expect_failures = [var.dev_hostname]
}
