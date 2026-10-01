import { getSettings } from "../shared/settings.js";
import { adapterForHost } from "./adapters.js";

const adapter = adapterForHost(location.hostname);
const BADGE_CLASS = "cm-badge";

let settings = { enabled: false, autoScan: false };
const tracked = new WeakMap(); // post element -> { id, badge, post, state }

// ---- Badge rendering ----

function levelFor(score) {
  if (score < 25) return "low";
  if (score < 50) return "mid";
  if (score < 75) return "high";
  return "max";
}

function renderBadge(entry) {
  const { badge, state, assessment, error } = entry;
  badge.dataset.state = state;
  delete badge.dataset.level;
  if (state === "idle") {
    badge.textContent = "🤡 ?";
    badge.title = "Clownmeter: click to rate this post";
  } else if (state === "loading") {
    badge.textContent = "🤡 …";
    badge.title = "Clownmeter: rating…";
  } else if (state === "error") {
    badge.textContent = "🤡 !";
    badge.title = `Clownmeter: ${error}\nClick to retry.`;
  } else {
    badge.textContent = `🤡 ${assessment.clown}`;
    badge.dataset.level = levelFor(assessment.clown);
    badge.title = `${assessment.verdict}\nBait ${assessment.bait} · Troll ${assessment.troll} · Dumb ${assessment.dumb}\nClick for details.`;
  }
}

function createBadge(entry) {
  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = BADGE_CLASS;
  // Posts are click-to-open on both sites; keep badge clicks from navigating.
  for (const type of ["click", "mousedown", "mouseup", "pointerdown", "pointerup"]) {
    badge.addEventListener(type, (e) => {
      e.stopPropagation();
      if (type === "click") {
        e.preventDefault();
        onBadgeClick(entry);
      }
    });
  }
  return badge;
}

function onBadgeClick(entry) {
  if (entry.state === "done") toggleDetails(entry);
  else if (entry.state !== "loading") analyze(entry);
}

// ---- Details popover ----

let openPopover = null;

function closeDetails() {
  openPopover?.remove();
  openPopover = null;
}

function toggleDetails(entry) {
  const wasOpenFor = openPopover?.dataset.for;
  closeDetails();
  if (wasOpenFor === entry.id) return;

  const { assessment } = entry;
  const pop = document.createElement("div");
  pop.className = "cm-popover";
  pop.dataset.for = entry.id;

  const header = el("div", "cm-pop-header");
  header.append(el("span", "cm-pop-score", `🤡 ${assessment.clown}`), el("span", "cm-pop-verdict", assessment.verdict));
  pop.append(header);
  for (const [label, key] of [["Bait", "bait"], ["Troll", "troll"], ["Dumb", "dumb"]]) {
    const row = el("div", "cm-pop-row");
    const bar = el("div", "cm-pop-bar");
    const fill = el("div", "cm-pop-fill");
    fill.style.width = `${assessment[key]}%`;
    fill.dataset.level = levelFor(assessment[key]);
    bar.append(fill);
    row.append(el("span", "cm-pop-label", label), bar, el("span", "cm-pop-num", String(assessment[key])));
    pop.append(row);
  }
  pop.append(el("p", "cm-pop-why", assessment.why));
  pop.addEventListener("click", (e) => e.stopPropagation());

  document.body.append(pop);
  const rect = entry.badge.getBoundingClientRect();
  const width = pop.offsetWidth;
  pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
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

async function analyze(entry) {
  entry.state = "loading";
  renderBadge(entry);
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: "clownmeter:analyze", post: entry.post });
  } catch {
    response = { ok: false, error: "Extension was reloaded — refresh the page." };
  }
  if (response?.ok) {
    entry.state = "done";
    entry.assessment = response.assessment;
  } else {
    entry.state = "error";
    entry.error = response?.error ?? "No response from extension.";
  }
  renderBadge(entry);
}

const visibility = new IntersectionObserver(
  (records) => {
    for (const record of records) {
      if (!record.isIntersecting) continue;
      const entry = tracked.get(record.target);
      if (entry && entry.state === "idle" && settings.autoScan) analyze(entry);
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
    if (existing && existing.id === data?.id && existing.badge.isConnected) continue;
    if (existing) existing.badge.remove();
    if (!data || (!data.text && !data.quote?.text)) {
      tracked.delete(postEl);
      continue;
    }

    const { anchor, ...post } = data;
    const entry = { id: post.id, post: { ...post, platform: adapter.platform }, state: "idle" };
    entry.badge = createBadge(entry);
    renderBadge(entry);
    anchor.after(entry.badge);
    tracked.set(postEl, entry);
    visibility.unobserve(postEl);
    visibility.observe(postEl);
  }
}

function removeAllBadges() {
  closeDetails();
  for (const badge of document.querySelectorAll(`.${BADGE_CLASS}`)) badge.remove();
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
  if (changes.autoScan?.newValue) {
    // Re-trigger the observer so posts already on screen get rated.
    for (const postEl of document.querySelectorAll(adapter.postSelector)) {
      visibility.unobserve(postEl);
      if (tracked.has(postEl)) visibility.observe(postEl);
    }
  }
});

init();
