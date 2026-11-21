# Web Calling PoC

One question: can a teammate call Amazon Connect from a browser and hear an answer? This app uses the AWS-hosted communications widget and a short flow that says **“Team Eleven. Your browser is connected to Amazon Connect.”** and disconnects. It does not call telephone numbers, record audio, or run the Thai bot. `frontend/` is the page and AWS callback; `backend/` is the Node HTTP server that authenticates the tester and signs the callback response. Agent Studio and the team's `Infra-Phone/` stack are independent.

## Make the first call

**After rollout:** open `https://call-sea-hackathon.voidbox.io` in a supported browser. Sign in as `team` with the **demo password**, not an AWS login. Open the AWS widget, start the audio call, and allow microphone access. Use headphones or speakers; let the flow finish playing and disconnect. The widget owns call status and hang-up; the page doesn't claim a connection just because the server issued a token.

Record UTC start/end and whether you heard the exact greeting. In the **PoC instance**, an authorized operator uses Contact Search for channel `VOICE`, initiation `WEBRTC_API`, and that narrow time window. Match the contact ID and disconnect timestamp (run the proof with no concurrent testers). Only the audible greeting **plus** the matching contact record proves this path. This greeting doesn't test speech recognition or bidirectional conversation. Do not save audio, credentials, JWTs or full browser/network logs as proof. See the [widget setup](https://docs.aws.amazon.com/connect/latest/adminguide/config-com-widget1.html) and [workstation/network requirements](https://docs.aws.amazon.com/connect/latest/adminguide/videocalling-networking-requirements.html).

## Run locally

Run from the team repo root. `node --test connect-web-call/backend/server.test.mjs` tests authorization and token issuance offline; `python3 -B connect-web-call/tests/test_with_aws.py` tests credential separation. For the actual application use Node LTS with `--env-file` and a **PoC-only** settings file kept outside git, mode 0600:

```sh
HOST=127.0.0.1 node --env-file="$HOME/.config/connect-web-call/local.env" connect-web-call/backend/server.mjs
```

Set `PORT`, `PUBLIC_ORIGIN`, `DEMO_PASSWORD`, `WIDGET_SCRIPT_URL`, `WIDGET_ID`, `WIDGET_SNIPPET_ID`, `WIDGET_SIGNING_KEY`. Supply real widget values for a call. The canonical deployment uses HTTPS; local media testing needs a browser-secure origin and a widget allowlist entry for the exact URL. Don't loosen the production allowlist or token checks to make localhost work. To test via the wire on the deployed hostname, use the team URL instead. Never pass the repo-wide `.env` into Docker or Node.

## Operator: prepare plans (no apply)

Tools: AWS CLI v2, OpenTofu ≥1.10, Python 3, jq, Docker with buildx, and the existing hosting backend. All commands below use repo-root paths. `connect-web-call/bin/with-aws` accepts ordinary dotenv assignments including spaces around `=` and reads only the names it needs; it doesn't execute the file. `ENV_FILE` selects another dotenv. Do not `source` the shared `.env` or edit colleagues' keys. `hosting` selects the hosting AWS pair and Cloudflare token; `connect` selects only the `_CONNECT_CUSTOMER` pair. `infra` presents distinct temporary `poc-hosting` and `poc-connect` profiles and checks both via STS. An operator intentionally using a configured Connect profile can specify `--connect-profile bsirikxm` **before** `connect` or `infra`.

```sh
w=connect-web-call/bin/with-aws
umask 077
$w infra tofu -chdir=connect-web-call/infra init
$w infra tofu -chdir=connect-web-call/infra plan -out=connect.tfplan
$w hosting infra/hosting/bin/tf init
$w hosting infra/hosting/bin/tf plan -var=poc_registry_enabled=true -out=poc-registry.tfplan
connect-web-call/deploy/deploy plan-guard registry infra/hosting/poc-registry.tfplan
```

