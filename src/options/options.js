import { getProviderSettings, setProviderSettings } from "../shared/providerSettings.js";

const KEY_LINKS = {
  gemini: "https://aistudio.google.com/apikey",
  groq: "https://console.groq.com/keys",
  openai: "https://platform.openai.com/api-keys",
};

const cards = new Map(); // provider id -> card element

function field(card, name) {
  return card.querySelector(`[name="${name}"]`);
}

function statusText(provider, keyValue) {
  if (keyValue) return { text: "Using your key", kind: "options" };
  if (provider.defaults.hasKey) return { text: "Using built-in key", kind: "env" };
  return { text: "No key — provider skipped", kind: "none" };
}

function renderCard(provider, index, total, saved) {
  const card = document.getElementById("provider-template").content.firstElementChild.cloneNode(true);
  card.querySelector(".order").textContent = `${index + 1}.`;
  card.querySelector(".name").textContent = provider.label;
  card.querySelector(".role").textContent =
    index === 0 ? (total > 1 ? "Primary provider." : "Only provider.") : "Fallback — used when the providers above are rate-limited or failing.";

  const link = card.querySelector(".key-link");
  if (KEY_LINKS[provider.id]) {
    link.href = KEY_LINKS[provider.id];
    link.hidden = false;
  }

  const { defaults } = provider;
  const apiKey = field(card, "apiKey");
  apiKey.placeholder = defaults.hasKey ? "Using the built-in key from .env" : "Paste your API key";
  apiKey.value = saved.apiKey ?? "";
  field(card, "model").placeholder = defaults.model || "Model id";
  field(card, "model").value = saved.model ?? "";
  field(card, "rpm").placeholder = defaults.rpm ? String(defaults.rpm) : "No limit";
  field(card, "rpm").value = saved.rpm ?? "";
  field(card, "rpd").placeholder = defaults.rpd ? String(defaults.rpd) : "No limit";
  field(card, "rpd").value = saved.rpd ?? "";

  const status = card.querySelector(".status");
  const updateStatus = () => {
    const { text, kind } = statusText(provider, apiKey.value.trim());
    status.textContent = text;
    status.dataset.kind = kind;
  };
  apiKey.addEventListener("input", updateStatus);
  updateStatus();

  const reveal = card.querySelector(".reveal");
  reveal.addEventListener("click", () => {
    const hidden = apiKey.type === "password";
    apiKey.type = hidden ? "text" : "password";
    reveal.textContent = hidden ? "Hide" : "Show";
  });

  const testButton = card.querySelector(".test-button");
  const result = card.querySelector(".result");
  testButton.addEventListener("click", async () => {
    testButton.disabled = true;
    result.removeAttribute("data-ok");
    result.textContent = "Sending a test post…";
    const response = await chrome.runtime.sendMessage({
      type: "clownmeter:testProvider",
      id: provider.id,
      apiKey: apiKey.value.trim(),
      model: field(card, "model").value.trim(),
    });
    testButton.disabled = false;
    result.dataset.ok = String(response.ok);
    result.textContent = response.ok
      ? `Works — ${response.model} rated the test post 🤡 ${response.score}: “${response.why}”`
      : `Failed: ${response.error}`;
  });

  cards.set(provider.id, card);
  return card;
}

function readCard(card) {
  const values = {};
  const text = (name) => field(card, name).value.trim();
  if (text("apiKey")) values.apiKey = text("apiKey");
  if (text("model")) values.model = text("model");
  for (const name of ["rpm", "rpd"]) {
    if (text(name) !== "") values[name] = Math.max(0, Math.floor(Number(text(name))) || 0);
  }
  return values;
}

async function init() {
  const [info, saved] = await Promise.all([chrome.runtime.sendMessage({ type: "clownmeter:info" }), getProviderSettings()]);
  const container = document.getElementById("providers");
  info.providers.forEach((provider, i) => container.append(renderCard(provider, i, info.providers.length, saved[provider.id] ?? {})));

  const savedNote = document.getElementById("saved");
  document.getElementById("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const current = await getProviderSettings();
    for (const [id, card] of cards) {
      const values = readCard(card);
      if (Object.keys(values).length) current[id] = values;
      else delete current[id];
    }
    await setProviderSettings(current);
    savedNote.hidden = false;
    setTimeout(() => (savedNote.hidden = true), 2500);
  });
}

init();
