/* FocusTube – background service worker (Manifest V3)
 *
 * Job: be the single source of truth for "is the user present on a YouTube tab?".
 * It is stateless on purpose (a service worker can be killed at any time): every
 * decision is re-derived from chrome.windows / chrome.tabs, never from memory.
 *
 * It tells each YouTube tab one of two things:
 *   focusaway   – the tab is not the active tab of the focused Chrome window
 *   focusreturn – the tab IS the active tab of the focused Chrome window
 * The content script owns all pause/resume decisions.
 */
'use strict';

const YT_MATCHES = ['https://www.youtube.com/*', 'https://youtube.com/*'];
const DEFAULTS = { enabled: true, delay: 0, autoResume: true, toasts: true };
const SYNC_DEBOUNCE_MS = 40;

let syncTimer = null;
let syncSeq = 0;
let popupPorts = 0; // opening the popup can steal window focus; ignore that

/* ---------- presence ---------- */

async function getFocusedWindowId() {
  try {
    const win = await chrome.windows.getLastFocused();
    return win && win.focused ? win.id : null; // null => OS focus is outside Chrome
  } catch (_) {
    return null;
  }
}

async function isTabPresent(tabId) {
  try {
    const [tab, focusedId] = await Promise.all([chrome.tabs.get(tabId), getFocusedWindowId()]);
    if (popupPorts > 0) return !!tab.active;
    return focusedId !== null && tab.windowId === focusedId && tab.active;
  } catch (_) {
    return false;
  }
}

function notify(tabId, type) {
  chrome.tabs.sendMessage(tabId, { type }).catch(() => {
    /* tab has no content script yet (not reloaded) or was closed – ignore */
  });
}

async function sync() {
  if (popupPorts > 0) return;
  const seq = ++syncSeq;
  const focusedId = await getFocusedWindowId();
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: YT_MATCHES });
  } catch (_) {
    return;
  }
  if (seq !== syncSeq) return; // a newer sync superseded this one (race guard)
  for (const tab of tabs) {
    const present = focusedId !== null && tab.windowId === focusedId && tab.active;
    notify(tab.id, present ? 'focusreturn' : 'focusaway');
  }
}

function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, SYNC_DEBOUNCE_MS);
}

/* ---------- listeners (registered synchronously so restarts work) ---------- */

chrome.windows.onFocusChanged.addListener(scheduleSync); // VS Code, other apps, minimise
chrome.tabs.onActivated.addListener(scheduleSync);       // tab switching
chrome.tabs.onDetached.addListener(scheduleSync);        // tab dragged to another window

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'checkPresence' && sender.tab) {
    isTabPresent(sender.tab.id).then(sendResponse);
    return true; // async response
  }
  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'focustube-popup') return;
  popupPorts++;
  port.onDisconnect.addListener(() => {
    popupPorts = Math.max(0, popupPorts - 1);
    scheduleSync();
  });
});

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(null);
  const missing = {};
  for (const k of Object.keys(DEFAULTS)) if (!(k in stored)) missing[k] = DEFAULTS[k];
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
});
