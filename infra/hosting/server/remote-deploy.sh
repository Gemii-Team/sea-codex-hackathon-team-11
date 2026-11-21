#!/bin/bash
# Runs on the server as root, sent by bin/deploy through SSM.
# Usage: remote-deploy.sh <image> <tunnel|public> <app_port> <fqdn> <region> <project>
# Secrets are fetched here with the instance role and written to files; they are never printed.
set -euo pipefail

image=$1 mode=$2 app_port=$3 fqdn=$4 region=$5 project=$6
api_image=${7:-} monitor_image=${8:-}

cloud-init status --wait >/dev/null || {
  echo "first-boot setup failed; see /var/log/cloud-init-output.log" >&2
  exit 1
}

cd /opt/app
umask 077

printf 'IMAGE=%s\nAPP_PORT=%s\nFQDN=%s\nCOMPOSE_PROFILES=%s\n' "$image" "$app_port" "$fqdn" "$mode" > .env
if [ -n "$api_image" ]; then
  printf 'COMPOSE_FILE=compose.yml:stack.yml\nAPI_IMAGE=%s\nMONITOR_IMAGE=%s\n' "$api_image" "$monitor_image" >> .env
fi
export COMPOSE_PROFILES=$mode

: > tunnel.env
if [ "$mode" = tunnel ]; then
  token=$(aws ssm get-parameter --region "$region" --name "/$project/tunnel-token" \
    --with-decryption --query Parameter.Value --output text)
  printf 'TUNNEL_TOKEN=%s\n' "$token" > tunnel.env
  unset token
fi

# Each parameter under /<project>/app/ becomes an env var for the app (single-line values).
aws ssm get-parameters-by-path --region "$region" --path "/$project/app/" --recursive \
  --with-decryption --query 'Parameters[].[Name,Value]' --output text |
  awk -F'\t' 'NF >= 2 { n = $1; sub(/.*\//, "", n); print n "=" $2 }' > app.env
echo "app env vars: $(cut -d= -f1 app.env | paste -sd, -)"

aws ecr get-login-password --region "$region" |
  docker login --username AWS --password-stdin "${image%%/*}" >/dev/null 2>&1

# Stop the other ingress mode's proxy; --remove-orphans does not touch services in other profiles.
if [ "$mode" = tunnel ]; then
  COMPOSE_PROFILES=public docker compose rm --stop --force caddy >/dev/null 2>&1 || true
else
  COMPOSE_PROFILES=tunnel docker compose rm --stop --force cloudflared >/dev/null 2>&1 || true
fi

docker compose pull --quiet
docker compose up -d --remove-orphans --wait --wait-timeout 180
docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
