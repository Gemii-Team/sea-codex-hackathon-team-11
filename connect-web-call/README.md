# Team 11 · OpenAI voice demo

Open **https://call-sea-hackathon.voidbox.io**, sign in as `team` with the existing demo password, press **Start call**, and allow microphone access. A Thai-speaking AI greets you. Speak naturally and choose **End call** when done. Use headphones, and never share real passwords, OTPs or customer data. The public URL is temporary. The app neither records audio nor stores transcripts. OpenAI processes the audio.

## What runs

`frontend/call.js` uses the team's native WebRTC approach from Agent Studio, without the recorder. A same-origin `POST /api/voice/calls` submits the browser's `application/sdp` offer. The Node server authenticates the user and posts that offer plus its fixed model, voice and Thai instructions to [OpenAI Realtime](https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/create). It returns only the SDP answer and call ID. A data channel triggers the first greeting; audio flows between browser and OpenAI. `POST /api/voice/calls/{id}/hangup` ends the active call server-side. Neither endpoint accepts arbitrary upstream URLs or caller-supplied models. Calls are billable; no call starts on page load.

**Limits:** one active call, up to three minutes, 25 start attempts for the entire demo. The server reserves an attempt on disk before contacting OpenAI. The counter and active call ID survive container replacement under `/opt/connect-web-call/state`; they contain no audio, conversation text or API key. Starting with an active ID triggers hangup recovery. If a request times out before OpenAI returns a call ID, the browser is not given an answer; a temporary reservation prevents an immediate second start. Do not reset the counter to troubleshoot a failure.

**November 21 cutoff (Bangkok):** no new calls from 23:55; known calls are scheduled to end no later than 23:57. At 23:59 the existing persistent EC2 timer stops only the demo. A service drop-in runs `backend/expire.mjs` after stopping, so outstanding known calls can be hung up from durable state. The container does not auto-restart. DNS and the tunnel rule are separate from the runtime cutoff.

## Test and run locally

From the team repository root, run `node --test connect-web-call/backend/*.test.mjs`. The automated suite uses a fake upstream, not a billable call. For local development, set `HOST=127.0.0.1`, `PORT=8080`, `PUBLIC_ORIGIN=http://127.0.0.1:8080`, `VOICE_CUTOFF_AT` (explicit UTC instant), `VOICE_STATE_DIR` (writable absolute path), `DEMO_PASSWORD` and `OPENAI_API_KEY` in a PoC-only mode-0600 env file outside Git. Start with:

```sh
node --env-file="$HOME/.config/team11/voice-local.env" connect-web-call/backend/server.mjs
```

## Operate the existing EC2 service

- Project/host: `sea-connect-web-call`, `/opt/connect-web-call`, `ap-southeast-1`. Same ECR repo, private Docker network and Cloudflare route as the original Connect PoC. Never run the main app's deploy command with this build context.
- Two SSM `SecureString`s in the hosting account: `/sea-hackathon/connect-web-call/DEMO_PASSWORD` and `/sea-hackathon/connect-web-call/OPENAI_API_KEY`. The latter is privately seeded from the repo-local `OPENAI_API_KEY_MOO`; it is not used by the main site. No keys in the browser, Docker build arguments, Run Command payloads, git or logs. The previous widget parameters are not loaded by the OpenAI container.
- Run `connect-web-call/deploy/deploy up` to build/push a new arm64 image, start it by digest, and probe access on the shared network. `connect-web-call/deploy/deploy check` repeats those probes without starting a call. **Only click Start for an explicitly authorized live test.** If audio works, confirm End call returns 204; an SDP answer alone does not prove playback.
- To disable the hostname, save and review the hosting plan with `poc_registry_enabled=true` and `poc_route_enabled=false`; use `connect-web-call/deploy/deploy plan-guard route-off <plan-path>` before obtaining apply approval. Keep the main hostname, shared tunnel, and registry intact.
- The [`infra/`](infra/README.md) root remains the record of the historical Amazon Connect greeting flow. Do not destroy the team's shared Connect instance or its flow, and do not apply anything in `Infra-Phone/` for this provider switch.
