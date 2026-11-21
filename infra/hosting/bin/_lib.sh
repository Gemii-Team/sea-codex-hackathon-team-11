# Sourced by bin/* scripts. Loads .env without printing it and reads tofu outputs.
# shellcheck shell=bash

# root: the OpenTofu root (infra/hosting). .env lives at the repository root (gitignored).
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${ENV_FILE:-$(cd "$root/../.." && pwd)/.env}"

die() {
  echo "error: $*" >&2
  exit 1
}

[ -f "$env_file" ] || die ".env not found at $env_file (set ENV_FILE to use another path or /dev/null for exported credentials)"
set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

# Accept the misspelled name already in .env; the Cloudflare provider reads CLOUDFLARE_API_TOKEN.
export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-${CLOUNDFLARE_API_TOKEN:-}}"
unset CLOUNDFLARE_API_TOKEN
# Region comes from tofu (var.aws_region); every aws call below passes --region explicitly.
unset AWS_DEFAULT_REGION AWS_REGION

tmp="$(mktemp -d)"
chmod 700 "$tmp"
trap 'rm -rf "$tmp"' EXIT

# out <name>: one tofu output as a raw string ("" when null).
out() {
  if [ -n "${HOSTING_OUTPUTS_FILE:-}" ]; then
    jq -er --arg k "$1" '.[$k] | select(type == "string" or type == "number")' "$HOSTING_OUTPUTS_FILE"
    return
  fi
  [ -f "$tmp/outputs.json" ] || tofu -chdir="$root" output -json > "$tmp/outputs.json"
  jq -r --arg k "$1" '.[$k].value // ""' "$tmp/outputs.json"
}

# fetch_tunnel_token <file>: writes the tunnel run token to <file> (mode 600). Not printed, not in argv.
fetch_tunnel_token() {
  local account tunnel_id
  account="$(out cloudflare_account_id)"
  tunnel_id="$(out tunnel_id)"
  [ -n "$tunnel_id" ] || die "no tunnel in tofu outputs (ingress_mode is not \"tunnel\", or apply has not run)"
  [ -n "$CLOUDFLARE_API_TOKEN" ] || die "CLOUDFLARE_API_TOKEN is not set in .env"
  printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN" > "$tmp/auth"
  curl -fsS -H @"$tmp/auth" \
    "https://api.cloudflare.com/client/v4/accounts/$account/cfd_tunnel/$tunnel_id/token" |
    jq -je '.result' > "$1"
  chmod 600 "$1"
}
