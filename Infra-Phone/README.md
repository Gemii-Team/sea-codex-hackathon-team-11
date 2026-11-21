# Amazon Connect Web Calling plan

The demo uses Amazon Connect Customer in Singapore (`ap-southeast-1`). A tester opens the demo page, allows microphone access, and talks in Thai with an automated assistant through Web Calling. Use team members and simulated conversations for the demo. The data deliverable is one JSON object per conversation for the list and detail views.

## OpenTofu layout

Use this directory as its own OpenTofu root, following the [hosting stack's provider conventions](../infra/hosting/versions.tf). Use `AWS_PROFILE=bsirikxm` when running OpenTofu. Give this stack its own state key, such as `Infra-Phone/terraform.tfstate`, in an encrypted backend accessible to that profile.

| Planned file | Purpose |
| --- | --- |
| `versions.tf`, `variables.tf` | Declare OpenTofu and the AWS provider, default the Region to `ap-southeast-1`, and accept the instance alias and environment. |
| `backend.tf` | Configure the stack's state key and locking. |
| `connect.tf` | Provision the Connect instance. Add the contact flow resource once the tested flow is ready to import. |
| `storage.tf` | Create private, encrypted S3 buckets for Connect interaction logs and processed conversation JSON. Associate the source bucket with Connect's call-recording storage and configure retention for both buckets. |
| `outputs.tf` | Publish the Connect instance ID, the flow ID once managed by OpenTofu, and the processed bucket name. |
| `prompts/agent-th.txt` | Keep the Thai agent persona, response style, and rules for ending the call in version control. |
| `flows/web-call.json` | Store the tested inbound flow in Amazon Connect Flow Language when adopting it into OpenTofu. |
| `processor.tf` | Configure the post-call Lambda, its S3 event trigger, and the scoped S3 and Bedrock permissions after transcript export is verified. |

## First Web Call

1. Provision the Connect instance and S3 storage from this OpenTofu root. Run `tofu init`, then format, validate, and review the plan before applying it.
2. In the Connect admin site, configure the Thai Conversational AI bot and its self-service AI agent. Set the voice to Thai (`th-TH`), matching the Lex locale (`th_TH`). Use a short greeting that identifies the assistant as automated. Have the agent ask one question at a time and return control to the flow to end the call if the caller asks for an OTP or requests a transaction. [Agentic self-service](https://docs.aws.amazon.com/connect/latest/adminguide/agentic-self-service.html) · [Thai voice configuration](https://docs.aws.amazon.com/connect/latest/adminguide/agentic-voice-best-practices.html)
3. In the inbound flow, use `Set voice` followed by `Get customer input` to invoke the Thai bot. Route completion and errors to a disconnect path. Publish the flow, select it in the Communications Widget's Web Calling settings, and allow the demo site's origin. Embed the generated widget snippet in the demo app. Have a teammate make a Web Call through a browser and verify the greeting, a follow-up response, and the disconnect path. [Web Calling widget](https://docs.aws.amazon.com/connect/latest/adminguide/config-com-widget1.html)
4. Enable Automated Interaction Logs and bot transcripts in Connect. Make a Thai test call and verify the source object in S3 has ordered turns for both the caller and bot. Keep audio recording off at the flow level and verify the transcript with that setting. AWS advises allowing up to 30 minutes after the call ends for the interaction log. [Connect interaction logs](https://docs.aws.amazon.com/connect/latest/adminguide/monitor-automated-interaction-logs.html)

When the team is ready to manage the flow in OpenTofu, save `ContactFlow.Content` from `aws connect describe-contact-flow` as the Flow Language JSON and import the existing flow into state. The `aws_connect_contact_flow` resource expects the API format. [Terraform AWS provider contact flow resource](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/connect_contact_flow)

## Conversation data handoff

After the source format is verified, have Lambda process the S3 interaction log, extract the two speakers' turns, remove sensitive values, and request a Thai summary from Bedrock. Write `v1/conversations/<contactId>.json` to the processed bucket using the Connect contact ID as the key so retries address the same record. If summary generation fails, retain the turns with `summaryStatus` set to `failed` and `summary` set to `null`.

The UI developer can start from the [JSON Schema](../contracts/conversations/v1/conversation.schema.json) and [Thai fixture](../contracts/conversations/v1/examples/demo-otp-request.json). When the pipeline is ready, give the app backend read-only access to the processed prefix. Use the fixture or a previously processed conversation for the demo's detail view while the most recent call is being processed.
