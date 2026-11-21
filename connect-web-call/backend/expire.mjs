// Executed only after the app container stops. Recover and hang up any known upstream call;
// never listen, start a session, or log credentials, SDP or conversation content.
import { createVoiceProvider } from './realtime.mjs';

const { OPENAI_API_KEY: apiKey, VOICE_CUTOFF_AT, VOICE_STATE_DIR: stateDir } = process.env;
if (!apiKey || !stateDir) throw new Error('Missing voice cleanup configuration');
const provider = createVoiceProvider({ apiKey, stateDir, cutoffAt: Date.parse(VOICE_CUTOFF_AT) });
const { hungUp, uncertain } = await provider.shutdown();
if (!hungUp || uncertain) {
  console.error('Voice endpoint is stopped; upstream call clearance is unconfirmed.');
  process.exitCode = 1;
} else {
  console.log('Voice endpoint stopped; no known upstream call remains.');
}