The first plan must target Singapore in the **Connect** account, with its own key `connect-web-call/terraform.tfstate` in the **hosting** state bucket. It must add only the dedicated instance and its greeting flow. Do not initialize against `Infra-Phone/terraform.tfstate` or import an existing teammate instance. The hosting plan should add only the dedicated ECR resources, with routing still off. Inspect each with `tofu -chdir=<its-root> show <plan-file>` privately (plan binaries may contain sensitive data). Stop on unrelated changes or replacement. **Obtain explicit approval before applying each saved plan.** Apply the exact reviewed file using the corresponding wrapper; delete the file after a successful apply. Keep registry/route variables in your hosting `terraform.tfvars` for subsequent plans when activated; otherwise an unrelated default-off hosting plan may propose their removal. The existing hosting budget doesn't cover usage on the Connect account.

## Operator: widget and credentials

1. Use the PoC outputs for instance and greeting flow; confirm the flow is published. `CreateInstance` does not create an admin login. The Connect account owner can use IAM-authorized `ListSecurityProfiles`, `ListRoutingProfiles` and `CreateUser` outside IaC for their first Connect-managed admin (the instance's `Admin` profile, default routing profile and private password). No administrator password in argv, source, state or chat. Use an authorized operator if the keys lack those permissions; don't widen permissions automatically.
2. In the **Connect admin site** open **Channels → Communication widgets**, create a Web Calling widget for the published PoC flow, **audio only**. Allow `https://call-sea-hackathon.voidbox.io` and turn **request security on**. Save. Use the real generated snippet and security key, not an AWS key or an example from a blog. AWS documents the [authenticated widget callback and JWT claims](https://docs.aws.amazon.com/connect/latest/adminguide/optional-widget-steps.html).
3. In the **hosting** account's Systems Manager Parameter Store in Singapore, create these parameters as `SecureString` under `/sea-hackathon/connect-web-call/`. Use the console or your secret manager: never put values in chat, Git, shell history, a build argument or an SSM Run Command payload.

| Parameter leaf | Value |
|---|---|
| `WIDGET_SCRIPT_URL` | HTTPS SDK script URL (`s.src`) from the generated snippet |
| `WIDGET_ID` | Widget ID / script element ID in the snippet; becomes the JWT `sub` |
| `WIDGET_SNIPPET_ID` | The separate string passed to `amazon_connect('snippetId', …)` |
| `WIDGET_SIGNING_KEY` | Literal 44-character security key generated for this widget, not base64-decoded |
| `DEMO_PASSWORD` | New random demo password (at least 32 printable characters), shared privately with testers |

The browser receives public widget configuration and a 60-second JWT after authentication. It must never receive the signing key, password from an API response, or AWS credentials. Browser-to-AWS audio does not pass through EC2. The server-side token limit is **not** a billing cap.

## Operator: release and rollback

With the registry provisioned and all five parameters present, deploy from the dedicated PoC script (see `deploy/`), never `infra/hosting/bin/deploy connect-web-call`: the latter would replace the main app. The PoC lives at `/opt/connect-web-call`, Compose project `sea-connect-web-call`, private service `connect-web-call:8080` on `sea-hackathon_default`. The trusted host reads its own SSM parameters; the app must not use the EC2 role.

```sh
connect-web-call/deploy/deploy up
connect-web-call/deploy/deploy check
```

After the origin is healthy and anonymous access is denied, save a **new** hosting plan with `-var=poc_registry_enabled=true -var=poc_route_enabled=true -out=poc-route.tfplan`. Review: only the new CNAME and an in-place tunnel config update; old hostname still targets `app`, final rule is 404, no new host ports. After that plan's approval/apply, check the old site still serves its previous content and the PoC challenges anonymous visitors. Then run the real browser call above.

Use `connect-web-call/deploy/deploy plan-guard route infra/hosting/poc-route.tfplan` before approval. For an image-only rollback, redeploy the digest printed on the prior `previous_image=` line with `connect-web-call/deploy/deploy up --image '<repo>@sha256:<digest>'`. For a route rollback use `plan-guard route-off` against the separately saved removal plan. These guards read saved plans, never apply them.

For rollback, first disable `poc_route_enabled` **keeping the registry enabled**; plan, review, then apply that saved plan. Stop only `sea-connect-web-call`. Retain the PoC image for recovery. Deleting the dedicated Connect instance/registry, or removing parameters, is a separate destructive operation requiring its own approval. Never destroy `Infra-Phone/` or the main hosting stack to roll back this demo.
