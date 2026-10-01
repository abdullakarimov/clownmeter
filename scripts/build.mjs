// Builds the unpacked extension into dist/, baking LLM settings from .env into the background bundle.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseEnv } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const watch = process.argv.includes("--watch");

// Each provider reads <ID>_API_KEY, <ID>_MODEL, <ID>_BASE_URL, <ID>_EFFORT, <ID>_RPM, <ID>_RPD from .env.
const PROVIDERS = {
  gemini: { kind: "gemini", label: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-3.5-flash-lite" },
  groq: { kind: "openai", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b" },
  anthropic: { kind: "anthropic", label: "Claude", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5" },
  openai: { kind: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "" },
};

async function loadConfig() {
  const envPath = path.join(root, ".env");
  if (!existsSync(envPath)) {
    throw new Error("Missing .env — copy .env.example to .env and add at least one provider API key.");
  }
  const env = parseEnv(await readFile(envPath, "utf8"));
  const get = (name) => (env[name] ?? "").trim();

  const order = get("LLM_PROVIDERS")
    ? get("LLM_PROVIDERS").toLowerCase().split(/[\s,]+/).filter(Boolean)
    : Object.keys(PROVIDERS).filter((id) => get(`${id.toUpperCase()}_API_KEY`));
  if (!order.length) throw new Error("No providers configured — set LLM_PROVIDERS and the matching *_API_KEY in .env.");

  const providers = order.map((id) => {
    const defaults = PROVIDERS[id];
    if (!defaults) throw new Error(`Unknown provider "${id}" in LLM_PROVIDERS (expected: ${Object.keys(PROVIDERS).join(", ")}).`);
    const P = id.toUpperCase();
    const provider = {
      id,
      kind: defaults.kind,
      label: defaults.label,
      apiKey: get(`${P}_API_KEY`),
      model: get(`${P}_MODEL`) || defaults.model,
      baseUrl: (get(`${P}_BASE_URL`) || defaults.baseUrl).replace(/\/+$/, ""),
      customBaseUrl: !!get(`${P}_BASE_URL`),
      effort: get(`${P}_EFFORT`).toLowerCase(),
      rpm: Number(get(`${P}_RPM`)) || 0,
      rpd: Number(get(`${P}_RPD`)) || 0,
    };
    if (!provider.model) throw new Error(`${P}_MODEL is required in .env.`);
    // Local OpenAI-compatible servers (Ollama, LM Studio) may not need a key; hosted APIs do.
    if (!provider.apiKey && !provider.customBaseUrl) throw new Error(`${P}_API_KEY is required in .env.`);
    return provider;
  });
  return { providers };
}

async function writeManifest(config) {
  const manifest = JSON.parse(await readFile(path.join(root, "src/manifest.json"), "utf8"));
  const origins = config.providers.map((p) => `${new URL(p.baseUrl).origin}/*`);
  manifest.host_permissions = [...new Set([...manifest.host_permissions, ...origins])];
  await writeFile(path.join(dist, "manifest.json"), JSON.stringify(manifest, null, 2));
}

async function build() {
  const config = await loadConfig();
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  const shared = { bundle: true, target: "chrome120", logLevel: "warning" };
  const builds = [
    {
      ...shared,
      entryPoints: { background: "src/background/index.js" },
      format: "esm",
      define: { __CLOWNMETER_CONFIG__: JSON.stringify(config) },
    },
    { ...shared, entryPoints: { content: "src/content/index.js" }, format: "iife" },
    { ...shared, entryPoints: { popup: "src/popup/popup.js" }, format: "iife" },
  ].map((opts) => ({ ...opts, absWorkingDir: root, outdir: dist }));

  await writeManifest(config);
  await cp(path.join(root, "src/content/content.css"), path.join(dist, "content.css"));
  await cp(path.join(root, "src/popup/popup.html"), path.join(dist, "popup.html"));
  await cp(path.join(root, "icons"), path.join(dist, "icons"), { recursive: true });

  const chain = config.providers
    .map((p) => `${p.label} (${p.model}${p.rpm || p.rpd ? `, ${p.rpm || "∞"}/min ${p.rpd || "∞"}/day` : ""})`)
    .join(" → ");
  if (watch) {
    for (const opts of builds) await (await esbuild.context(opts)).watch();
    console.log(`Watching JS sources. Providers: ${chain}\n(Re-run the build after editing .env, manifest, CSS or HTML.)`);
  } else {
    await Promise.all(builds.map((opts) => esbuild.build(opts)));
    console.log(`Built dist/. Providers: ${chain}\nLoad it via chrome://extensions → Load unpacked.`);
  }
}

build().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
