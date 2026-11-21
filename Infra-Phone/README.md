# Amazon Connect Web Calling plan

The demo uses Amazon Connect Customer in Singapore (`ap-southeast-1`). A tester opens the demo page, allows microphone access, and talks in Thai with an automated assistant through Web Calling. Use team members and simulated conversations for the demo. The data deliverable is one JSON object per conversation for the list and detail views.

## OpenTofu layout

`Infra-Phone/` is the OpenTofu root for Web Calling. Its service modules live in `Infra-Phone/AWS/`, and it has its own S3 state key.

| File | Purpose |
| --- | --- |
| [`main.tf`](main.tf) | Configure the AWS provider and call the service modules. |
| [`variable.tf`](variable.tf), [`terraform.tfvars.example`](terraform.tfvars.example) | Declare inputs and provide demo values for Singapore, the instance alias, tags, and retention. |
| [`output.tf`](output.tf) | Expose the Connect instance ID and ARN, bucket names, and the JSON key prefix. |
| [`backend.s3.hcl.example`](backend.s3.hcl.example) | Configure an existing state bucket, the `Infra-Phone/terraform.tfstate` key, encryption, and native S3 locking. |
| [`AWS/connect/`](AWS/connect/) | Create the Connect instance and associate the raw bucket with `CALL_RECORDINGS` for interaction logs. Inbound calling is enabled for Web Calling. |
| [`AWS/s3/`](AWS/s3/) | Create the raw log and processed JSON buckets with public access blocked, encryption at rest, HTTPS enforcement, and default retention of 7 and 30 days respectively. |

### Validate locally

From the repository root, run the commands against `Infra-Phone/`.

```bash
tofu -chdir=Infra-Phone fmt -check -recursive
tofu -chdir=Infra-Phone init -backend=false
tofu -chdir=Infra-Phone validate
```

### Prepare a plan

For a future AWS review, set `name_prefix` in `Infra-Phone/terraform.tfvars` to an available Connect alias. On a fresh checkout, initialize that file from `terraform.tfvars.example`. Within `Infra-Phone/`, copy `backend.s3.hcl.example` to `backend.s3.hcl` and enter the name and Region of an existing state bucket accessible to `bsirikxm`. Run from the repository root.

```bash
export AWS_PROFILE=bsirikxm
tofu -chdir=Infra-Phone init -reconfigure -backend-config=backend.s3.hcl
tofu -chdir=Infra-Phone plan -out=phone.tfplan
```

## First Web Call

1. After the OpenTofu plan has been reviewed and applied, use `connect_instance_id` to find the Connect instance. Set up an administrator with the Connect Admin security profile for the remaining configuration. Use the AWS console's federated access to bootstrap that user if the instance has no administrator. [Connect administrator access](https://docs.aws.amazon.com/connect/latest/adminguide/emergency-admin-login.html)
2. In the Connect admin site, configure the Thai Conversational AI bot and its self-service AI agent. Set the voice to Thai (`th-TH`), matching the Lex locale (`th_TH`). Use a short greeting that identifies the assistant as automated. Have the agent ask one question at a time and return control to the flow to end the call if the caller asks for an OTP or requests a transaction. [Agentic self-service](https://docs.aws.amazon.com/connect/latest/adminguide/agentic-self-service.html) · [Thai voice configuration](https://docs.aws.amazon.com/connect/latest/adminguide/agentic-voice-best-practices.html)
3. In the inbound flow, use `Set voice` followed by `Get customer input` to invoke the Thai bot. Route completion and errors to a disconnect path. Publish the flow, select it in the Communications Widget's Web Calling settings, and allow the demo site's origin. Embed the generated widget snippet in the demo app. Have a teammate make a Web Call through a browser and verify the greeting, a follow-up response, and the disconnect path. [Web Calling widget](https://docs.aws.amazon.com/connect/latest/adminguide/config-com-widget1.html)
4. Enable Automated Interaction Logs and bot transcripts in Connect. Make a Thai test call and verify the source object in S3 has ordered turns for both the caller and bot. Keep audio recording off at the flow level and verify the transcript with that setting. AWS advises allowing up to 30 minutes after the call ends for the interaction log. [Connect interaction logs](https://docs.aws.amazon.com/connect/latest/adminguide/monitor-automated-interaction-logs.html)

Keep the Thai agent prompt under `Infra-Phone/prompts/` when configuring the agent. When the team is ready to manage the flow in OpenTofu, save `ContactFlow.Content` from `aws connect describe-contact-flow` as Flow Language JSON under `Infra-Phone/AWS/connect/flows/` and import the existing flow into state. The `aws_connect_contact_flow` resource expects the API format. [Terraform AWS provider contact flow resource](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/connect_contact_flow)

## Conversation data handoff

After the source format is verified, add an `Infra-Phone/AWS/lambda/` module for the S3 event trigger and the processor. Scope the processor's IAM permissions to the log source, the processed JSON prefix, and the Bedrock model. Have Lambda extract the two speakers' turns, remove sensitive values, and request a Thai summary from Bedrock. Write `v1/conversations/<contactId>.json` to the processed bucket using the Connect contact ID as the key so retries address the same record. If summary generation fails, retain the turns with `summaryStatus` set to `failed` and `summary` set to `null`.

The UI developer can start from the [JSON Schema](contracts/conversations/v1/conversation.schema.json) and [Thai fixture](contracts/conversations/v1/examples/demo-otp-request.json). When the pipeline is ready, give the app backend read-only access to the processed prefix. Use the fixture or a previously processed conversation for the demo's detail view while the most recent call is being processed.
