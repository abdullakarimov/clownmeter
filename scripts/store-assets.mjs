// Renders the Chrome Web Store images from store/src/*.html into store/*.png with headless Chrome.
// The popup and options page in the screenshots are the real built pages, fed sample data by a mock
// `chrome` API (no keys, no network). Set CHROME_PATH if Chrome isn't in a standard location.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "store", "src");
const outDir = path.join(root, "store");
const buildDir = path.join(root, "release", "store-build");

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error("Chrome not found. Set CHROME_PATH to your Chrome/Chromium binary.");
  process.exit(1);
}

// ---- 1. Build the extension and create mocked popup/options pages ----

execFileSync(process.execPath, [path.join(root, "scripts/build.mjs"), "--no-keys", `--out=${buildDir}`], { stdio: "inherit" });

const MOCK_CHROME = `
const demoProviders = [
  { id: "gemini", label: "Gemini", model: "gemini-3.5-flash-lite", usable: true, keySource: "options",
    defaults: { model: "gemini-3.5-flash-lite", rpm: 10, rpd: 500, hasKey: false },
    minute: 4, rpm: 10, today: 137, rpd: 500, nextAvailable: 0 },
  { id: "groq", label: "Groq", model: "openai/gpt-oss-120b", usable: true, keySource: "options",
    defaults: { model: "openai/gpt-oss-120b", rpm: 0, rpd: 0, hasKey: false },
    minute: 0, rpm: 0, today: 22, rpd: 0, nextAvailable: 0 },
];
window.chrome = {
  storage: {
    sync: {
      get: async (defaults) => ({ ...defaults, categories: { bait: true, troll: true, dumb: true, slop: true } }),
      set: async () => {},
    },
    local: {
      get: async () => ({ providerSettings: { gemini: { apiKey: "demo-key-not-real-0123456789" }, groq: { apiKey: "demo-key-not-real-9876543210" } } }),
      set: async () => {},
    },
  },
  runtime: {
    openOptionsPage: () => {},
    sendMessage: async (message) => {
      if (message.type === "clownmeter:info") return { cached: 214, providers: demoProviders };
      if (message.type === "clownmeter:testProvider") {
        return { ok: true, model: "gemini-3.5-flash-lite", score: 88,
          why: "Conspiracy reasoning built on a misunderstanding: the flag is far too small to see from Earth." };
      }
      return { ok: true };
    },
  },
};
// Show a successful Test result on the first provider card.
window.addEventListener("load", () => setTimeout(() => document.querySelector(".test-button")?.click(), 50));
`;
writeFileSync(path.join(buildDir, "mock-chrome.js"), MOCK_CHROME);
for (const page of ["popup", "options"]) {
  const html = readFileSync(path.join(buildDir, `${page}.html`), "utf8");
  const mocked = html.replace(`<script src="${page}.js"></script>`, `<script src="mock-chrome.js"></script>\n    <script src="${page}.js"></script>`);
  if (mocked === html) throw new Error(`Could not inject the mock into ${page}.html`);
  writeFileSync(path.join(buildDir, `${page}-mock.html`), mocked);
}

// ---- 2. Render each store/src page at its declared size ----

const pages = readdirSync(srcDir).filter((f) => f.endsWith(".html")).sort();
for (const page of pages) {
  const html = readFileSync(path.join(srcDir, page), "utf8");
  const [, width, height] = html.match(/<meta name="size" content="(\d+)x(\d+)"/) ?? [];
  if (!width) throw new Error(`${page} is missing <meta name="size" content="WxH">`);
  const out = path.join(outDir, page.replace(/\.html$/, ".png"));
  await screenshot(pathToFileURL(path.join(srcDir, page)).href, out, Number(width), Number(height));
  console.log(`${path.relative(root, out)}  ${width}×${height}  ${describePng(out)}`);
}

async function screenshot(url, out, width, height) {
  rmSync(out, { force: true });
  const profile = mkdtempSync(path.join(tmpdir(), "clownmeter-chrome-"));
  const child = spawn(chrome, [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--allow-file-access-from-files",
    "--force-device-scale-factor=1",
    "--virtual-time-budget=3000",
    `--window-size=${width},${height}`,
    `--user-data-dir=${profile}`,
    `--screenshot=${out}`,
    url,
  ], { stdio: "ignore" });
  // Headless Chrome doesn't always exit after taking the screenshot, so stop it once the file is written.
  try {
    const deadline = Date.now() + 60_000;
    let lastSize = -1;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      const size = existsSync(out) ? statSync(out).size : 0;
      if (size > 0 && size === lastSize) return;
      lastSize = size;
    }
    throw new Error(`Timed out rendering ${url}`);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    rmSync(profile, { recursive: true, force: true });
  }
}

function describePng(file) {
  const buf = readFileSync(file);
  const colorType = buf[25]; // IHDR color type: 2 = RGB, 6 = RGBA
  return colorType === 2 ? "PNG, no alpha" : colorType === 6 ? "PNG with alpha" : `PNG color type ${colorType}`;
}
