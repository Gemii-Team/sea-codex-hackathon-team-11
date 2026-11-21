# Cloud Orchestrator

A Svelte console for an cloud control plane. The Go API and monitor run as separate processes. OpenTofu manages the cloud resources for production hosting.

```text
Browser → Svelte console → Go API → Go monitor
                                      └─ probes the Go API health endpoint
Prometheus → Go monitor metrics
Operator → OpenTofu → AWS hosting
```

## Agent Studio

The console opens to a Thai-language workspace for creating AI agent drafts. Customize the greeting, tone, and instructions, preview a scripted conversation, and save drafts in the current browser. The Amazon Connect section stores the AWS region, instance ID, published contact flow ID, and inbound number for future integration. The system health page remains available from the sidebar.

This portal prototype uses browser storage and scripted text previews. Live Amazon Connect routing, OpenAI audio, and shared workspace storage are pending.

## Run locally

With Docker and Docker Compose installed, run `make up`. Open the console at <http://localhost:5173> and Prometheus at <http://localhost:9090>. In Prometheus, query `orchestrator_api_up` or open the **Alerts** page. To see the API alert fire, run `docker compose stop api`, allow at least one minute plus a scrape interval, then run `docker compose start api`. Run `make down` to stop the stack.

For local testing of the production frontend bundle, use Bun:

```sh
cd frontend
bun install
bun run --bun build
bun run --bun preview
```

Open <http://127.0.0.1:4173>. Run `go run ./services/api` and `go run ./services/monitor` from the repository root in separate terminals if testing the system health page. Use `make up` to test the full stack with the Nginx production image.

The console polls control-plane health every 15 seconds. The monitor probes the API when its status or metrics endpoint is requested. Cloud resource metrics, alert delivery, and workload deployment are future extensions.

## Grow the control plane

1. Add network modules and one workload template at a time. Keep provider-specific configuration in each cloud root and expose common outputs such as VPC and subnet IDs.
2. Add a provisioning worker with a durable job store. Record who requested each operation, the target environment, and the approved saved plan. Serialize runs that share a state key and use scoped, short-lived cloud credentials. Start with CI approval gates before adding write endpoints to the console.
3. Add AWS CloudWatch and Tencent Cloud Monitor collectors with separate read-only identities. Normalize cloud, account, region, and resource identifiers so one dashboard can display both clouds.
4. Add an optional AI incident advisor after the metrics and alerts are working. Give it a read-only alert snapshot, a time window of related metrics, and approved runbook excerpts. Render a summary, evidence links, and suggested checks in the console. Keep plan approval and infrastructure execution in the operator workflow.

## Verification

`make check` runs the Go tests, builds the frontend with the Bun lockfile, and validates the Compose configuration. GitHub Actions also builds and smoke-tests the container stack, validates the hosting OpenTofu root, and runs the mocked hosting tests.

See the [hosting runbook](infra/hosting/README.md#github-actions) to enable AWS deployments after CI passes.

## Web call conversation data

Use the [v1 JSON Schema](Infra-Phone/contracts/conversations/v1/conversation.schema.json) and [synthetic Thai conversation](Infra-Phone/contracts/conversations/v1/examples/demo-otp-request.json) to build the conversation list and detail views locally. Each JSON file represents one conversation. Render `turns` in array order and use `summary.title` and `summary.text` when `summaryStatus` is `ready`. Each `evidenceTurnIds` entry points to a `turns[].id` in the same record. If the summary is unavailable or failed, display the available turns and their transcript status.

The planned private S3 object key is `v1/conversations/<contactId>.json`. The UI can use `source` to label synthetic fixtures. See the [Amazon Connect Web Calling plan](Infra-Phone/README.md) for the OpenTofu layout and demo setup.
