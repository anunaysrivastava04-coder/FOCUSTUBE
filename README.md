# FOCUSTUBE

FocusTube – Smart YouTube Auto Pause
Pauses YouTube when you switch away (another tab, VS Code, another app, minimised Chrome) and resumes only the video FocusTube paused when you come back. Developed by Anunay Srivastava · GitHub · Instagram · LinkedIn

Install (local)
Save/unzip this folder (it must contain manifest.json).
Open chrome://extensions.
Turn on Developer mode (top right).
Click Load unpacked and select the focustube folder.
Reload any YouTube tabs that were already open (content scripts attach on page load).
Play a video, then switch to VS Code. It pauses. Switch back to Chrome. It resumes.
Files
File	Role
manifest.json	MV3 config. Permissions: storage only. Host access: youtube.com
background.js	Stateless service worker. Watches windows.onFocusChanged and tabs.onActivated, decides "is a YouTube tab the active tab of the focused window?" and tells each YouTube tab focusaway / focusreturn
content.js	Per-tab state machine. Pauses/resumes <video> elements, tracks which ones it paused, handles SPA navigation and Shorts, shows the small on-page notice
popup.html/css/js	Popup UI: toggle, live status, delay, settings, footer links
icons/	16/32/48/128 PNGs + icon.svg source
How the logic works
Away = tab hidden (visibilitychange) or background reports Chrome lost OS focus / another tab or window is active. Pausing happens after the configured delay; duplicate away events are ignored.
Return = the background worker confirms the tab is active in the focused window. A bare focus event alone never resumes anything.
Resume rules: only videos FocusTube paused; same video (watch id / short id) as when paused; still in the page; not ended; not touched by the user since. Any pause/play that FocusTube didn't cause forgets that video.
Never stuck: state is cleared before resuming, on navigation, on tab close, when Resume is turned off, and if the extension is reloaded the orphaned script releases what it paused.
Multiple tabs/windows: each tab keeps its own state; only the active tab of the focused window counts as present.
Popup: while open it holds a port to the service worker so opening the popup is not mistaken for leaving YouTube.
Settings (chrome.storage.local)
enabled, delay (0 / 1000 / 3000 / 5000 ms), autoResume, toasts. Changes apply instantly to open tabs.

Privacy
No analytics, telemetry, network requests, backend or data collection. Settings never leave your browser.

Notes
Turning Auto Pause OFF cancels any pending pause immediately. A video paused in another tab still resumes when you return to that tab (if Resume is on), so nothing stays stuck.
Embedded YouTube players on other websites are not affected.
