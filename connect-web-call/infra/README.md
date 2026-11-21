# Connect destination (OpenTofu root)

Provisions only the Amazon Connect side of the browser call, in Singapore (`ap-southeast-1`), account `086971655102`: one inbound-only `CONNECT_MANAGED` instance (alias `sea-hackathon-team-11-web-call-5102`) and one inbound `CONTACT_FLOW`, `team-eleven-web-call-greeting`, that says "Team Eleven. Your browser is connected to Amazon Connect." and then disconnects (a playback error also disconnects). No phone numbers, outbound calling, recordings, storage, IAM or users, and the widget, its signing key and the first admin login stay outside OpenTofu and state. Operator steps, widget setup, SSM parameters and rollback are in [`../README.md`](../README.md).

- State: key `connect-web-call/terraform.tfstate` in the existing hosting bucket, profile `poc-hosting`, account `157264476192`. The separate key is not an IAM boundary: whoever holds `poc-hosting` can read every key in the bucket.
- Provider: profile `poc-connect`, `allowed_account_ids = ["086971655102"]`. Profiles and accounts are literals, so a missing profile or a wrong account aborts; there is no fallback to other credentials or EC2 instance credentials. Run commands through `connect-web-call/bin/with-aws infra`, which creates both profiles and checks both accounts with STS first.
- Input: `instance_alias`. Outputs: `instance_id`, `admin_url`, `flow_id`; none is secret.
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
$w infra tofu -chdir=connect-web-call/infra plan -out=connect.tfplan
$w infra tofu -chdir=connect-web-call/infra show -json connect.tfplan | connect-web-call/infra/bin/assert-additions-only
# review, then apply exactly that file and delete it:
$w infra tofu -chdir=connect-web-call/infra apply connect.tfplan && rm connect-web-call/infra/connect.tfplan
i="$($w infra tofu -chdir=connect-web-call/infra output -raw instance_id)"
f="$($w infra tofu -chdir=connect-web-call/infra output -raw flow_id)"
$w infra connect-web-call/infra/bin/verify-flow "$i" "$f"
```

`bin/assert-additions-only` passes only if the plan creates exactly the instance and the flow and nothing else.

The provider can neither set nor read a flow's publication status, so `bin/verify-flow` is the proof of "published": it reads the flow back and checks `PUBLISHED`, `ACTIVE`, `CONTACT_FLOW`, the name, and that the stored runtime definition (start action, every action with its type, parameters, transitions and errors) equals `flows/web-call.json`. Designer `Metadata` (layout, positions) is ignored, so presentation-only edits do not fail it. If it reports `SAVED`, publish the flow once in the admin site and run it again. A runtime mismatch means someone edited the flow or Connect normalised it; compare before applying a content-only update.

`verify-flow` proves the flow's configuration, not that anyone heard it. Flow logs are off, so there is no flow-level record of playback: audible confirmation by a person, plus the matching `VOICE`/`WEBRTC_API` contact record, is still required (see [`../README.md`](../README.md)).

**Partial or failed create.** If apply stops after the instance exists (flow create failed, timeout, alias error), do not rerun blindly. Re-run `plan` and read it: a plan that creates only the missing flow is fine to review and apply. Stop on any `-/+` (replace) or destroy of `aws_connect_instance.this` or the flow; never auto-replace, `taint`, `untaint` or `state rm` to force a clean run. Recover together with the operator: check what exists in the Connect account first, then import or fix the cause deliberately. Do not repeatedly create and destroy instances; Connect limits instance creates and deletes. Inspect a separate destroy plan before removing this stack.
