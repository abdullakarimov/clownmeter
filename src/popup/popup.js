import { getSettings, setSettings } from "../shared/settings.js";

const $ = (id) => document.getElementById(id);

async function refreshInfo() {
  const info = await chrome.runtime.sendMessage({ type: "clownmeter:info" });
  $("model").textContent = `${info.provider} · ${info.model}`;
  $("cached").textContent = String(info.cached);
}

async function init() {
  const settings = await getSettings();
  for (const key of ["enabled", "autoScan"]) {
    $(key).checked = settings[key];
    $(key).addEventListener("change", (e) => setSettings({ [key]: e.target.checked }));
  }
  $("clear").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "clownmeter:clearCache" });
    refreshInfo();
  });
  refreshInfo();
}

init();
