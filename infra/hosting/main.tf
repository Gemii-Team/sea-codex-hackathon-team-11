locals {
  tunnel = var.ingress_mode == "tunnel"
  public = var.ingress_mode == "public"
  fqdn   = "${var.hostname}.${var.zone_name}"

  # Connect web-call PoC beside the app. The service name and port must match
  # connect-web-call/deploy/compose.yml; the PoC's PUBLIC_ORIGIN is fixed to its hostname.
  poc_service = "connect-web-call"
  poc_port    = 8080
  poc_fqdn    = "${var.poc_hostname}.${var.zone_name}"
  poc_origin  = "http://${local.poc_service}:${local.poc_port}"
  poc_hosts   = var.poc_route_enabled ? [local.poc_fqdn] : []
}

data "aws_caller_identity" "current" {}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnet" "app" {
  vpc_id            = data.aws_vpc.default.id
  availability_zone = var.availability_zone
  default_for_az    = true
}

data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

# --- Network -----------------------------------------------------------------

resource "aws_security_group" "app" {
  name        = "${var.project}-app"
  description = "${var.project} app server (ingress depends on ingress_mode)"
  vpc_id      = data.aws_vpc.default.id
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.app.id
  description       = "ECR, SSM, Cloudflare (443/7844), package mirrors"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "web" {
  for_each = local.public ? toset(["80", "443"]) : toset([])

  security_group_id = aws_security_group.app.id
  description       = "public mode: Caddy"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.key)
  to_port           = tonumber(each.key)
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_eip" "app" {
  count = local.public ? 1 : 0

  domain   = "vpc"
  instance = aws_instance.app.id
  tags     = { Name = var.project }
}

# --- Server ------------------------------------------------------------------

resource "aws_instance" "app" {
  ami                         = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type               = var.instance_type
  subnet_id                   = data.aws_subnet.app.id
  vpc_security_group_ids      = [aws_security_group.app.id]
  iam_instance_profile        = aws_iam_instance_profile.app.name
  associate_public_ip_address = true # needed for outbound traffic; there is no NAT gateway

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    compose_version = var.compose_version
    compose_sha256  = var.compose_sha256
    region          = var.aws_region
  })

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1 # containers cannot reach the instance role's credentials
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gb
    encrypted             = true
    delete_on_termination = true
  }

  # t4g defaults to "unlimited", which bills CPU bursts beyond the baseline.
  credit_specification {
    cpu_credits = "standard"
  }

  tags = { Name = var.project }

  lifecycle {
    # ami: a new AMI release must not replace the server.
    # user_data: cloud-init runs it only on first boot, so a change would only stop/start the
    # server. It takes effect on a rebuild: bin/tf apply -replace=aws_instance.app
    ignore_changes = [ami, user_data]
  }
}

# --- Instance role -----------------------------------------------------------

data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "${var.project}-instance"
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "ecr_read" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

data "aws_iam_policy_document" "params" {
  statement {
    actions = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
    resources = [
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project}/*",
    ]
  }

  statement {
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "params" {
  name   = "read-${var.project}-parameters"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.params.json
}

resource "aws_iam_instance_profile" "app" {
  name = "${var.project}-instance"
  role = aws_iam_role.app.name
}

# --- Images ------------------------------------------------------------------

resource "aws_ecr_repository" "app" {
  name                 = "${var.project}/app"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep the last 10 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 10 }
      action       = { type = "expire" }
    }]
  })
}

# The PoC's own immutable repository, independent of the app repository and of the route switch.
# Not force_delete: a plan that drops it while it still holds images fails instead of deleting them.
resource "aws_ecr_repository" "poc" {
  count = var.poc_registry_enabled ? 1 : 0

  name                 = "${var.project}/${local.poc_service}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "poc" {
  count = var.poc_registry_enabled ? 1 : 0

  repository = aws_ecr_repository.poc[0].name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep the last 10 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 10 }
      action       = { type = "expire" }
    }]
  })
}

# --- Budget ------------------------------------------------------------------

resource "aws_budgets_budget" "monthly" {
  name         = "${var.project}-monthly"
  budget_type  = "COST"
  limit_amount = format("%.2f", var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Credits would net the cost to zero and silence every alert.
  cost_types {
    include_credit = false
    include_refund = false
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_email]
  }
}

# --- Cloudflare --------------------------------------------------------------

data "cloudflare_zone" "this" {
  filter = { name = var.zone_name }
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "app" {
  count = local.tunnel ? 1 : 0

  account_id = data.cloudflare_zone.this.account.id
  name       = var.project
  config_src = "cloudflare" # provider default is "local"; tunnel_secret stays unset
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "app" {
  count = local.tunnel ? 1 : 0

  account_id = data.cloudflare_zone.this.account.id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.app[0].id

  # The PoC rule, when enabled, goes immediately before the final catch-all 404; the original
  # hostname rule and the catch-all are never reordered or replaced.
  config = {
    ingress = concat(
      [{ hostname = local.fqdn, service = "http://app:${var.app_port}" }],
      [for host in local.poc_hosts : { hostname = host, service = local.poc_origin }],
      [{ service = "http_status:404" }],
    )
  }
}

# One record whose type follows ingress_mode, so a CNAME and an A never coexist for the name.
resource "cloudflare_dns_record" "app" {
  zone_id = data.cloudflare_zone.this.id
  name    = local.fqdn
  type    = local.tunnel ? "CNAME" : "A"
  content = local.tunnel ? "${cloudflare_zero_trust_tunnel_cloudflared.app[0].id}.cfargotunnel.com" : aws_eip.app[0].public_ip
  proxied = local.tunnel
  ttl     = local.tunnel ? 1 : 300
  comment = "${var.project} (opentofu, ingress_mode=${var.ingress_mode})"
}

# The PoC hostname rides the existing tunnel: one more proxied CNAME to it. It is created only
# after the ingress rule exists (depends_on), and only with the registry enabled and the tunnel as
# the ingress, so a route can never point at a PoC that has nowhere to run.
resource "cloudflare_dns_record" "poc" {
  count = var.poc_route_enabled ? 1 : 0

  zone_id = data.cloudflare_zone.this.id
  name    = local.poc_fqdn
  type    = "CNAME"
  content = "${try(cloudflare_zero_trust_tunnel_cloudflared.app[0].id, "no-tunnel")}.cfargotunnel.com"
  proxied = true
  ttl     = 1
  comment = "${var.project} ${local.poc_service} (opentofu)"

  depends_on = [cloudflare_zero_trust_tunnel_cloudflared_config.app]

  lifecycle {
    precondition {
      condition     = var.poc_registry_enabled
      error_message = "poc_route_enabled requires poc_registry_enabled = true: create the PoC repository, then push and verify the origin before publishing the hostname."
    }
    precondition {
      condition     = local.tunnel
      error_message = "poc_route_enabled requires ingress_mode = \"tunnel\": the PoC hostname is only published through the Cloudflare Tunnel."
    }
    precondition {
      condition     = local.poc_fqdn != local.fqdn
      error_message = "poc_hostname must differ from hostname: the PoC must not take over the main site's name."
    }
  }
}
