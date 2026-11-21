# Cloud Orchestrator

A Svelte console for an AWS and Tencent Cloud control plane. The Go API and monitor run as separate processes. OpenTofu manages the cloud resources through separate roots.

```text
Browser → Svelte console → Go API → Go monitor
                                      └─ probes the Go API health endpoint
Prometheus → Go monitor metrics
Operator → OpenTofu → AWS sandbox or Tencent Cloud sandbox
```

## Run locally

With Docker and Docker Compose installed, run `make up`. Open the console at <http://localhost:5173> and Prometheus at <http://localhost:9090>. In Prometheus, query `orchestrator_api_up` or open the **Alerts** page. To see the API alert fire, run `docker compose stop api`, allow at least one minute plus a scrape interval, then run `docker compose start api`. Run `make down` to stop the stack.

For development without Docker, run these commands in three terminals from the repository root. Use Go 1.25 and Node.js 22.

```sh
go run ./services/api
go run ./services/monitor
cd frontend && npm install && npm run dev
```

The console polls control-plane health every 15 seconds. The monitor probes the API when its status or metrics endpoint is requested. Cloud resource metrics, alert delivery, and workload deployment are future extensions.

## Provision a sandbox

Use OpenTofu. It supports built-in state and plan encryption and has providers for both clouds. Terraform remains an option if an existing team workflow depends on HCP Terraform. The AWS root defaults to Singapore with CIDR `10.20.0.0/16`, and the Tencent Cloud root defaults to Singapore with CIDR `10.21.0.0/16`. Each root creates a VPC and outputs its ID.

Use an AWS credential chain (for example, `AWS_PROFILE` with an AWS SSO session) or Tencent Cloud credentials supplied in the shell (`TENCENTCLOUD_SECRET_ID`, `TENCENTCLOUD_SECRET_KEY`, and `TENCENTCLOUD_SECURITY_TOKEN` for STS credentials). Select the sandbox account before planning. Change the region or network range via `TF_VAR_region` and `TF_VAR_vpc_cidr` if needed.

| Cloud | Generate a saved plan | Review and apply |
| --- | --- | --- |
| AWS | `make plan-aws` | `make apply-aws` |
| Tencent Cloud | `make plan-tencent` | `make apply-tencent` |

The apply commands print the saved plan and ask for confirmation. The sandbox roots use separate local state files for initial experiments. Commit the generated provider lock files after a successful init. Before team use, configure a versioned, encrypted remote backend with locking and a separate state key for each cloud and environment. Enable OpenTofu state and plan encryption with a managed key before storing sensitive outputs. Keep the API and monitoring processes free of provisioning credentials.

## Grow the control plane

1. Add network modules and one workload template at a time. Keep provider-specific configuration in each cloud root and expose common outputs such as VPC and subnet IDs.
2. Add a provisioning worker with a durable job store. Record who requested each operation, the target environment, and the approved saved plan. Serialize runs that share a state key and use scoped, short-lived cloud credentials. Start with CI approval gates before adding write endpoints to the console.
3. Add AWS CloudWatch and Tencent Cloud Monitor collectors with separate read-only identities. Normalize cloud, account, region, and resource identifiers so one dashboard can display both clouds.
4. Add an optional AI incident advisor after the metrics and alerts are working. Give it a read-only alert snapshot, a time window of related metrics, and approved runbook excerpts. Render a summary, evidence links, and suggested checks in the console. Keep plan approval and infrastructure execution in the operator workflow.

## Verification

The first successful npm install generates `frontend/package-lock.json`. Commit it to make subsequent builds reproducible.

`make check` runs the Go tests, builds the frontend using the npm lockfile when available, and validates the Compose configuration. CI also validates both OpenTofu roots without cloud credentials.
