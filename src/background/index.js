import { CATEGORY_IDS } from "../shared/categories.js";
import { PROVIDER_SETTINGS_KEY, getProviderSettings } from "../shared/providerSettings.js";
import { AssessmentError, assess, callProvider, createProviders, isUsable, resolveProviders } from "./llm.js";
import { ProviderError } from "./providers.js";

// Injected from .env by scripts/build.mjs.
const CONFIG = __CLOWNMETER_CONFIG__;
const providers = createProviders(CONFIG.providers);

// ---- Provider settings from the options page ----

let overridesPromise;

const loadOverrides = () => (overridesPromise ??= getProviderSettings());

async function currentProviders() {
  return resolveProviders(providers, await loadOverrides());
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[PROVIDER_SETTINGS_KEY]) return;
  const { oldValue = {}, newValue = {} } = changes[PROVIDER_SETTINGS_KEY];
  // Synchronous on purpose, so no request can run with a mix of old and new settings.
  overridesPromise = Promise.resolve(newValue);
  const before = resolveProviders(providers, oldValue);
  const after = resolveProviders(providers, newValue);
  // A new key means a fresh quota: drop usage counts and any cooldown from the old key's errors.
  after.forEach((p, i) => {
    if (p.apiKey !== before[i].apiKey || p.model !== before[i].model) p.budget.reset();
  });
});

const MAX_CONCURRENT = 3;
const CACHE_KEY = "assessmentCache.v3";
const CACHE_LIMIT = 1000;

// ---- Cache (persisted so a service-worker restart doesn't re-bill the same posts) ----

let cache; // Map<post key, { [category]: { score, why, ratedBy } }>, insertion-ordered for LRU trimming
let persistTimer;

async function loadCache() {
  if (!cache) {
    chrome.storage.local.remove(["assessmentCache", "assessmentCache.v2"]); // older cache formats
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
  return `${post.platform}|${post.id || hash(`${post.text}\u0000${post.quote?.text ?? ""}`)}`;
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

// Rates only the categories this post hasn't been rated on yet and merges them into its cache entry,
// so enabling another category later doesn't re-rate the ones already known.
async function analyze(post, categories) {
  const store = await loadCache();
  const key = cacheKey(post);
  const cached = store.get(key) ?? {};
  const missing = categories.filter((id) => !cached[id]);
  if (!missing.length) {
    store.delete(key);
    store.set(key, cached); // bump recency
    return cached;
  }

  const flightKey = `${key}|${missing.join(",")}`;
  if (!inFlight.has(flightKey)) {
    const promise = schedule(async () => assess(await currentProviders(), post, missing))
      .then((assessment) => {
        const merged = { ...store.get(key), ...assessment };
        store.delete(key);
        store.set(key, merged);
        persistCache();
        return merged;
      })
      .finally(() => inFlight.delete(flightKey));
    inFlight.set(flightKey, promise);
  }
  return inFlight.get(flightKey);
}

// ---- Provider test (options page) ----

const TEST_POST = {
  platform: "x",
  id: "",
  author: "Test (@test)",
  text: "The moon landing was faked — you can't even see the flag from Earth with binoculars. Do your own research!",
  quote: null,
  hasMedia: false,
};

// Tests the values currently typed in the options page, before they're saved. Bypasses the budget.
async function testProvider({ id, apiKey, model }) {
  const resolved = (await currentProviders()).find((p) => p.id === id);
  if (!resolved) return { ok: false, error: `Unknown provider: ${id}` };
  const base = providers.find((p) => p.base.id === id).base;
  const provider = { ...resolved, apiKey: apiKey || base.apiKey, model: model || base.model };
  if (!isUsable(provider)) return { ok: false, error: provider.model ? "No API key set." : "No model set." };
  try {
    const { dumb } = await callProvider(provider, TEST_POST, ["dumb"]);
    return { ok: true, model: provider.model, score: dumb.score, why: dumb.why };
  } catch (err) {
    return { ok: false, error: err instanceof ProviderError ? err.message : String(err) };
  }
}

// ---- Messaging ----

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "clownmeter:analyze") {
    const categories = CATEGORY_IDS.filter((id) => message.categories?.includes(id));
    analyze(message.post, categories).then(
      (assessment) => sendResponse({ ok: true, assessment }),
      (err) => {
        if (err instanceof AssessmentError) {
          sendResponse({ ok: false, error: err.message, retryAt: err.retryAt });
        } else {
          console.error("Clownmeter:", err);
          sendResponse({ ok: false, error: "Unexpected error — see the service worker console." });
        }
      },
    );
    return true; // async response
  }
  if (message?.type === "clownmeter:info") {
    Promise.all([loadCache(), currentProviders(), ...providers.map((p) => p.budget.load())]).then(([store, resolved]) =>
      sendResponse({
        cached: store.size,
        providers: resolved.map((p, i) => ({
          id: p.id,
          label: p.label,
          model: p.model,
          usable: isUsable(p),
          keySource: p.keySource,
          // Built-in (.env) values, shown as defaults in the options page. The key itself is never sent.
          defaults: { model: providers[i].base.model, rpm: providers[i].base.rpm, rpd: providers[i].base.rpd, hasKey: !!providers[i].base.apiKey },
          ...p.budget.snapshot(),
        })),
      }),
    );
    return true;
  }
  if (message?.type === "clownmeter:testProvider") {
    testProvider(message).then(sendResponse);
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
