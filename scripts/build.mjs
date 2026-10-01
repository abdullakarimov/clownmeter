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

const DEFAULT_BASE_URLS = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
};

async function loadConfig() {
  const envPath = path.join(root, ".env");
  if (!existsSync(envPath)) {
    throw new Error("Missing .env — copy .env.example to .env and fill in LLM_API_KEY.");
  }
  const env = { ...parseEnv(await readFile(envPath, "utf8")) };
  const provider = (env.LLM_PROVIDER || "anthropic").trim().toLowerCase();
  if (!(provider in DEFAULT_BASE_URLS)) {
    throw new Error(`LLM_PROVIDER must be "anthropic" or "openai", got "${provider}".`);
  }
  const config = {
    provider,
    apiKey: (env.LLM_API_KEY || "").trim(),
    model: (env.LLM_MODEL || "").trim(),
    baseUrl: (env.LLM_BASE_URL || "").trim().replace(/\/+$/, ""),
    effort: (env.LLM_EFFORT || "").trim().toLowerCase(),
  };
  if (!config.model) throw new Error("LLM_MODEL is required in .env.");
  if (!config.apiKey && !config.baseUrl) {
    // Local OpenAI-compatible servers (Ollama, LM Studio) may not need a key; hosted APIs do.
    throw new Error("LLM_API_KEY is required in .env (it may only be empty with a local LLM_BASE_URL).");
  }
  return config;
}

async function writeManifest(config) {
  const manifest = JSON.parse(await readFile(path.join(root, "src/manifest.json"), "utf8"));
  const apiOrigin = new URL(config.baseUrl || DEFAULT_BASE_URLS[config.provider]).origin;
  manifest.host_permissions = [...new Set([...manifest.host_permissions, `${apiOrigin}/*`])];
  await writeFile(path.join(dist, "manifest.json"), JSON.stringify(manifest, null, 2));
}

async function build() {
  const config = await loadConfig();
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  const shared = {
    bundle: true,
    target: "chrome120",
    logLevel: "info",
    define: { __CLOWNMETER_CONFIG__: JSON.stringify(config) },
  };
  const builds = [
    { ...shared, entryPoints: { background: "src/background/index.js" }, format: "esm" },
    { ...shared, entryPoints: { content: "src/content/index.js" }, format: "iife" },
    { ...shared, entryPoints: { popup: "src/popup/popup.js" }, format: "iife" },
  ].map((opts) => ({ ...opts, absWorkingDir: root, outdir: dist }));

  await writeManifest(config);
  await cp(path.join(root, "src/content/content.css"), path.join(dist, "content.css"));
  await cp(path.join(root, "src/popup/popup.html"), path.join(dist, "popup.html"));
  await cp(path.join(root, "icons"), path.join(dist, "icons"), { recursive: true });

  if (watch) {
    for (const opts of builds) await (await esbuild.context(opts)).watch();
    console.log("Watching JS sources (re-run the build after editing .env, manifest, CSS or HTML).");
  } else {
    await Promise.all(builds.map((opts) => esbuild.build(opts)));
    console.log(`Built ${config.provider} / ${config.model} → dist/ (load it via chrome://extensions → Load unpacked).`);
  }
}

build().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
