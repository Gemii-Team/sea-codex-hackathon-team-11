# Hosting: one EC2 server behind a Cloudflare Tunnel

One EC2 instance (`t4g.small`, Amazon Linux 2023, Docker + compose) in `ap-southeast-1`, published at
`https://sea-hackathon.voidbox.io` through a Cloudflare Tunnel. The server has no inbound ports and no
SSH; deploys and shell access go through AWS Systems Manager.

Run every command below from `infra/hosting/`. Credentials come from `.env` at the repository root
(gitignored): `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `CLOUDFLARE_API_TOKEN` (the misspelled
`CLOUNDFLARE_API_TOKEN` also works; `ENV_FILE=/path/.env` overrides the location). The Cloudflare token
needs *Account → Cloudflare Tunnel → Edit* and *Zone → DNS → Edit* on `voidbox.io`.

| Path | What it is |
|---|---|
| `*.tf` | OpenTofu: server, IAM role, ECR, budget, tunnel, DNS record. State in S3. |
| `tests/` | Offline tests with mocked providers: `tofu test` |
| `server/` | Compose stack and the script the server runs on each deploy |
| `bin/` | `tf`, `bootstrap-state`, `tunnel-token-to-ssm`, `check-state-secrets`, `deploy` |
| `placeholder/` | Stand-in app that proves the path works |

## First-time setup

```sh
bin/bootstrap-state                 # S3 state bucket (idempotent)
bin/tf init
cp terraform.tfvars.example terraform.tfvars   # set budget_email
bin/tf plan -out=hosting.tfplan     # review the plan
bin/tf apply hosting.tfplan && rm hosting.tfplan
bin/tunnel-token-to-ssm             # tunnel token -> SSM SecureString, never printed
bin/check-state-secrets             # must print PASS
bin/deploy placeholder              # expect: https://sea-hackathon.voidbox.io/ -> HTTP 200
```

## Deploy an app

`bin/deploy <dir>` builds `<dir>/Dockerfile` for `linux/arm64`, pushes a new immutable tag to ECR, and
restarts the stack on the server. The server runs that image as one container, `app`, serving HTTP on
port 8080 (also passed in as `PORT`).

An app made of several containers (for example an API, a worker and a frontend) needs more services
in `server/compose.yml`; the tunnel then routes to whichever service serves the site.

App secrets and settings live in SSM. Each parameter under `/sea-hackathon/app/` becomes an env var
(single-line values). Redeploy after changing them. Keep values out of shell history, e.g.:

```sh
read -rs VALUE && aws ssm put-parameter --region ap-southeast-1 --type SecureString --overwrite \
  --name /sea-hackathon/app/OPENAI_API_KEY --value "$VALUE"; unset VALUE
```

## Operate

- Shell on the server (needs the Session Manager plugin on the Mac):
  `aws ssm start-session --region ap-southeast-1 --target "$(bin/tf output -raw instance_id)"`
- Logs, from that shell: `cd /opt/app && sudo docker compose logs -f`
- First-boot log: `/var/log/cloud-init-output.log`
- Port checks from a Mac running Cloudflare WARP are meaningless: WARP makes 80/443 look open on
  every IP. Probe from outside (for example check-host.net) instead.

## Switch to a public IP (and back)

```sh
# terraform.tfvars: ingress_mode = "public"
bin/tf plan -out=hosting.tfplan && bin/tf apply hosting.tfplan && rm hosting.tfplan
bin/deploy <dir>                    # starts Caddy (ports 80/443, Let's Encrypt) instead of cloudflared
```

Public mode: Elastic IP, ports 80/443 open to the internet, DNS-only `A` record. Switching back to
`tunnel` creates a **new** tunnel, so run `bin/tunnel-token-to-ssm` again before `bin/deploy`.

## Rebuild the server

`user_data` only runs on first boot, so changes to `user-data.sh.tftpl` apply to a new server:

```sh
bin/tf plan -replace=aws_instance.app -out=hosting.tfplan && bin/tf apply hosting.tfplan && rm hosting.tfplan
bin/deploy <dir>
```

## Cost

About $21/month idle: instance $15.5, public IPv4 $3.7, disk $1.9. The budget emails at $15 actual,
$30 actual and $30 forecast, ignoring credits.

## Tear down

```sh
bin/tf plan -destroy -out=hosting.tfplan && bin/tf apply hosting.tfplan && rm hosting.tfplan
aws ssm delete-parameter --region ap-southeast-1 --name /sea-hackathon/tunnel-token
aws ssm get-parameters-by-path --region ap-southeast-1 --path /sea-hackathon/app/ --query 'Parameters[].Name' --output text  # delete each
```

The state bucket `sea-hackathon-tfstate-157264476192` survives on purpose. Delete it last, after
removing every object version, if you want nothing left.
