import { CATEGORIES } from "../shared/categories.js";
import { enabledCategories, getSettings } from "../shared/settings.js";
import { adapterForHost } from "./adapters.js";

const adapter = adapterForHost(location.hostname);
const GROUP_CLASS = "cm-badges";

let settings = { enabled: false, autoScan: false, categories: {} };
// post element -> { id, post, group, assessment, state, visible, retryTimer }
// assessment holds every category rated so far; state describes the request for the missing ones
// ("idle" | "loading" | "waiting" | "error").
const tracked = new WeakMap();

const missingCategories = (entry) => enabledCategories(settings).filter((id) => !entry.assessment[id]);

// ---- Badge rendering ----

function levelFor(score) {
  if (score < 25) return "low";
  if (score < 50) return "mid";
  if (score < 75) return "high";
  return "max";
}

const PENDING = {
  idle: { text: "?", title: () => "click to rate this post" },
  loading: { text: "…", title: () => "rating…" },
  waiting: { text: "⏳", title: (e) => `${e.error}\nRetrying around ${formatTime(e.retryAt)}. Click to try now.` },
  error: { text: "!", title: (e) => `${e.error}\nClick to retry.` },
};

function renderBadges(entry) {
  const badges = CATEGORIES.filter((c) => settings.categories?.[c.id]).map((category) => {
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = "cm-badge";
    badge.dataset.category = category.id;
    const rating = entry.assessment[category.id];
    if (rating) {
      badge.textContent = `${category.emoji} ${rating.score}`;
      badge.dataset.level = levelFor(rating.score);
      badge.title = `${category.label}: ${rating.score}/100\n${rating.why}\nClick for details.`;
    } else {
      const pending = PENDING[entry.state];
      badge.textContent = `${category.emoji} ${pending.text}`;
      badge.dataset.state = entry.state;
      badge.title = `Clownmeter ${category.label}: ${pending.title(entry)}`;
    }
    return badge;
  });
  entry.group.replaceChildren(...badges);
}

function createGroup(entry) {
  const group = document.createElement("span");
  group.className = GROUP_CLASS;
  // Posts are click-to-open on both sites; keep badge clicks from navigating.
  for (const type of ["click", "mousedown", "mouseup", "pointerdown", "pointerup"]) {
    group.addEventListener(type, (e) => {
      e.stopPropagation();
      if (type !== "click") return;
      e.preventDefault();
      const badge = e.target.closest(".cm-badge");
      if (badge) onBadgeClick(entry, badge);
    });
  }
  return group;
}

