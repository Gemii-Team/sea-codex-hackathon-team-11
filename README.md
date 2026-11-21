# sea-codex-hackathon-team-11

## Web call conversation data

Use the [v1 JSON Schema](contracts/conversations/v1/conversation.schema.json) and [synthetic Thai conversation](contracts/conversations/v1/examples/demo-otp-request.json) to build the conversation list and detail views locally. Each JSON file represents one conversation. Render `turns` in array order and use `summary.title` and `summary.text` when `summaryStatus` is `ready`. Each `evidenceTurnIds` entry points to a `turns[].id` in the same record. If the summary is unavailable or failed, display the available turns and their transcript status.

The planned private S3 object key is `v1/conversations/<contactId>.json`. The UI can use `source` to label synthetic fixtures. See the [Amazon Connect Web Calling plan](Infra-Phone/README.md) for the OpenTofu layout and demo setup.
