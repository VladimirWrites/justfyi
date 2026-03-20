/**
 * JustFYI Background Service Worker
 * Handles: local ratings lookup, tab badge updates, submission relay.
 */

const API_BASE = "https://justfyi-api.YOUR_SUBDOMAIN.workers.dev";

// ─── URL Normalization (keep in sync with worker/src/index.js) ───
// Two-part public suffixes — everything before the eTLD+1 is stripped.
// Expand as needed; anything not listed falls back to last-two-parts.
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk",
  "co.jp", "ne.jp", "or.jp", "ac.jp",
  "co.kr", "co.in", "co.id", "co.il", "co.nz", "co.za", "co.th",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "com.ar", "com.be", "com.br", "com.cn", "com.co", "com.hk", "com.mx",
  "com.my", "com.pe", "com.ph", "com.pk", "com.sg", "com.tr", "com.tw",
  "com.uy", "com.ve",
]);

function normalizeUrl(url) {
  let host = url.trim().toLowerCase();
  host = host.replace(/^https?:\/\//, "");
  const endIdx = host.search(/[/?#:]/);
  if (endIdx !== -1) host = host.substring(0, endIdx);

  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(last2) ? parts.slice(-3).join(".") : last2;
}

// ─── Icon + badge config ───
const STATUS_ICONS = {
  1: "free",
  2: "limits",
  3: "paid",
};

// ─── Install handler: load bundled ratings ───
chrome.runtime.onInstalled.addListener(async () => {
  await loadBundledRatings();
});

// Reload bundled ratings whenever the extension version changes.
async function loadBundledRatings() {
  try {
    const currentVersion = chrome.runtime.getManifest().version;
    const { loadedBundleVersion, ratings } = await chrome.storage.local.get(["loadedBundleVersion", "ratings"]);
    if (ratings && ratings.length > 0 && loadedBundleVersion === currentVersion) return;

    const url = chrome.runtime.getURL("data/ratings.json");
    const response = await fetch(url);
    const bundled = await response.json();
    await storeRatings(bundled);
    await chrome.storage.local.set({ loadedBundleVersion: currentVersion });
  } catch (e) {
    console.error("JustFYI: Failed to load bundled ratings", e);
  }
}

// ─── Store ratings array + build O(1) lookup map ───
async function storeRatings(ratings) {
  const ratingsMap = {};
  for (const entry of ratings) {
    ratingsMap[entry.d] = entry;
  }
  await chrome.storage.local.set({ ratings, ratingsMap });
}

// ─── Tab change handler ───
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url) await updateBadgeForUrl(tab.url, activeInfo.tabId);
  } catch (e) {
    // Tab may not exist anymore
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    await updateBadgeForUrl(tab.url, tabId);
  }
});

// ─── Icon + badge update ───
function getIconPaths(name) {
  return {
    16: `icons/${name}16.png`,
    48: `icons/${name}48.png`,
    128: `icons/${name}128.png`,
  };
}

async function resetBadge(tabId) {
  await chrome.action.setIcon({ path: getIconPaths("default"), tabId });
  await chrome.action.setBadgeText({ text: "", tabId });
}

async function updateBadgeForUrl(url, tabId) {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return resetBadge(tabId);
  }

  const rating = await lookupRating(normalizeUrl(url));

  // Out of scope (e.g. amazon.com) — explicit "not a tool" verdict, stay neutral.
  if (rating && rating.s === 0) {
    return resetBadge(tabId);
  }

  // No entry at all — show the unrated indicator so the user knows they can help.
  if (!rating) {
    await chrome.action.setIcon({ path: getIconPaths("unrated"), tabId });
    await chrome.action.setBadgeText({ text: "", tabId });
    return;
  }

  // Abandoned overrides the money-axis icon — "don't use this" is the louder signal.
  const iconName = rating.ab ? "abandoned" : (STATUS_ICONS[rating.s] || "default");
  await chrome.action.setIcon({ path: getIconPaths(iconName), tabId });

  // The toolbar badge is dropped — Chrome composites badge backgrounds as
  // effectively opaque, which obscures the status icon. OS status is shown
  // in the popup instead.
  await chrome.action.setBadgeText({ text: "", tabId });
}

// ─── Local lookup by domain ───
async function lookupRating(domain) {
  const { ratingsMap = {} } = await chrome.storage.local.get("ratingsMap");
  return ratingsMap[domain] || null;
}

// ─── API POST helpers (called from popup) ───
async function postJson(path, data) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || "Request failed");
  }

  return await response.json();
}

// ─── Message handler for popup communication ───
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "getRating") {
    (async () => {
      const domain = normalizeUrl(message.url);
      const { ratingsMap = {}, ratings = [] } = await chrome.storage.local.get(["ratingsMap", "ratings"]);
      sendResponse({ rating: ratingsMap[domain] || null, domain, allRatings: ratings });
    })();
    return true;
  }

  if (message.type === "submitRating") {
    postJson("/submitRating", message.data)
      .then((result) => sendResponse({ success: true, result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "subscribeEmail") {
    postJson("/subscribe", { email: message.email })
      .then((result) => sendResponse({ success: true, result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});
