---
name: wirachit-thai-voice
description: Design, implement, or test Wirachit's Thai-language inbound AI phone assistant. Use for OpenAI Realtime voice, SIP call routing, agent configuration, message taking, or human handoff in this repository.
---

# Wirachit Thai Voice

Inspect the repository before choosing implementation points. Reuse the Svelte console, Go API, and local Compose setup. For new telephony work, keep call handling in a Go service and keep dashboard configuration in the API. PostgreSQL is the intended store for workspaces, numbers, agents, and messages. Prometheus and OpenTofu can support operations and deployment.

## Inbound calling

- Start with one authorized number, one workspace, and one agent. Make the destination number select a workspace and agent so more numbers can be added later. Scope every dashboard query and tool action to that workspace.
- Verify current OpenAI request schemas against the official guide before implementing. Route the carrier trunk to OpenAI SIP. Verify the webhook signature against the raw body, deduplicate deliveries, and resolve the called number from the configured trunk routing data before accepting. Reject calls without a configured route. Connect server-side to the accepted session for events and tool calls. [OpenAI Telephony and SIP](https://developers.openai.com/api/docs/guides/voice-sip?voice-api=realtime)
- Keep the OpenAI key and webhook secret in the Go service. Use call context to identify the workspace when handling tool calls. Use configured destinations for any transfer and validate carrier support before enabling it.
- Begin with greeting, message taking, and a callback number confirmed by the caller. Show the result in Svelte. Keep call audio recording off by default. Use timing and outcome metrics without phone numbers or message text in metric labels.

## Thai voice

Open with a brief disclosure such as “สวัสดีค่ะ นี่คือผู้ช่วย AI ค่ะ ฝากชื่อและเรื่องที่ต้องการติดต่อไว้ได้เลยนะคะ” Use natural spoken Thai, ask one question at a time, and pause when the caller speaks. Ask for clarification when a name or number is unclear. Confirm the callback number digit by digit before saving.

Test with Thai speakers on an actual phone line before selecting the production voice. Include Thai names, Thai mixed with English, interruptions, background noise, and similar-sounding digits. Check first-response delay, whether interruption stops playback promptly, and whether the saved callback number matches what the caller confirmed. For local development, use synthetic webhook events and a fake Realtime client to exercise routing and duplicate delivery without placing a call.
