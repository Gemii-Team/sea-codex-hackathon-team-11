// Page glue for the AWS-managed Amazon Connect web-calling widget. All decisions that matter
// (URL validation, the documented snippet, the token callback) live in widget.mjs.
//
// Nothing here starts a call or reports one as connected. The only claims this page makes are
// about things it observed itself: configuration loaded, widget script loaded, a token request
// succeeded or failed.
import { createAuthenticate, fetchWidgetConfig, installWidgetLoader } from './widget.mjs';

const byId = (id) => document.getElementById(id);
const statusEl = byId('widget-status');
const errorEl = byId('widget-error');
const reloadButton = byId('reload');
const attemptsEl = byId('attempts');

reloadButton.addEventListener('click', () => window.location.reload());

function setStatus(state, message) {
  statusEl.dataset.state = state;
  statusEl.textContent = message;
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
  reloadButton.hidden = false;
}

function clearError() {
  errorEl.textContent = '';
  errorEl.hidden = true;
}

const utc = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

function logAttempt(at, text) {
  byId('attempts-empty')?.remove();
  const item = document.createElement('li');
  const time = document.createElement('time');
  time.dateTime = at.toISOString();
  time.textContent = utc(at);
  item.append(time, ` \u2014 ${text}`);
  attemptsEl.prepend(item);
  while (attemptsEl.children.length > 10) attemptsEl.lastElementChild.remove();
}

function onTokenEvent(event) {
  if (event.type === 'token-requested') {
    logAttempt(event.at, 'asked for a call token\u2026');
    setStatus('working', 'Requesting a call token\u2026');
  } else if (event.type === 'token-issued') {
    logAttempt(event.at, 'token issued and handed to the widget.');
    clearError();
    setStatus(
      'working',
      `Call token issued at ${utc(event.at)} UTC and handed to the widget. Use the call controls to start or continue the call. ` +
        'A token does not show that a call or audio is active: listen for the greeting.',
    );
  } else {
    logAttempt(event.at, `token request failed${event.status ? ` (HTTP ${event.status})` : ''}.`);
    setStatus('error', 'Could not get a call token.');
    showError(event.message);
  }
}

const MIC_TEXT = {
  granted: 'Microphone: allowed for this site.',
  denied: 'Microphone: blocked for this site. Follow the steps below, then reload.',
  prompt: 'Microphone: your browser will ask when the call starts.',
};

async function watchMicrophone() {
  const el = byId('mic-status');
  if (!window.isSecureContext || !navigator.mediaDevices) {
    el.textContent = 'Microphone unavailable: open this page over HTTPS (or localhost) to make a call.';
    return;
  }
  try {
    const permission = await navigator.permissions.query({ name: 'microphone' });
    const render = () => {
      el.textContent = MIC_TEXT[permission.state] ?? 'Microphone: your browser will ask when the call starts.';
    };
    render();
    permission.addEventListener('change', render);
  } catch {
    el.textContent = 'Microphone: your browser will ask when the call starts.';
  }
}

async function main() {
  watchMicrophone();
  const request = window.fetch.bind(window);

  let config;
  try {
    config = await fetchWidgetConfig(request);
  } catch (error) {
    setStatus('error', 'The call widget is not available.');
    showError(error.message);
    return;
  }

  const host = new URL(config.scriptUrl).host;
  setStatus('pending', `Loading the Amazon Connect widget from ${host}\u2026`);
  try {
    installWidgetLoader({
      window,
      document,
      config,
      authenticate: createAuthenticate({ fetch: request, onEvent: onTokenEvent }),
      // `load` only means the loader script was fetched and ran, not that the widget is available.
      onLoad: () =>
        setStatus(
          'pending',
          'Widget script loaded. Call controls appear in the lower right; use them to start the call. If they don\u2019t appear, reload this page, ' +
            'turn off content blockers, and ask the team to check that this site\u2019s address is on the widget\u2019s allowed domain list.',
        ),
      onError: () => {
        setStatus('error', 'The Amazon Connect widget script did not load.');
        showError(
          `The widget script could not be loaded from ${host}. Check your connection and content blockers, ` +
            'then reload this page.',
        );
      },
    });
  } catch (error) {
    setStatus('error', 'The call widget is not available.');
    showError(error.message);
  }
}

main();
