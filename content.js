/* FocusTube – content script (runs on youtube.com)
 *
 * Owns the pause/resume state machine for this tab.
 *
 *   PRESENT ──away──▶ AWAY ──(delay)──▶ videos we paused are remembered
 *   AWAY ──return(confirmed by background)──▶ PRESENT ──▶ resume remembered videos
 *
 * Rules that keep it safe:
 *  - We only ever resume <video> elements that WE paused (autoPaused map).
 *  - Any pause/play we did not cause (user, keyboard, YouTube) forgets that video.
 *  - Resume needs the background worker to confirm "active tab in focused window";
 *    a bare focus/visibility event is never enough.
 *  - Resume is skipped if the video changed, ended, or was detached from the page.
 */
(() => {
  'use strict';
  if (window.__focusTubeLoaded) return;
  window.__focusTubeLoaded = true;

  const DEFAULTS = { enabled: true, delay: 0, autoResume: true, toasts: true };
  const VALID_DELAYS = [0, 1000, 3000, 5000];

  let settings = { ...DEFAULTS };
  let isAway = false;
  let pauseTimer = null;
  let endedWhileAway = false;
  const autoPaused = new Map();   // HTMLVideoElement -> page key when we paused it
  const expectedPause = new WeakSet(); // pauses we triggered (ignore their events)

  /* ---------- helpers ---------- */

  function alive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  function pageKey() {
    const u = new URL(location.href);
    if (u.pathname.startsWith('/shorts/')) return 'shorts:' + (u.pathname.split('/')[2] || '');
    if (u.pathname === '/watch') return 'watch:' + (u.searchParams.get('v') || '');
    return 'page:' + u.pathname;
  }

  function report(event) {
    if (!alive()) return;
    chrome.runtime
      .sendMessage({ type: 'stateChanged', autoPaused: autoPaused.size > 0, event })
      .catch(() => {});
  }

  async function confirmPresence() {
    if (!alive()) return false;
    try { return !!(await chrome.runtime.sendMessage({ type: 'checkPresence' })); }
    catch (_) { return false; }
  }

  /* ---------- on-page toast (shadow DOM so YouTube CSS can't touch it) ---------- */

  let toastHost = null;
  let toastTimer = null;
  function toast(text) {
    if (!settings.toasts || document.visibilityState !== 'visible') return;
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.style.cssText = 'all:initial;position:fixed;left:20px;bottom:24px;z-index:2147483647;pointer-events:none;';
      const root = toastHost.attachShadow({ mode: 'closed' });
      root.innerHTML =
        '<style>' +
        '.t{font:500 13px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#f2f2f6;' +
        'background:#17181d;border:1px solid rgba(255,255,255,.1);border-left:3px solid #8b5cf6;' +
        'padding:11px 14px;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.45);' +
        'opacity:0;transform:translateY(6px);transition:opacity .18s ease,transform .18s ease;}' +
        '.t.on{opacity:1;transform:none;}' +
        '@media (prefers-reduced-motion:reduce){.t{transition:none;}}' +
        '</style><div class="t" role="status"></div>';
      toastHost._el = root.querySelector('.t');
    }
    if (!toastHost.isConnected) document.documentElement.appendChild(toastHost);
    toastHost._el.textContent = text;
    requestAnimationFrame(() => toastHost._el.classList.add('on'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastHost._el.classList.remove('on');
      setTimeout(() => toastHost && toastHost.remove(), 250);
    }, 2200);
  }

  /* ---------- pause ---------- */

  function pausePlaying() {
    pauseTimer = null;
    if (!settings.enabled || !isAway) return;
    const key = pageKey();
    let paused = 0;
    for (const v of document.querySelectorAll('video')) {
      if (v.paused || v.ended || !v.isConnected) continue; // already paused by user => leave alone
      expectedPause.add(v);
      try {
        v.pause();
        if (!endedWhileAway) autoPaused.set(v, key); // a video that ended earlier never auto-resumes
        paused++;
      } catch (_) {
        expectedPause.delete(v);
      }
    }
    if (paused) {
      toast('Paused by FocusTube');
      report('paused');
    }
  }

  function onAway() {
    if (isAway) return; // idempotent: duplicate events are ignored
    isAway = true;
    clearTimeout(pauseTimer);
    pauseTimer = null;
    if (!settings.enabled) return;
    if (settings.delay === 0) pausePlaying();
    else pauseTimer = setTimeout(pausePlaying, settings.delay);
  }

  /* ---------- resume ---------- */

  function resumePaused() {
    if (autoPaused.size === 0) return;
    const entries = [...autoPaused];
    autoPaused.clear(); // clear first: whatever happens next, we are never stuck
    let resumed = 0;
    if (settings.autoResume) {
      const key = pageKey();
      for (const [v, k] of entries) {
        expectedPause.delete(v);
        if (!v.isConnected || k !== key || v.ended || !v.paused) continue;
        try {
          const p = v.play();
          if (p && p.catch) p.catch(() => {}); // e.g. autoplay policy – just give up quietly
          resumed++;
        } catch (_) {}
      }
    } else {
      for (const [v] of entries) expectedPause.delete(v);
    }
    if (resumed) toast('Resumed by FocusTube');
    report(resumed ? 'resumed' : 'cleared');
  }

  function onReturn() {
    if (document.visibilityState !== 'visible') return;
    isAway = false;
    clearTimeout(pauseTimer); // returned during the delay => never pause
    pauseTimer = null;
    resumePaused();
    endedWhileAway = false;
  }

  async function checkAndReturn() {
    if (!isAway && autoPaused.size === 0) return;
    if (!alive()) return teardown();
    if (await confirmPresence()) onReturn();
  }

  /* ---------- user / YouTube playback events (capture phase on document) ---------- */

  function onMediaEvent(e) {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement)) return;
    const hadState = autoPaused.size > 0;
    if (e.type === 'pause') {
      if (expectedPause.has(v)) { expectedPause.delete(v); return; } // our own pause
      autoPaused.delete(v); // someone else paused it => never override them
    } else if (e.type === 'play') {
      autoPaused.delete(v);
      expectedPause.delete(v);
    } else if (e.type === 'ended') {
      autoPaused.delete(v);
      if (isAway) endedWhileAway = true;
    }
    if (hadState && autoPaused.size === 0) report('cleared');
  }

  function onNavigate() {
    autoPaused.clear(); // different video => nothing to resume
    report('cleared');
  }

  /* ---------- page / extension events ---------- */

  function onVisibility() {
    if (document.visibilityState === 'hidden') onAway();
    else checkAndReturn();
  }
  function onWindowFocus() { checkAndReturn(); }

  function onMessage(msg, _sender, sendResponse) {
    if (!msg) return false;
    if (msg.type === 'focusaway') onAway();
    else if (msg.type === 'focusreturn') onReturn();
    else if (msg.type === 'getStatus') {
      sendResponse({ autoPaused: autoPaused.size > 0, isAway, hasVideo: !!document.querySelector('video') });
    }
    return false;
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    const wasEnabled = settings.enabled;
    for (const k of Object.keys(DEFAULTS)) if (changes[k]) settings[k] = changes[k].newValue;
    normalize();
    if (!settings.enabled) {
      clearTimeout(pauseTimer); // OFF takes effect immediately: no pending pause
      pauseTimer = null;
      if (wasEnabled && !isAway) resumePaused(); // user is here; don't leave anything paused
    }
  }

  function normalize() {
    settings.enabled = settings.enabled !== false;
    settings.autoResume = settings.autoResume !== false;
    settings.toasts = settings.toasts !== false;
    settings.delay = VALID_DELAYS.includes(settings.delay) ? settings.delay : 0;
  }

  /* If the extension is reloaded/updated this orphaned script must not leave a video paused. */
  function teardown() {
    clearTimeout(pauseTimer);
    for (const [v, k] of autoPaused) {
      if (v.isConnected && v.paused && !v.ended && k === pageKey() && document.visibilityState === 'visible') {
        v.play().catch(() => {});
      }
    }
    autoPaused.clear();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onWindowFocus);
    for (const t of ['pause', 'play', 'ended']) document.removeEventListener(t, onMediaEvent, true);
    document.removeEventListener('yt-navigate-start', onNavigate);
    window.__focusTubeLoaded = false;
  }

  /* ---------- init ---------- */

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onWindowFocus);
  for (const t of ['pause', 'play', 'ended']) document.addEventListener(t, onMediaEvent, true);
  document.addEventListener('yt-navigate-start', onNavigate);
  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);

  chrome.storage.local.get(DEFAULTS).then((s) => {
    settings = { ...DEFAULTS, ...s };
    normalize();
  }).catch(() => {});

  // Opened while Chrome isn't focused / tab isn't active? Start in AWAY so we don't mis-track.
  confirmPresence().then((present) => { if (!present && document.visibilityState === 'hidden') isAway = true; });
})();
