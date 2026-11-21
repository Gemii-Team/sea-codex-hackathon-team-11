# Connect destination (OpenTofu root)

This root owns only `team-eleven-web-call-greeting` on the existing `sea-team11-phone-demo` instance in Singapore (`ap-southeast-1`), Connect account `086971655102`. The instance is a read-only data source. The greeting flow speaks “Team Eleven. Your browser is connected to Amazon Connect.” then disconnects. It is not attached to a phone number or an existing widget. See the [operator runbook](../README.md) to bind a new secured web widget.

- State: key `connect-web-call/terraform.tfstate` in the existing hosting bucket, profile `poc-hosting`, account `157264476192`. The separate key is not an IAM boundary: whoever holds `poc-hosting` can read every key in the bucket.
- Provider: profile `poc-connect`, `allowed_account_ids = ["086971655102"]`. Profiles and accounts are literals, so a missing profile or a wrong account aborts; there is no fallback to other credentials or EC2 instance credentials. Run commands through `connect-web-call/bin/with-aws infra`, which creates both profiles and checks both accounts with STS first.
- Target: pinned instance ID and expected alias. Outputs: `instance_id`, `admin_url`, `flow_id`; none is secret.
- The flow content is `flows/web-call.json`. Offline mocked tests are `tests/greeting.tftest.hcl`.

## Commands

From the team repo root. Offline, no credentials:

```sh
tofu -chdir=connect-web-call/infra init -backend=false -input=false
tofu -chdir=connect-web-call/infra validate
tofu -chdir=connect-web-call/infra test
```

Live, only after explicit approval of the saved plan:

```sh
w=connect-web-call/bin/with-aws
$w infra tofu -chdir=connect-web-call/infra init
$w infra tofu -chdir=connect-web-call/infra plan -out=team-greeting.tfplan
$w infra tofu -chdir=connect-web-call/infra show -json team-greeting.tfplan | connect-web-call/infra/bin/assert-additions-only
# First creation only, after approval. A repeat plan after deployment should be a no-op.
$w infra tofu -chdir=connect-web-call/infra apply team-greeting.tfplan && rm connect-web-call/infra/team-greeting.tfplan
i="$($w infra tofu -chdir=connect-web-call/infra output -raw instance_id)"
f="$($w infra tofu -chdir=connect-web-call/infra output -raw flow_id)"
$w infra connect-web-call/infra/bin/verify-flow "$i" "$f"
```

`bin/assert-additions-only` accepts a first-create plan for the named greeting flow on the pinned instance. It rejects an instance create, an existing flow update, or a deletion.

The provider can neither set nor read a flow's publication status, so `bin/verify-flow` is the proof of "published": it reads the flow back and checks `PUBLISHED`, `ACTIVE`, `CONTACT_FLOW`, the name, and that the stored runtime definition (start action, every action with its type, parameters, transitions and errors) equals `flows/web-call.json`. Designer `Metadata` (layout, positions) is ignored, so presentation-only edits do not fail it. If it reports `SAVED`, publish the flow once in the admin site and run it again. A runtime mismatch means someone edited the flow or Connect normalised it; compare before applying a content-only update.

`verify-flow` proves configuration, not audibility. Confirm the spoken greeting and match the `VOICE`/`WEBRTC_API` contact to the test call; do not attribute an unrelated contact on the shared instance to the PoC. Only this PoC's flow and widget may be removed during a separately approved teardown. Do not import or destroy the instance.
