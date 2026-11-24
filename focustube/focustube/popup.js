'use strict';

const DEFAULTS = { enabled: true, delay: 0, autoResume: true, toasts: true };
const YT_MATCHES = ['https://www.youtube.com/*', 'https://youtube.com/*'];
let settings = { ...DEFAULTS };

const $ = (id) => document.getElementById(id);
const els = {
  enabled: $('sw-enabled'), autoResume: $('sw-autoResume'), toasts: $('sw-toasts'),
  enabledState: $('enabled-state'), dot: $('dot'),
  title: $('status-title'), detail: $('status-detail'),
  delay: $('delay'), toast: $('toast'),
};

/* ---------- toast ---------- */
let toastTimer = null;
function showToast(text) {
  els.toast.textContent = text;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1800);
}

/* ---------- render ---------- */
function setSwitch(btn, on) { btn.setAttribute('aria-checked', String(on)); }

function render() {
  setSwitch(els.enabled, settings.enabled);
  setSwitch(els.autoResume, settings.autoResume);
  setSwitch(els.toasts, settings.toasts);
  els.enabledState.textContent = settings.enabled ? 'On' : 'Off';
  const radios = [...els.delay.querySelectorAll('[role="radio"]')];
  const active = radios.find((r) => Number(r.dataset.delay) === settings.delay) || radios[0];
  for (const r of radios) {
    const on = r === active;
    r.setAttribute('aria-checked', String(on));
    r.tabIndex = on ? 0 : -1;
  }
}

function renderStatus(state, detail) {
  const titles = {
    watching: 'Watching YouTube',
    auto: 'Video paused automatically',
    waiting: 'Waiting for YouTube',
    disabled: 'Feature disabled',
  };
  els.dot.className = 'dot ' + state;
  els.title.textContent = titles[state];
  els.detail.textContent = detail;
}

async function refreshStatus() {
  if (!settings.enabled) return renderStatus('disabled', 'Turn Auto Pause on to start.');
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: YT_MATCHES }); } catch (_) {}
  if (!tabs.length) return renderStatus('waiting', 'Open a YouTube tab to get started.');
  const replies = await Promise.all(
    tabs.map((t) => chrome.tabs.sendMessage(t.id, { type: 'getStatus' }).catch(() => null))
  );
  const ready = replies.filter(Boolean);
  if (!ready.length) return renderStatus('waiting', 'Reload your YouTube tab to activate FocusTube.');
  if (ready.some((r) => r.autoPaused)) return renderStatus('auto', 'Will resume when you return to it.');
  const n = ready.length;
  renderStatus('watching', n === 1 ? '1 YouTube tab monitored.' : n + ' YouTube tabs monitored.');
}

/* ---------- settings ---------- */
async function save(patch, message) {
  settings = { ...settings, ...patch };
  render();
  try { await chrome.storage.local.set(patch); } catch (_) { showToast('Could not save setting'); return; }
  if (message) showToast(message);
  refreshStatus();
}

function wireSwitch(btn, key, onMsg, offMsg) {
  btn.addEventListener('click', () => {
    const next = !settings[key];
    save({ [key]: next }, next ? onMsg : offMsg);
  });
}

function wireDelay() {
  const radios = [...els.delay.querySelectorAll('[role="radio"]')];
  const label = { 0: 'Pauses instantly', 1000: 'Pauses after 1 second', 3000: 'Pauses after 3 seconds', 5000: 'Pauses after 5 seconds' };
  const choose = (r) => { save({ delay: Number(r.dataset.delay) }, label[r.dataset.delay]); r.focus(); };
  radios.forEach((r, i) => {
    r.addEventListener('click', () => choose(r));
    r.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      choose(radios[(i + step + radios.length) % radios.length]);
    });
  });
}

/* ---------- init ---------- */
async function init() {
  try {
    const stored = await chrome.storage.local.get(DEFAULTS);
    settings = { ...DEFAULTS, ...stored };
  } catch (_) {}
  render();
  wireSwitch(els.enabled, 'enabled', 'Auto Pause on', 'Auto Pause off');
  wireSwitch(els.autoResume, 'autoResume', 'Resume on', 'Resume off');
  wireSwitch(els.toasts, 'toasts', 'On-page notices on', 'On-page notices off');
  wireDelay();
  refreshStatus();

  // Tell the service worker the popup is open so it doesn't treat popup focus as "leaving YouTube".
  try { chrome.runtime.connect({ name: 'focustube-popup' }); } catch (_) {}

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'stateChanged') return;
    if (msg.event === 'paused') showToast('Video paused automatically');
    else if (msg.event === 'resumed') showToast('Video resumed');
    refreshStatus();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const k of Object.keys(DEFAULTS)) if (changes[k]) settings[k] = changes[k].newValue;
    render();
    refreshStatus();
  });
}
init();
