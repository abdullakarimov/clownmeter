import { getSettings, setSettings } from "../shared/settings.js";

const $ = (id) => document.getElementById(id);

async function refreshInfo() {
  const info = await chrome.runtime.sendMessage({ type: "clownmeter:info" });
  $("providers").replaceChildren(...info.providers.map(renderProvider));
  $("cached").textContent = String(info.cached);
}

function renderProvider(p) {
  const li = document.createElement("li");
  const name = document.createElement("code");
  name.textContent = p.label;
  li.append(name, ` ${p.model}`);

  const usage = document.createElement("span");
  usage.className = "usage";
  const parts = [`${p.today}${p.rpd ? `/${p.rpd}` : ""} today`];
  if (p.rpm) parts.push(`${p.minute}/${p.rpm} this minute`);
  usage.textContent = parts.join(" · ");
  if (p.nextAvailable) {
    const until = new Date(p.nextAvailable).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const limited = document.createElement("span");
    limited.className = "limited";
    limited.textContent = ` · paused until ${until}`;
    usage.append(limited);
  }
  li.append(usage);
  return li;
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
  setInterval(refreshInfo, 5000);
}

init();
