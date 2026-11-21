# Yai Mali (ยายมะลิ) dev app

Open **https://sea-hackathon-dev.voidbox.io** and play the scammer. **The app is public: there is no login and no password.** Yai Mali, a 72-year-old retired teacher from Suphanburi, answers in Thai by **text chat** (`POST /api/chat`) or by **voice** (OpenAI Realtime over WebRTC, `POST /api/voice/calls`). She keeps you talking and writes down, one item at a time, the account number, holder name, bank, PromptPay, phone, LINE ID and link you give her. It is a simulation: never type real passwords, OTPs or personal data.

`backend/` is a dependency-free Node server (a copy of `connect-web-call`, plus chat and the shared Yai persona). It serves `frontend/` and holds the only OpenAI key; the browser never sees it and cannot choose the model or the persona. `deploy/` runs it as an independent sidecar of the main app on the existing EC2 host: own ECR repository `sea-hackathon/yai-mali-dev`, own Compose project `sea-yai-mali-dev`, own directory `/opt/yai-mali-dev`, own secret, no published port. It reuses the main stack's private Docker network, so cloudflared reaches it as `http://yai-mali-dev:8080`. The main app and the Connect PoC are never touched.

## Run locally

Put these in a mode-0600 env file outside Git (`HOST=127.0.0.1` keeps it off the network):

```
HOST=127.0.0.1
PORT=8080
PUBLIC_ORIGIN=http://127.0.0.1:8080
VOICE_CUTOFF_AT=2026-11-21T16:59:00Z
VOICE_STATE_DIR=/tmp/yai-voice
OPENAI_API_KEY=<key>
```

```sh
mkdir -p /tmp/yai-voice
node --env-file="$HOME/.config/yai-mali/dev.env" yai-mali-web/backend/server.mjs
node --test yai-mali-web/backend/*.test.mjs        # offline: fake upstream, no billable call
```

## Deploy

Run from the repository root. Every command goes through `connect-web-call/bin/with-aws hosting`, which passes only the hosting AWS and Cloudflare credentials; `deploy` re-runs itself under it. Never run `infra/hosting/bin/deploy` or `connect-web-call/deploy/deploy` for this app.

1. **Secret (once).** Create one SecureString in the hosting account: `/sea-hackathon/yai-mali-dev/OPENAI_API_KEY`, with the value of `OPENAI_API_KEY_MOO`. There is no password parameter. Seed it privately (`--cli-input-json file://…` from a 0600 file, never as an argument). The host reads it itself; it never travels in the SSM command, a build argument or a log.
2. **Registry.** From `infra/hosting`: `../../connect-web-call/bin/with-aws hosting bin/tf plan -out=dev-registry.tfplan`. Then `yai-mali-web/deploy/deploy plan-guard registry infra/hosting/dev-registry.tfplan` must print `plan-guard OK`; apply that plan and delete the file.
3. **Image and origin.** `yai-mali-web/deploy/deploy up` builds `linux/arm64` from `yai-mali-web/`, pushes to the dev repository, starts it by digest and probes both origins on the Docker bridge. It prints `previous_image=`.
4. **Check.** `yai-mali-web/deploy/deploy check` repeats the probe (read-only; it needs no secret and cannot spend: the public page and `/healthz` answer, and the two POST routes are called only with a foreign Origin, which must give 403, or with an invalid body, which must give 400). Run it right before the route: the origin must be live before DNS.
5. **Route.** From `infra/hosting`: `../../connect-web-call/bin/with-aws hosting bin/tf plan -var dev_route_enabled=true -out=dev-route.tfplan`. Then `yai-mali-web/deploy/deploy plan-guard route infra/hosting/dev-route.tfplan`; it accepts only the new proxied CNAME, the tunnel config gaining one rule before the 404 (main and PoC rules unchanged) and, if still pending, the registry creates. Apply that plan and delete the file.

## Roll back

- **Unpublish.** Plan again without `dev_route_enabled` (remove it from `terraform.tfvars` if set there), check with `deploy plan-guard route-off <plan>`, apply. The registry and the running container stay.
- **Previous image.** `yai-mali-web/deploy/deploy up --image <previous_image>`.
- **Stop.** On the host, stop only this project: `docker compose -p sea-yai-mali-dev stop` in `/opt/yai-mali-dev`. Do not touch `sea-hackathon` (main) or `sea-connect-web-call`.

## Spend guards

Anyone with the URL can use the app, so the OpenAI key is protected only by these limits. The server enforces all of them; none depends on the browser.

- Chat: 30 requests per rolling minute for everyone combined, at most 30 messages per request, small request bodies.
- Voice: one call at a time, at most 3 minutes each, 25 call attempts in total. The server reserves an attempt on disk before contacting OpenAI; the counter survives a restart under `/opt/yai-mali-dev/state`. Do not reset it to troubleshoot.
- Voice cutoff **23:59 Bangkok on 21 Nov** (`VOICE_CUTOFF_AT=2026-11-21T16:59:00Z`): no new call from 23:55, known calls end by 23:57. There is no systemd timer for this app; after the cutoff the app only refuses calls, and the container stays up until it is stopped by hand.
- Every POST must come from the page's own origin (`Origin` equals `https://sea-hackathon-dev.voidbox.io`); anything else gets 403 before any body is read.
- Emergency stop: unpublish the route or stop the container (see Roll back), and rotate `OPENAI_API_KEY` in OpenAI if the key itself is in doubt.

## Privacy

Each browser keeps its own notebook (what Yai wrote down) locally. The server stores no chat or voice transcript; the notebook leaves the browser only as a file you download.
