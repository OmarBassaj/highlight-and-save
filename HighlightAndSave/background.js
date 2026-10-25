// Every change to the highlights list goes through this queue, so two requests
// arriving at the same time can't read the same list and overwrite each other.
let queue = Promise.resolve();

// Older versions saved highlights without an id; give them one.
const normalize = (highlights) =>
  highlights.map((h) => (h.id ? h : { ...h, id: crypto.randomUUID() }));

const updateHighlights = (mutate) => {
  const run = queue.then(async () => {
    const data = await chrome.storage.local.get(["highlights", "newestFirst"]);
    const list = normalize(data.highlights || []);
    // Before version 1.5 new highlights went at the end; now they go first
    if (!data.newestFirst) list.reverse();
    const highlights = mutate(list);
    await chrome.storage.local.set({ highlights, newestFirst: true });
    return highlights;
  });
  queue = run.catch(() => {});
  return run;
};

// Page addresses are stored without the #fragment
const stripHash = (url) => (url || "").split("#")[0];

const saveHighlight = (fields) => {
  const highlight = { id: crypto.randomUUID(), createdAt: Date.now(), ...fields };
  return updateHighlights((highlights) => [highlight, ...highlights]).then(() => highlight);
};

// Changes the popup can ask for
const popupHandlers = {
  getHighlights: () => (highlights) => highlights,
  deleteHighlight: ({ id }) => (highlights) => highlights.filter((h) => h.id !== id),
  clearHighlights: () => () => [],
  removeDuplicates: () => (highlights) =>
    highlights.filter(
      (highlight, index, self) => index === self.findIndex((h) => h.text === highlight.text)
    ),
  reorderHighlights: ({ ids }) => (highlights) => {
    const byId = new Map(highlights.map((h) => [h.id, h]));
    const reordered = ids.filter((id) => byId.has(id)).map((id) => byId.get(id));
    // Anything saved after the popup built its list of ids is newest, so it goes first
    const rest = highlights.filter((h) => !ids.includes(h.id));
    return [...rest, ...reordered];
  },
  // Undo: put deleted highlights back where they were
  restoreHighlights: ({ entries }) => (highlights) => {
    if (!Array.isArray(entries)) return highlights;
    const result = [...highlights];
    const present = new Set(result.map((h) => h.id));
    [...entries]
      .sort((a, b) => a.index - b.index)
      .forEach(({ highlight, index }) => {
        if (!highlight || typeof highlight.text !== "string" || present.has(highlight.id)) return;
        result.splice(Math.min(Math.max(0, index), result.length), 0, highlight);
        present.add(highlight.id);
      });
    return result;
  },
};

// Web pages (through the content script) may only save, and the page's
// address and title come from Chrome rather than from the message.
const handleTabMessage = (message, sender) => {
  if (message.action !== "saveHighlight") return null;
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!text) return null;
  return saveHighlight({
    text,
    url: stripHash(sender.url),
    pageUrl: sender.tab.url,
    title: sender.tab.title,
  });
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let result;
  // The extension's own pages (the popup, even when opened in a tab) have an
  // address inside the extension; anything else is a web page's content script.
  const fromExtensionPage = (sender.url || "").startsWith(chrome.runtime.getURL(""));
  if (!fromExtensionPage) {
    if (!sender.tab) return;
    result = handleTabMessage(message, sender);
  } else {
    const handler = popupHandlers[message.action];
    result = handler && updateHighlights(handler(message));
  }
  if (!result) return;

  result
    .then((value) => sendResponse({ success: true, result: value }))
    .catch((error) => sendResponse({ success: false, error: error.message }));
  return true; // Required for async sendResponse
});

// Chrome only adds content scripts to pages loaded after the extension was
// installed or reloaded. Add them to the tabs that were already open, so
// saving works there without reloading each tab. content.js skips itself if a
// working copy is already running.
const injectIntoOpenTabs = async () => {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    // Fails on pages extensions can't touch (chrome://, the Web Store); skip those
    chrome.scripting
      .executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] })
      .catch(() => {});
  }
};

chrome.runtime.onInstalled.addListener(injectIntoOpenTabs);

// Saving always starts off when Chrome starts, so it isn't left on by mistake
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.set({ saving: false });
});

// Keyboard shortcut (Alt+Shift+S by default) switches saving on and off
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-saving") return;
  const { saving } = await chrome.storage.local.get("saving");
  await chrome.storage.local.set({ saving: !saving });
});

// Badge: while saving is on, a soft grey badge with the number of highlights
// (0 included, so you can see saving is on); while it's off, nothing.
// The tooltip says the same in words.
const updateBadge = ({ highlights, saving }) => {
  const count = (highlights || []).length;
  chrome.action.setBadgeText({ text: saving ? count.toString() : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#E9EEF3" });
  chrome.action.setBadgeTextColor({ color: "#3A4450" });
  chrome.action.setTitle({
    title: `Highlight & Save: saving ${saving ? "on" : "off"} · ${count} saved`,
  });
};

const refreshBadge = () =>
  chrome.storage.local.get(["highlights", "saving"]).then(updateBadge);

// Keep the badge in sync with whatever changes the list or the switch
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.highlights || changes.saving)) refreshBadge();
  // Turning saving on also covers tabs opened before the extension was enabled
  if (area === "local" && changes.saving && changes.saving.newValue) injectIntoOpenTabs();
});

// Chrome doesn't keep badge text across restarts, so set it whenever the worker starts
refreshBadge();
