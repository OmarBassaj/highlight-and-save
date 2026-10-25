// While saving is switched on in the popup, saves each text selection.

(() => {
// The background worker also adds this script to tabs that were already open,
// so skip it if a working copy is already running here. A copy left over from
// before the extension was reloaded can no longer reach it, so it doesn't count.
const isAlive = () => {
  try {
    return !!chrome.runtime.id;
  } catch {
    return false;
  }
};
if (window.__highlightAndSaveAlive && window.__highlightAndSaveAlive()) return;
window.__highlightAndSaveAlive = isAlive;

let savingOn = false;

chrome.storage.local.get("saving").then((data) => {
  savingOn = !!data.saving;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.saving) savingOn = !!changes.saving.newValue;
});

// The last text saved from this page, so releasing the mouse again while the
// same text is still selected (e.g. on the scrollbar) doesn't save it twice.
let lastSaved = "";

const saveSelection = () => {
  const text = window.getSelection().toString().trim();
  if (!text || text === lastSaved) return;
  lastSaved = text;

  try {
    chrome.runtime.sendMessage({ action: "saveHighlight", text }, () => {
      if (chrome.runtime.lastError) {
        console.error("Error saving highlight:", chrome.runtime.lastError);
      }
    });
  } catch (error) {
    console.error("Extension context invalidated:", error);
  }
};

// Listen on window in the capture phase, before the page sees the event: many
// sites stop mouseup from bubbling, which hid it from a listener on document.
// pointerup is there too because pages that cancel pointerdown get no mouseup;
// when both fire, the second finds the text already saved.
const onRelease = (e) => {
  // After the extension is reloaded this copy is cut off; stop listening so
  // only the new copy acts on the page
  if (!isAlive()) {
    window.removeEventListener("pointerup", onRelease, true);
    window.removeEventListener("mouseup", onRelease, true);
    return;
  }
  if (savingOn && e.button === 0) saveSelection(); // Left button only
};
window.addEventListener("pointerup", onRelease, true);
window.addEventListener("mouseup", onRelease, true);
})();
