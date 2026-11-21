#!/bin/bash
# Runs on the server as root, started by connect-web-call/deploy/deploy through SSM with compose.yml
# and probe.mjs next to it. Do not run it by hand.
#   remote-deploy.sh up <image@sha256:digest> <project> <region>
#   remote-deploy.sh check <project> <region>
# SSM carries release files, never secret values. Only the private PoC directory and project change.
set -euo pipefail
umask 077
unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_ENV_FILES DOCKER_HOST

die() {
  echo "error: $*" >&2
  exit 1
}

readonly NETWORK=sea-hackathon_default MAIN=sea-hackathon PROJECT_NAME=sea-connect-web-call
readonly SERVICE=connect-web-call DIR=/opt/connect-web-call
readonly PARAMS="OPENAI_API_KEY DEMO_PASSWORD"
src=$(cd "$(dirname "$0")" && pwd)

mode=${1:-}
case "$mode" in
  up) [ "$#" -eq 4 ] || die "usage: up <image> <project> <region>"; image=$2 project=$3 region=$4 ;;
  check) [ "$#" -eq 3 ] || die "usage: check <project> <region>"; image="" project=$2 region=$3 ;;
  *) die "usage: up|check ..." ;;
esac
[[ "$project$region" =~ ^[a-z0-9-]+$ ]] || die "invalid project or region"
[ "$mode" = check ] || [[ "$image" =~ ^[0-9]{12}\.dkr\.ecr\.${region}\.amazonaws\.com/${project}/${SERVICE}@sha256:[0-9a-f]{64}$ ]] ||
  die "image must be a digest reference in ${project}/${SERVICE}, not the app repository"

cloud-init status --wait > /dev/null || die "first-boot setup failed; see /var/log/cloud-init-output.log"
docker network inspect "$NETWORK" > /dev/null 2>&1 || die "Docker network $NETWORK is missing: the main stack must be running"

# container <compose project> <service>: prints the one container id, or dies.
container() {
  local ids
  ids=$(docker ps --all --quiet --filter "label=com.docker.compose.project=$1" --filter "label=com.docker.compose.service=$2")
  [ "$(wc -w <<< "$ids")" -eq 1 ] || die "expected exactly one $2 container in project $1"
  printf '%s' "$ids"
}

get_param() { # <NAME>: the decrypted value; never print it
  aws ssm get-parameter --region "$region" --name "/$project/connect-web-call/$1" --with-decryption \
    --query Parameter.Value --output text
}

main_id=$(container "$MAIN" app)
[ "$(docker inspect --format '{{.State.Running}}' "$main_id")" = true ] || die "the main app container is not running"

deploy() {
  local prev prev_image=none name value
  install -d -m 0700 "$DIR" "$DIR/.docker"
  exec 9>"$DIR/deploy.lock"
  flock -n 9 || die "another PoC deploy is in progress"
  systemctl is-active --quiet team11-call-expiry-20261121.timer || die "demo expiry timer is not armed"
  [ "$(date +%s)" -lt "$(date -u -d '2026-11-21 16:55:00 UTC' +%s)" ] || die "demo admission window has closed"
  install -d -o 65532 -g 65532 -m 0700 "$DIR/state"
  trap 'rm -f "$DIR/poc.env.new"' EXIT
  export DOCKER_CONFIG="$DIR/.docker" # this ECR login must not replace the main app's

  # No other container may own the name connect-web-call on the shared network.
  value=$(docker ps --all --filter "label=com.docker.compose.service=$SERVICE" --format '{{.Label "com.docker.compose.project"}}')
  [ -z "$(grep -vx "$PROJECT_NAME" <<< "$value" || true)" ] || die "another compose project already has a $SERVICE service"
  [ -z "$(docker ps --all --quiet --filter "name=^/$SERVICE\$")" ] || die "a container is already named $SERVICE"

  prev=$(docker ps --all --quiet --filter "label=com.docker.compose.project=$PROJECT_NAME" --filter "label=com.docker.compose.service=$SERVICE")
  [ -z "$prev" ] || prev_image=$(docker inspect --format '{{.Config.Image}}' "$prev")
  echo "previous_image=$prev_image" # roll back with: deploy up --image <previous_image>

  : > "$DIR/poc.env.new"
  for name in $PARAMS; do
    value=$(get_param "$name") || die "cannot read SSM parameter /$project/connect-web-call/$name"
    case "$value" in "" | None | *$'\n'* | *$'\r'*) die "SSM parameter $name is empty or not a single line" ;; esac
    printf '%s=%s\n' "$name" "$value" >> "$DIR/poc.env.new"
  done
  mv -f "$DIR/poc.env.new" "$DIR/poc.env"

  printf 'IMAGE=%s\n' "$image" > "$DIR/.env" # the only interpolated value, and not secret
  install -m 0600 "$src/compose.yml" "$DIR/compose.yml"
  aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "${image%%/*}" > /dev/null 2>&1 ||
    die "ECR login failed"
  cd "$DIR"
  docker compose -p "$PROJECT_NAME" pull --quiet
  # Stop the endpoint before running the recovery-only hangup command against its durable state.
  local unit=team11-call-expiry-20261121.service
  install -d -m0755 "/etc/systemd/system/$unit.d"
  install -m0644 "$src/voice-expiry.conf" "/etc/systemd/system/$unit.d/voice-expiry.conf"
  systemctl daemon-reload
  systemctl is-active --quiet team11-call-expiry-20261121.timer || die "expiry timer is no longer active"
  docker compose -p "$PROJECT_NAME" up -d --wait --wait-timeout 120 || die "the PoC container did not become healthy"
}

# The authenticated origin check: a throwaway container of the PoC image on the shared network
# probes app:8080 and connect-web-call:8080 by name, as cloudflared will. The password is read from
# SSM here and handed over through the environment only.
verify() {
  local poc pw out="" ok=""
  poc=$(container "$PROJECT_NAME" "$SERVICE")
  [ "$(docker inspect --format '{{.State.Health.Status}}' "$poc")" = healthy ] || die "the PoC container is not healthy"
  pw=$(get_param DEMO_PASSWORD)
  for _ in 1 2 3; do
    if out=$(DEMO_PASSWORD=$pw docker run --rm -i --network "$NETWORK" --read-only --cap-drop ALL \
      --security-opt no-new-privileges --pids-limit 64 --memory 128m -e DEMO_PASSWORD --entrypoint node \
      "$(docker inspect --format '{{.Image}}' "$poc")" --input-type=module - < "$src/probe.mjs" 2>&1); then
      ok=1
      break
    fi
    sleep 3
  done
  printf '%s\n' "$out"
  [ -n "$ok" ] || die "origin check failed"
  [ "$(container "$MAIN" app)" = "$main_id" ] || die "the main app container changed during the run"
  echo "origins verified on $NETWORK; main app container $main_id unchanged; PoC image: $(docker inspect --format '{{.Config.Image}}' "$poc")"
}

if [ "$mode" = up ]; then deploy; fi
verify
