// Self-healing injector.
//
// Normally the browser injects content.js into every Pinterest page by itself
// (manifest "content_scripts"). That isn't always reliable: at browser start-up,
// tabs Brave restores can load before the extension's scripts are ready, and
// after a reload/update the open tabs keep a dead copy. In those cases the page
// stayed cluttered until you clicked "reload" in brave://extensions.
//
// The background script now does that for you. Whenever a Pinterest tab
// finishes loading or is switched to (and at start-up / install), it asks the
// tab "are you running?". If no live copy answers, it injects one.

const MATCHES = chrome.runtime.getManifest().content_scripts[0].matches;
const PINTEREST = /^https?:\/\/([^/]+\.)?pinterest\.(com|co\.uk|ca|com\.au|de|fr|es|it|nz|ph|jp|com\.mx)\//i;

async function isAlive(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "pd-status" }, { frameId: 0 });
    return !!(res && res.ok);
  } catch (e) {
    return false; // "Receiving end does not exist" => no live content script
  }
}

async function inject(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["defaults.js", "content.js"] });
}

const healing = new Set(); // tabs being checked right now (avoids double injection)

async function heal(tab) {
  if (!tab || tab.id == null || tab.discarded || !PINTEREST.test(tab.url || "")) return;
  if (healing.has(tab.id)) return;
  healing.add(tab.id);
  try {
    if (!(await isAlive(tab.id))) {
      await inject(tab.id);
      console.info("[Pinterest Declutter] injected into tab", tab.id, tab.url);
    }
  } catch (e) {
    // tab closed / mid-navigation / not scriptable: the next load event retries
  } finally {
    healing.delete(tab.id);
  }
}

async function healAll() {
  const tabs = await chrome.tabs.query({ url: MATCHES });
  await Promise.all(tabs.map(heal));
}

chrome.runtime.onInstalled.addListener(healAll);
chrome.runtime.onStartup.addListener(healAll);

// Pinterest keeps background requests open, so a tab can sit in status
// "loading" forever and never report "complete". So instead of waiting for
// that, check a few times after each navigation starts (each check is just a
// ping; a copy is injected only if nothing answers).
const timers = new Map(); // tabId -> pending timeouts
function healSoon(tabId, delays = [700, 2000, 5000]) {
  for (const t of timers.get(tabId) || []) clearTimeout(t);
  timers.set(tabId, delays.map((ms) => setTimeout(() => {
    chrome.tabs.get(tabId).then(heal, () => {});
  }, ms)));
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!PINTEREST.test(tab.url || "")) return;
  if (info.status === "loading") healSoon(tabId);
  else if (info.status === "complete") heal(tab);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(heal, () => {});
});

// v1.4.0 briefly zoomed the home feed tab (per-tab zoom). That was removed;
// put any tab it zoomed back to Brave's normal zoom for the site.
async function undoOldZoom() {
  const tabs = await chrome.tabs.query({ url: MATCHES });
  for (const tab of tabs) {
    try {
      const zs = await chrome.tabs.getZoomSettings(tab.id);
      if (zs.scope !== "per-tab") continue; // only this extension sets per-tab zoom here
      await chrome.tabs.setZoom(tab.id, 0); // 0 = default zoom
      await chrome.tabs.setZoomSettings(tab.id, { mode: "automatic", scope: "per-origin" });
    } catch (e) { /* tab gone */ }
  }
}
chrome.runtime.onInstalled.addListener(undoOldZoom);

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const t of timers.get(tabId) || []) clearTimeout(t);
  timers.delete(tabId);
});
