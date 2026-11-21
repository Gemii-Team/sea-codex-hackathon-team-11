# Thai web calling demo

OpenAI Realtime handles live audio over WebRTC. The local app creates a contact ID, receives both speakers' transcripts through a server-side connection, and saves the call history for the browser to reopen.

## Agent Studio production integration

Agent Studio starts its existing OpenAI call in the Compute account. An internal phone-history service attaches a server-side connection to that same call and records masked caller and agent turns. The call ID also identifies the existing audio recording. The team code opens the Thai call-history page. Reading full evidence also requires the review key in the phone-history volume at `/data/evidence-key`. Audio stays in the existing recording volume.

The default history store uses the persistent phone-history volume. To use the Connect account's private conversation bucket, configure `PHONE_HISTORY_BUCKET` and `PHONE_HISTORY_REGION` under the hosting app's SSM parameter prefix and grant the workload identity access to the bucket's conversation and evidence prefixes. The service uses the AWS credential chain. Local history is not automatically copied on a storage switch. An OpenAI web call is labeled `openai_realtime`. Connect routing is configured separately.

## Run the demo

1. Use Node.js 26. At the repository root, copy [`.env.sample`](../.env.sample) if you do not have an `.env` file, then set `OPENAI_API_KEY` in `.env`.

   ```bash
   test -e .env || (umask 077 && cp .env.sample .env)
   ```

2. Start the app from the repository root. Leave `PHONE_HISTORY_BUCKET` empty to save into `Infra-Phone/demo/.history/`.

   ```bash
   node --env-file=.env Infra-Phone/demo/server.mjs
   ```

   For S3, authenticate the configured AWS CLI profile and set `PHONE_HISTORY_BUCKET` in `.env`, or export it from OpenTofu before starting the server.

   ```bash
   export PHONE_HISTORY_BUCKET="$(tofu -chdir=Infra-Phone output -raw conversation_bucket_name)"
   node --env-file=.env Infra-Phone/demo/server.mjs
   ```

3. Open [localhost:8783](http://localhost:8783/), enter an optional display name, and start a call with the microphone. Use a simulated conversation and allow the bot to respond before hanging up. Open the saved record and verify both speakers.

S3 records use `v1/conversations/<contactId>.json` and the [v1 JSON Schema](contracts/conversations/v1/conversation.schema.json). Each record identifies its source as `openai_realtime`, `connect`, or `fixture`. The app stores text with digit sequences and email addresses masked. If a reply is interrupted, its transcript may be partial. The fixture includes a summary. Live calls start with `summaryStatus` set to `unavailable`, ready for a later summary processor.

### Review caller evidence

Ploy is a fictional character and uses the test reference `DEMO-PLOY-001` when a reference is needed. For test calls where the caller states a destination account, callback number, reference, or link, the app extracts recognized values from the caller transcript. Review each value alongside its turn ID. The values are caller statements and should be checked against the original interaction before sharing.

Select **เปิดหลักฐานฉบับเต็ม** and enter the local review key from `Infra-Phone/demo/.history/evidence-key`. The app generates that file at first start. Evidence for new calls uses `v1/evidence/<contactId>.json` in the same private bucket or the `evidence/` directory in local storage. The history record contains the count and masked text. Older history records already have masking applied. AWS principals with bucket read permission can access the evidence objects according to their IAM policies. The web review key applies to the localhost app.

## Amazon Connect setup reference

The optional Connect voice path uses Amazon Connect Customer in Singapore (`ap-southeast-1`). Set `enable_connect = true` in `terraform.tfvars` to provision that path and its interaction-log bucket. A tester opens the demo page, allows microphone access, and talks in Thai with an automated assistant through Web Calling. Use team members and simulated conversations for the demo. The data deliverable is one JSON object per conversation for the list and detail views.

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

Connect handles live Thai voice. Once a test call verifies the source log format, add an `Infra-Phone/AWS/lambda/` module for the S3 event trigger and the processor. After each call, have Lambda extract the two speakers' turns, remove sensitive values, and call the OpenAI Responses API for a Thai summary. Use Structured Outputs for the `summary` object and verify that its `evidenceTurnIds` point to turns in the same conversation. [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

Store the OpenAI project API key in AWS Secrets Manager and pass the secret ARN to Lambda through OpenTofu. Let Lambda retrieve the key at runtime. Scope the Lambda role to read the source log prefix and that secret, and write to the processed JSON prefix. [OpenAI API key guidance](https://developers.openai.com/api/docs/guides/api-keys)

Write `v1/conversations/<contactId>.json` to the processed bucket using the Connect contact ID as the key so retries address the same record. If summary generation fails, retain the turns with `summaryStatus` set to `failed` and `summary` set to `null`.

The UI developer can start from the [JSON Schema](contracts/conversations/v1/conversation.schema.json) and [Thai fixture](contracts/conversations/v1/examples/demo-otp-request.json). When the pipeline is ready, give the app backend read-only access to the processed prefix. Use the fixture or a previously processed conversation for the demo's detail view while the most recent call is being processed.