function onBadgeClick(entry, badge) {
  const category = badge.dataset.category;
  if (entry.assessment[category]) toggleDetails(entry, category, badge);
  else if (entry.state !== "loading") analyze(entry);
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// ---- Details popover ----

let openPopover = null;

function closeDetails() {
  openPopover?.remove();
  openPopover = null;
}

function toggleDetails(entry, categoryId, badge) {
  const key = `${entry.id}|${categoryId}`;
  const wasOpen = openPopover?.dataset.for === key;
  closeDetails();
  if (wasOpen) return;

  const category = CATEGORIES.find((c) => c.id === categoryId);
  const rating = entry.assessment[categoryId];
  const pop = el("div", "cm-popover");
  pop.dataset.for = key;

  const header = el("div", "cm-pop-header");
  header.append(el("span", "cm-pop-title", `${category.emoji} ${category.label}`), el("span", "cm-pop-score", String(rating.score)));
  const bar = el("div", "cm-pop-bar");
  const fill = el("div", "cm-pop-fill");
  fill.style.width = `${rating.score}%`;
  fill.dataset.level = levelFor(rating.score);
  bar.append(fill);
  pop.append(header, bar, el("p", "cm-pop-why", rating.why));
  if (rating.ratedBy) pop.append(el("p", "cm-pop-meta", `Rated by ${rating.ratedBy}`));
  pop.addEventListener("click", (e) => e.stopPropagation());

  document.body.append(pop);
  const rect = badge.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 8))}px`;
  const below = rect.bottom + 6;
  pop.style.top = below + pop.offsetHeight > window.innerHeight ? `${Math.max(8, rect.top - pop.offsetHeight - 6)}px` : `${below}px`;
  openPopover = pop;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

document.addEventListener("click", closeDetails);
window.addEventListener("scroll", closeDetails, { passive: true });
window.addEventListener("keydown", (e) => e.key === "Escape" && closeDetails());

// ---- Analysis ----

function maybeAutoAnalyze(entry) {
  if (entry.visible && settings.autoScan && entry.state === "idle" && missingCategories(entry).length) analyze(entry);
}

async function analyze(entry) {
  const categories = enabledCategories(settings);
  if (!categories.length) return;
  clearTimeout(entry.retryTimer);
  entry.state = "loading";
  renderBadges(entry);
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: "clownmeter:analyze", post: entry.post, categories });
  } catch {
    response = { ok: false, error: "Extension was reloaded — refresh the page." };
  }
  if (response?.ok) {
    entry.state = "idle";
    entry.assessment = { ...entry.assessment, ...response.assessment };
  } else if (response?.retryAt) {
    entry.state = "waiting";
    entry.error = response.error;
    entry.retryAt = response.retryAt;
    scheduleRetry(entry);
  } else {
    entry.state = "error";
    entry.error = response?.error ?? "No response from extension.";
  }
  renderBadges(entry);
  // Categories may have been switched on while this request was running.
  maybeAutoAnalyze(entry);
}

// When every provider is rate-limited, retry once a slot frees up — but only for posts still on screen.
// Off-screen ones go back to idle and get rated when scrolled to again.
function scheduleRetry(entry) {
  const jitter = Math.random() * 3000; // spread retries so they don't all hit the budget at once
  entry.retryTimer = setTimeout(() => {
    if (entry.state !== "waiting" || !entry.group.isConnected) return;
    entry.state = "idle";
    renderBadges(entry);
    maybeAutoAnalyze(entry);
  }, Math.max(1000, entry.retryAt - Date.now()) + jitter);
}

const visibility = new IntersectionObserver(
  (records) => {
    for (const record of records) {
      const entry = tracked.get(record.target);
      if (!entry) continue;
      entry.visible = record.isIntersecting;
      maybeAutoAnalyze(entry);
    }
  },
  { rootMargin: "300px 0px" },
);

// ---- Scanning ----

function scan() {
  if (!settings.enabled) return;
  for (const postEl of document.querySelectorAll(adapter.postSelector)) {
    let data;
    try {
      data = adapter.extract(postEl);
    } catch (err) {
      console.debug("Clownmeter: could not read post", err);
      continue;
    }
    const existing = tracked.get(postEl);
    if (existing && existing.id === data?.id && existing.group.isConnected) continue;
    if (existing) existing.group.remove();
    if (!data || (!data.text && !data.quote?.text)) {
      tracked.delete(postEl);
      continue;
    }

    const { anchor, ...post } = data;
    const reuse = existing?.id === post.id ? existing : null; // re-attaching after a disable/enable keeps ratings
    const entry = reuse ?? { id: post.id, post: { ...post, platform: adapter.platform }, assessment: {}, state: "idle" };
    entry.group = createGroup(entry);
    renderBadges(entry);
    anchor.after(entry.group);
    tracked.set(postEl, entry);
    visibility.unobserve(postEl);
    visibility.observe(postEl);
  }
}

function forEachEntry(fn) {
  for (const postEl of document.querySelectorAll(adapter.postSelector)) {
    const entry = tracked.get(postEl);
    if (entry?.group.isConnected) fn(entry);
  }
}

function removeAllBadges() {
  closeDetails();
  for (const group of document.querySelectorAll(`.${GROUP_CLASS}`)) group.remove();
}

let scanQueued = false;
const observer = new MutationObserver(() => {
  if (scanQueued) return;
  scanQueued = true;
  setTimeout(() => {
    scanQueued = false;
    scan();
  }, 250);
});

async function init() {
  settings = await getSettings();
  observer.observe(document.body, { childList: true, subtree: true });
  scan();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  for (const [key, { newValue }] of Object.entries(changes)) settings[key] = newValue;
  if (!settings.enabled) {
    removeAllBadges();
    return;
  }
  scan();
  if (changes.categories || changes.autoScan) {
    closeDetails();
    forEachEntry((entry) => {
      if (entry.state === "error") entry.state = "idle"; // give newly enabled categories a fresh try
      renderBadges(entry);
      maybeAutoAnalyze(entry);
    });
  }
});

init();
