document.addEventListener("DOMContentLoaded", () => {
  const $ = (id) => document.getElementById(id);
  const highlightsList = $("highlights-list");
  const searchBar = $("search-bar");
  const clearSearchButton = $("clear-search");
  const emptyState = $("empty-state");
  const noMatches = $("no-matches");
  const countPill = $("count");
  const savingCard = $("saving-card");
  const savingToggle = $("saving-toggle");
  const savingLabel = $("saving-label");
  const savingHint = $("saving-hint");
  const menuButton = $("menu-button");
  const menu = $("menu");
  const toast = $("toast");
  const toastText = $("toast-text");
  const toastUndo = $("toast-undo");
  const savingShortcut = $("saving-shortcut");
  const siteBar = $("site-bar");
  const siteBarWrap = $("site-bar-wrap");
  const siteScrollLeft = $("site-scroll-left");
  const siteScrollRight = $("site-scroll-right");

  let highlights = []; // The full saved list, newest first, never just the search results
  let siteFilter = ""; // Hostname picked by clicking a site icon; "" shows all sites
  let draggedItem = null;
  const expanded = new Set(); // Ids of long highlights shown in full

  // All changes are made by the background worker, so they can't race each other
  const send = (message) =>
    chrome.runtime.sendMessage(message).catch((error) => console.error(error));

  const svg = (path) =>
    `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="${path}"/></svg>`;
  const ICONS = {
    info: svg("M11 7h2v2h-2zm0 4h2v6h-2zm1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z"),
    copy: svg("M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"),
    check: svg("M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"),
    trash: svg("M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"),
  };

  // Toast message at the bottom, with an optional Undo button
  let toastTimer = null;
  const hideToast = () => {
    clearTimeout(toastTimer);
    toast.hidden = true;
  };
  const showToast = (message, undo) => {
    toastText.textContent = message;
    toastUndo.hidden = !undo;
    toastUndo.onclick = () => {
      hideToast();
      undo();
    };
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, undo ? 6000 : 2200);
  };

  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

  const copyText = (text, message) =>
    navigator.clipboard.writeText(text).then(
      () => {
        showToast(message);
        return true;
      },
      (error) => {
        console.error("Copy failed:", error);
        showToast("Couldn't copy");
        return false;
      }
    );

  // Dates
  const DAY = 24 * 60 * 60 * 1000;
  const createdTime = (h) => h.createdAt || Date.parse(h.timestamp) || 0;
  const formatDate = (h) =>
    h.createdAt ? new Date(h.createdAt).toLocaleString() : h.timestamp || "Unknown";
  const startOfDay = (time) => new Date(time).setHours(0, 0, 0, 0);
  const dayGroup = (h) => {
    const time = createdTime(h);
    if (!time) return "Earlier";
    const days = Math.round((startOfDay(Date.now()) - startOfDay(time)) / DAY);
    if (days <= 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return "This week";
    return new Date(time).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  };

  // Source page
  const sourceUrl = (h) => h.pageUrl || h.url || "";
  const isOpenable = (url) => /^(https?|file):/.test(url); // Only open ordinary pages
  const hostname = (h) => {
    try {
      return new URL(sourceUrl(h)).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  };
  const sourceLabel = (h) => h.title || hostname(h);

  // Site icon: Chrome's cached favicon for the page, over the site's first
  // letter on a colour that's always the same for that site
  const ICON_COLORS = ["var(--yellow)", "var(--pink)", "var(--blue)", "var(--green)"];
  // Clicking it shows only that site's highlights (and clicking again shows all)
  const siteIcon = (h) => {
    const box = document.createElement("button");
    box.className = "site-icon";
    const host = hostname(h);
    let hash = 0;
    for (const char of host) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    box.style.setProperty("--icon-bg", ICON_COLORS[hash % ICON_COLORS.length]);
    box.textContent = (host[0] || "?").toUpperCase();
    if (host) {
      const label = siteFilter === host ? "Show all sites" : `Show only ${host}`;
      box.title = label;
      box.setAttribute("aria-label", label);
      box.addEventListener("click", () => setSiteFilter(siteFilter === host ? "" : host));
    } else {
      box.disabled = true; // Highlights from old versions have no source
    }

    const url = sourceUrl(h);
    if (/^https?:/.test(url)) {
      const src = new URL(chrome.runtime.getURL("/_favicon/"));
      src.searchParams.set("pageUrl", url);
      src.searchParams.set("size", "32");
      const img = document.createElement("img");
      img.alt = "";
      img.draggable = false;
      img.addEventListener("load", () => box.classList.add("has-image"));
      img.addEventListener("error", () => img.remove());
      img.src = src.href;
      box.append(img);
    }
    return box;
  };

  const closeInfoPopovers = () =>
    document.querySelectorAll(".info.open").forEach((el) => el.classList.remove("open"));

  const setMenuOpen = (open) => {
    menu.hidden = !open;
    menuButton.setAttribute("aria-expanded", String(open));
  };

  // Clicking outside a menu or info box closes it
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".info")) closeInfoPopovers();
    if (!e.target.closest(".menu-wrap")) setMenuOpen(false);
  });

  // Saving on/off switch
  const showSaving = (on) => {
    savingToggle.checked = on;
    savingCard.classList.toggle("on", on);
    savingLabel.textContent = on ? "Saving on" : "Saving off";
    savingHint.textContent = on
      ? "Select text on any page to save it"
      : "Turn on, then select text on any page";
  };
  savingToggle.addEventListener("change", () => {
    showSaving(savingToggle.checked);
    chrome.storage.local.set({ saving: savingToggle.checked });
  });
  chrome.storage.local.get("saving").then((data) => showSaving(!!data.saving));

  const visibleHighlights = () => {
    const query = searchBar.value.trim().toLowerCase();
    return highlights.filter(
      (h) =>
        (!siteFilter || hostname(h) === siteFilter) &&
        [h.text, h.title, sourceUrl(h)].some((field) => (field || "").toLowerCase().includes(query))
    );
  };

  const setSiteFilter = (host) => {
    siteFilter = host;
    closeInfoPopovers();
    renderHighlights();
  };

  // Row of site icons under the search bar: "All", then each site you've
  // saved from, most highlights first
  const renderSiteBar = () => {
    const sites = new Map(); // hostname → { count, sample highlight for the icon }
    highlights.forEach((h) => {
      const host = hostname(h);
      if (!host) return;
      const site = sites.get(host) || { count: 0, sample: h };
      site.count++;
      sites.set(host, site);
    });
    if (siteFilter && !sites.has(siteFilter)) siteFilter = ""; // Its last highlight was deleted

    const scroll = siteBar.scrollLeft;
    siteBar.innerHTML = "";
    siteBarWrap.hidden = sites.size < 2; // Nothing to choose between
    siteBar.classList.toggle("filtering", !!siteFilter);

    const all = document.createElement("button");
    all.className = "site-all";
    all.textContent = "All";
    all.title = `All sites · ${highlights.length}`;
    all.setAttribute("aria-pressed", String(!siteFilter));
    all.addEventListener("click", () => setSiteFilter(""));
    siteBar.append(all);

    [...sites]
      .sort(([a, x], [b, y]) => y.count - x.count || a.localeCompare(b))
      .forEach(([host, { count, sample }]) => {
        const button = siteIcon(sample); // Clicking it toggles the filter, as on a card
        button.title = `${host} · ${count}`;
        button.setAttribute("aria-pressed", String(siteFilter === host));
        siteBar.append(button);
      });
    siteBar.scrollLeft = scroll;
    updateSiteArrows();
  };

  // When the sites don't all fit, show an arrow (and fade the edge) on each
  // side that has more to scroll to
  const updateSiteArrows = () => {
    const more = siteBar.scrollWidth - siteBar.clientWidth;
    const atStart = siteBar.scrollLeft <= 1;
    const atEnd = siteBar.scrollLeft >= more - 1;
    siteScrollLeft.hidden = atStart;
    siteScrollRight.hidden = atEnd;
    siteBar.classList.toggle("fade-left", !atStart);
    siteBar.classList.toggle("fade-right", !atEnd);
  };
  siteBar.addEventListener("scroll", updateSiteArrows);
  siteScrollLeft.addEventListener("click", () =>
    siteBar.scrollBy({ left: -siteBar.clientWidth * 0.7, behavior: "smooth" })
  );
  siteScrollRight.addEventListener("click", () =>
    siteBar.scrollBy({ left: siteBar.clientWidth * 0.7, behavior: "smooth" })
  );

  // Scroll the site row sideways with an ordinary mouse wheel
  siteBar.addEventListener(
    "wheel",
    (e) => {
      if (!e.deltaY || e.deltaX) return;
      siteBar.scrollLeft += e.deltaY;
      e.preventDefault();
    },
    { passive: false }
  );

  // Show the shortcut the user actually has (they can change it at chrome://extensions/shortcuts)
  chrome.commands.getAll((commands) => {
    const command = commands.find((c) => c.name === "toggle-saving");
    if (!command || !command.shortcut) return;
    savingShortcut.textContent = `Shortcut: ${command.shortcut}`;
    savingShortcut.hidden = false;
  });

  // Delete with Undo
  const deleteHighlight = (highlight) => {
    const index = highlights.findIndex((h) => h.id === highlight.id);
    highlights = highlights.filter((h) => h.id !== highlight.id);
    renderHighlights();
    send({ action: "deleteHighlight", id: highlight.id });
    showToast("Highlight deleted", () =>
      send({ action: "restoreHighlights", entries: [{ highlight, index }] })
    );
  };

  const renderInfo = (highlight) => {
    // Shows the source page and save time on hover, or on click so it
    // stays open while you move to the link
    const info = document.createElement("div");
    info.className = "info";

    const button = document.createElement("button");
    button.className = "icon-button";
    button.title = "Source and time";
    button.setAttribute("aria-label", "Source and time");
    button.innerHTML = ICONS.info;
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = info.classList.contains("open");
      closeInfoPopovers();
      info.classList.toggle("open", !wasOpen);
    });

    const popover = document.createElement("div");
    popover.className = "info-popover";
    const url = sourceUrl(highlight);
    const label = sourceLabel(highlight);
    if (label && isOpenable(url)) {
      const heading = document.createElement("span");
      heading.className = "info-label";
      heading.textContent = "Saved from";
      const link = document.createElement("a");
      link.href = url;
      link.textContent = label;
      link.title = url;
      link.draggable = false;
      link.addEventListener("click", (e) => {
        e.preventDefault();
        chrome.tabs.create({ url });
      });
      popover.append(heading, link);
    }
    const timeHeading = document.createElement("span");
    timeHeading.className = "info-label";
    timeHeading.textContent = "Saved on";
    const time = document.createElement("span");
    time.textContent = formatDate(highlight);
    popover.append(timeHeading, time);

    info.append(button, popover);
    return info;
  };

  const renderItem = (highlight, group) => {
    const li = document.createElement("li");
    li.className = "card";
    li.draggable = true;
    li.dataset.id = highlight.id;
    li.dataset.group = group;
    li.addEventListener("dragstart", handleDragStart);
    li.addEventListener("dragend", handleDragEnd);

    const body = document.createElement("div");
    body.className = "card-body";

    const text = document.createElement("p");
    text.className = "card-text";
    text.textContent = highlight.text;
    text.classList.toggle("expanded", expanded.has(highlight.id));

    // Long highlights show three lines until expanded
    const more = document.createElement("button");
    more.className = "more-button";
    more.textContent = expanded.has(highlight.id) ? "Show less" : "Show more";
    more.addEventListener("click", () => {
      const open = !expanded.has(highlight.id);
      if (open) expanded.add(highlight.id);
      else expanded.delete(highlight.id);
      text.classList.toggle("expanded", open);
      more.textContent = open ? "Show less" : "Show more";
    });

    const copyButton = document.createElement("button");
    copyButton.className = "icon-button";
    copyButton.title = "Copy text";
    copyButton.setAttribute("aria-label", "Copy text");
    copyButton.innerHTML = ICONS.copy;
    copyButton.addEventListener("click", () => {
      copyText(highlight.text, "Copied to clipboard").then((ok) => {
        if (!ok) return;
        copyButton.innerHTML = ICONS.check;
        setTimeout(() => (copyButton.innerHTML = ICONS.copy), 1500);
      });
    });

    const deleteButton = document.createElement("button");
    deleteButton.className = "icon-button danger";
    deleteButton.title = "Delete";
    deleteButton.setAttribute("aria-label", "Delete");
    deleteButton.innerHTML = ICONS.trash;
    deleteButton.addEventListener("click", () => deleteHighlight(highlight));

    const actions = document.createElement("div");
    actions.className = "card-actions";
    actions.append(renderInfo(highlight), copyButton, deleteButton);

    const footer = document.createElement("div");
    footer.className = "card-footer";
    footer.append(more, actions);

    body.append(text, footer);
    li.append(siteIcon(highlight), body);
    return li;
  };

  // Render highlights, with a date header wherever the day changes
  const renderHighlights = () => {
    renderSiteBar();
    highlightsList.innerHTML = "";
    const visible = visibleHighlights();
    countPill.textContent = `${highlights.length} saved`;
    emptyState.hidden = highlights.length > 0;
    noMatches.hidden = highlights.length === 0 || visible.length > 0;
    const query = searchBar.value.trim();
    noMatches.textContent = query
      ? `No highlights match “${query}”${siteFilter ? ` on ${siteFilter}` : ""}`
      : `No highlights from ${siteFilter}`;

    let lastGroup = null;
    visible.forEach((highlight) => {
      const group = dayGroup(highlight);
      if (group !== lastGroup) {
        const header = document.createElement("li");
        header.className = "group-header";
        header.textContent = group;
        highlightsList.appendChild(header);
        lastGroup = group;
      }
      highlightsList.appendChild(renderItem(highlight, group));
    });

    // Only offer "Show more" on text that's actually cut off
    highlightsList.querySelectorAll(".card").forEach((li) => {
      const text = li.querySelector(".card-text");
      const more = li.querySelector(".more-button");
      more.hidden = !expanded.has(li.dataset.id) && text.scrollHeight <= text.clientHeight + 1;
    });
  };

  // Re-render whenever the list changes, including saves from open tabs
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.saving) showSaving(!!changes.saving.newValue);
    if (changes.highlights) {
      highlights = changes.highlights.newValue || [];
      if (!draggedItem) renderHighlights();
    }
  });

  // "More" menu
  menuButton.addEventListener("click", () => setMenuOpen(menu.hidden));

  $("copy-all").addEventListener("click", () => {
    setMenuOpen(false);
    if (!highlights.length) return showToast("Nothing to copy yet");
    copyText(
      highlights.map((h) => h.text).join("\n\n"),
      `Copied ${plural(highlights.length, "highlight")}`
    );
  });

  // Export: just the text, with a blank line between highlights
  $("export-highlights").addEventListener("click", () => {
    setMenuOpen(false);
    if (!highlights.length) return showToast("Nothing to export yet");
    const blob = new Blob([highlights.map((h) => h.text).join("\n\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "highlights.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); // Give the download time to start
    showToast(`Exported ${plural(highlights.length, "highlight")}`);
  });

  $("remove-duplicates").addEventListener("click", () => {
    setMenuOpen(false);
    // Work out what will go so it can be put back
    const seen = new Set();
    const removed = [];
    highlights.forEach((highlight, index) => {
      if (seen.has(highlight.text)) removed.push({ highlight, index });
      seen.add(highlight.text);
    });
    if (!removed.length) return showToast("No duplicates found");
    send({ action: "removeDuplicates" });
    showToast(`Removed ${plural(removed.length, "duplicate")}`, () =>
      send({ action: "restoreHighlights", entries: removed })
    );
  });

  $("clear-highlights").addEventListener("click", () => {
    setMenuOpen(false);
    if (!highlights.length) return showToast("Nothing to clear");
    const entries = highlights.map((highlight, index) => ({ highlight, index }));
    send({ action: "clearHighlights" });
    showToast(`Cleared ${plural(entries.length, "highlight")}`, () =>
      send({ action: "restoreHighlights", entries })
    );
  });

  // Search
  const onSearch = () => {
    clearSearchButton.hidden = !searchBar.value;
    renderHighlights();
  };
  searchBar.addEventListener("input", onSearch);
  clearSearchButton.addEventListener("click", () => {
    searchBar.value = "";
    onSearch();
    searchBar.focus();
  });

  // Keyboard: "/" jumps to search, Esc closes things or clears the search
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== searchBar) {
      e.preventDefault();
      searchBar.focus();
    } else if (e.key === "Escape") {
      if (!menu.hidden) {
        setMenuOpen(false);
        menuButton.focus();
      } else if (document.querySelector(".info.open")) {
        closeInfoPopovers();
      } else if (searchBar.value) {
        searchBar.value = "";
        onSearch();
      } else if (siteFilter) {
        setSiteFilter("");
      } else {
        return; // Let Escape close the popup
      }
      e.preventDefault();
    }
  });

  // Drag-and-drop functionality
  const handleDragStart = (e) => {
    draggedItem = e.currentTarget;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", draggedItem.dataset.id);
    draggedItem.classList.add("dragging");
    closeInfoPopovers();
  };

  // Move the dragged card as the pointer passes over the others, within the
  // same day only so the date headers stay right
  highlightsList.addEventListener("dragover", (e) => {
    if (!draggedItem) return;
    e.preventDefault();
    const target = e.target.closest(".card");
    if (target && target !== draggedItem && target.dataset.group === draggedItem.dataset.group) {
      const rect = target.getBoundingClientRect();
      const next = e.clientY > rect.top + rect.height / 2;
      highlightsList.insertBefore(draggedItem, next ? target.nextSibling : target);
    }
  });

  highlightsList.addEventListener("drop", (e) => e.preventDefault());

  // Save on dragend, which fires wherever the card is released
  const handleDragEnd = () => {
    draggedItem.classList.remove("dragging");
    draggedItem = null;

    // Put the visible cards in their new order into the slots they held in the
    // full list; highlights hidden by the search stay where they were.
    const visibleOrder = Array.from(highlightsList.querySelectorAll(".card"), (li) => li.dataset.id);
    const visibleIds = new Set(visibleOrder);
    let next = 0;
    const ids = highlights.map((h) => (visibleIds.has(h.id) ? visibleOrder[next++] : h.id));

    const byId = new Map(highlights.map((h) => [h.id, h]));
    highlights = ids.map((id) => byId.get(id));
    renderHighlights();
    send({ action: "reorderHighlights", ids });
  };

  // Initial load (also gives highlights from older versions an id)
  send({ action: "getHighlights" }).then((response) => {
    if (response && response.success) {
      highlights = response.result;
      renderHighlights();
    }
  });
});
