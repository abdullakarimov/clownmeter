import { AssessmentError, assess } from "./llm.js";

// Injected from .env by scripts/build.mjs.
const CONFIG = __CLOWNMETER_CONFIG__;

const MAX_CONCURRENT = 3;
const CACHE_KEY = "assessmentCache";
const CACHE_LIMIT = 1000;

// ---- Cache (persisted so a service-worker restart doesn't re-bill the same posts) ----

let cache; // Map<key, assessment>, insertion-ordered for LRU trimming
let persistTimer;

async function loadCache() {
  if (!cache) {
    const stored = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] ?? [];
    cache = new Map(stored);
  }
  return cache;
}

function persistCache() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    chrome.storage.local.set({ [CACHE_KEY]: [...cache] });
  }, 1000);
}

function cacheKey(post) {
  return `${CONFIG.model}|${post.platform}|${post.id || hash(`${post.text}\u0000${post.quote?.text ?? ""}`)}`;
}

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ---- Concurrency-limited queue with in-flight de-duplication ----

const inFlight = new Map();
const waiting = [];
let active = 0;

function schedule(task) {
  return new Promise((resolve, reject) => {
    waiting.push({ task, resolve, reject });
    pump();
  });
}

function pump() {
  while (active < MAX_CONCURRENT && waiting.length) {
    const { task, resolve, reject } = waiting.shift();
    active++;
    task()
      .then(resolve, reject)
      .finally(() => {
        active--;
        pump();
      });
  }
}

async function analyze(post) {
  const store = await loadCache();
  const key = cacheKey(post);
  if (store.has(key)) {
    const hit = store.get(key);
    store.delete(key);
    store.set(key, hit); // bump recency
    return hit;
  }
  if (!inFlight.has(key)) {
    const promise = schedule(() => assess(CONFIG, post))
      .then((assessment) => {
        store.set(key, assessment);
        persistCache();
        return assessment;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
  }
  return inFlight.get(key);
}

// ---- Messaging ----

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "clownmeter:analyze") {
    analyze(message.post).then(
      (assessment) => sendResponse({ ok: true, assessment }),
      (err) => {
        if (!(err instanceof AssessmentError)) console.error("Clownmeter:", err);
        sendResponse({ ok: false, error: err instanceof AssessmentError ? err.message : "Unexpected error — see the service worker console." });
      },
    );
    return true; // async response
  }
  if (message?.type === "clownmeter:info") {
    loadCache().then((store) =>
      sendResponse({ provider: CONFIG.provider, model: CONFIG.model, cached: store.size }),
    );
    return true;
  }
  if (message?.type === "clownmeter:clearCache") {
    loadCache().then((store) => {
      store.clear();
      chrome.storage.local.remove(CACHE_KEY).then(() => sendResponse({ ok: true }));
    });
    return true;
  }
  return false;
});
