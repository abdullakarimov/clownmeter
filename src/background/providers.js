// One function per API flavour. Each returns a normalized assessment or throws ProviderError,
// whose `temporary` flag tells the fallback chain whether the failure is worth cooling down on.
import Anthropic from "@anthropic-ai/sdk";
import { buildSchema, buildSystemPrompt, buildUserMessage, normalizeAssessment } from "./prompt.js";
import { msUntilQuotaReset } from "./ratelimit.js";

const TIMEOUT_MS = 30_000;
const TEMPORARY_COOLDOWN_MS = 30_000; // 5xx, timeouts, network errors
const CONFIG_COOLDOWN_MS = 10 * 60_000; // bad key / unknown model: stop hammering, let fallbacks serve

export class ProviderError extends Error {
  constructor(message, { cooldownMs = 0, temporary = false } = {}) {
    super(message);
    this.cooldownMs = cooldownMs;
    this.temporary = temporary;
  }
}

export const CALLERS = { gemini: callGemini, openai: callOpenAICompatible, anthropic: callClaude };

// ---- Google Gemini (native generateContent API) ----

async function callGemini(provider, post, categories) {
  const generationConfig = { responseMimeType: "application/json", responseJsonSchema: buildSchema(categories) };
  if (provider.effort) generationConfig.thinkingConfig = { thinkingLevel: provider.effort };

  const res = await send(provider, `${provider.baseUrl}/models/${encodeURIComponent(provider.model)}:generateContent`, {
    headers: { "x-goog-api-key": provider.apiKey },
    body: {
      systemInstruction: { parts: [{ text: buildSystemPrompt(categories) }] },
      contents: [{ role: "user", parts: [{ text: buildUserMessage(post) }] }],
      generationConfig,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw httpError(provider, res, body.error?.message, geminiRetryDelay(body) ?? retryAfter(res));
  }

  const data = await res.json();
  if (data.promptFeedback?.blockReason) {
    throw new ProviderError(`${provider.label} blocked the post (${data.promptFeedback.blockReason})`);
  }
  const candidate = data.candidates?.[0];
  if (candidate?.finishReason === "MAX_TOKENS") throw new ProviderError(`${provider.label} response was cut off`);
  if (candidate?.finishReason && candidate.finishReason !== "STOP") {
    throw new ProviderError(`${provider.label} stopped early (${candidate.finishReason})`);
  }
  const text = (candidate?.content?.parts ?? [])
    .filter((part) => part.text && !part.thought)
    .map((part) => part.text)
    .join("");
  return parseAssessment(provider, text, categories);
}

function geminiRetryDelay(body) {
  const details = body.error?.details ?? [];
  // A per-day quota violation won't clear in seconds, whatever retryDelay says.
  if (details.some((d) => d.violations?.some((v) => /PerDay/i.test(v.quotaId ?? "")))) return msUntilQuotaReset();
  const delay = details.find((d) => d.retryDelay)?.retryDelay; // e.g. "17s"
  return delay ? Math.ceil(parseFloat(delay)) * 1000 : undefined;
}

// ---- OpenAI-compatible chat completions (Groq, OpenAI, OpenRouter, Ollama, ...) ----

async function callOpenAICompatible(provider, post, categories) {
  const url = `${provider.baseUrl}/chat/completions`;
  const request = {
    model: provider.model,
    messages: [
      {
        role: "system",
        content: `${buildSystemPrompt(categories)}\n\nRespond with a single JSON object with keys ${categories.join(", ")}, each an object with "why" and "score".`,
      },
      { role: "user", content: buildUserMessage(post) },
    ],
  };
  if (provider.effort) request.reasoning_effort = provider.effort;
  const headers = provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {};

  const strict = { type: "json_schema", json_schema: { name: "clownmeter_assessment", strict: true, schema: buildSchema(categories) } };
  let res = await send(provider, url, { headers, body: { ...request, response_format: strict } });
  // Not every OpenAI-compatible server or model supports json_schema; fall back to plain JSON mode.
  if (res.status === 400) res = await send(provider, url, { headers, body: { ...request, response_format: { type: "json_object" } } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw httpError(provider, res, body.error?.message, retryAfter(res));
  }

  const choice = (await res.json()).choices?.[0];
  if (choice?.message?.refusal) throw new ProviderError(`${provider.label} declined to rate this post`);
  if (choice?.finish_reason === "length") throw new ProviderError(`${provider.label} response was cut off`);
  return parseAssessment(provider, choice?.message?.content ?? "", categories);
}

// ---- Anthropic Claude (official SDK) ----

// Claude models that accept output_config.effort, and those that accept server-side refusal fallbacks.
const EFFORT_MODELS = /^claude-(opus-(4-[5-9]|5)|sonnet-(4-6|5)|fable|mythos)/;
const FALLBACK_MODELS = /^claude-(opus-5|fable-5-1|sonnet-5-5)/;
const anthropicClients = new Map();

async function callClaude(provider, post, categories) {
  const clientKey = `${provider.apiKey}|${provider.baseUrl}`; // the key can change in the options page
  if (!anthropicClients.has(clientKey)) {
    anthropicClients.set(
      clientKey,
      new Anthropic({
        apiKey: provider.apiKey,
        baseURL: provider.baseUrl,
        // The key lives inside the user's own unpacked extension; see README for the trade-off.
        dangerouslyAllowBrowser: true,
        timeout: TIMEOUT_MS,
        maxRetries: 0, // the provider chain handles retries by moving to the next provider
      }),
    );
  }
  const client = anthropicClients.get(clientKey);

  const params = {
    model: provider.model,
    max_tokens: 4096,
    system: buildSystemPrompt(categories),
    messages: [{ role: "user", content: buildUserMessage(post) }],
    output_config: { format: { type: "json_schema", schema: buildSchema(categories) } },
  };
  if (provider.effort && EFFORT_MODELS.test(provider.model)) params.output_config.effort = provider.effort;
  // On a safety-classifier decline, let the API re-run the request on its recommended fallback model.
  if (!provider.customBaseUrl && FALLBACK_MODELS.test(provider.model)) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }

  let response;
  try {
    response = await client.beta.messages.create(params);
  } catch (err) {
    const label = provider.label;
    if (err instanceof Anthropic.RateLimitError) {
      const seconds = Number(err.headers?.get?.("retry-after"));
      throw new ProviderError(`${label} rate limit hit`, { cooldownMs: seconds ? seconds * 1000 : 60_000, temporary: true });
    }
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      throw new ProviderError(`${label} rejected the API key`, { cooldownMs: CONFIG_COOLDOWN_MS });
    }
    if (err instanceof Anthropic.NotFoundError) {
      throw new ProviderError(`${label} model not found: ${provider.model}`, { cooldownMs: CONFIG_COOLDOWN_MS });
    }
    if (err instanceof Anthropic.BadRequestError) throw new ProviderError(`${label} bad request: ${err.message}`);
    if (err instanceof Anthropic.APIConnectionError) {
      throw new ProviderError(`Could not reach ${label}`, { cooldownMs: TEMPORARY_COOLDOWN_MS, temporary: true });
    }
    if (err instanceof Anthropic.APIError) {
      throw new ProviderError(`${label} unavailable (${err.status ?? "?"})`, { cooldownMs: TEMPORARY_COOLDOWN_MS, temporary: true });
    }
    throw err;
  }

  if (response.stop_reason === "refusal") throw new ProviderError(`${provider.label} declined to rate this post`);
  if (response.stop_reason === "max_tokens") throw new ProviderError(`${provider.label} response was cut off`);
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return parseAssessment(provider, text, categories);
}

// ---- Shared helpers ----

async function send(provider, url, { headers, body }) {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const message = err.name === "TimeoutError" ? `${provider.label} timed out` : `Could not reach ${provider.label}`;
    throw new ProviderError(message, { cooldownMs: TEMPORARY_COOLDOWN_MS, temporary: true });
  }
}

function httpError(provider, res, detail = "", retryAfterMs) {
  const { label } = provider;
  if (res.status === 429) {
    return new ProviderError(`${label} rate limit hit`, { cooldownMs: retryAfterMs ?? 60_000, temporary: true });
  }
  if (res.status >= 500) {
    return new ProviderError(`${label} unavailable (${res.status})`, { cooldownMs: TEMPORARY_COOLDOWN_MS, temporary: true });
  }
  // Gemini reports an invalid key as 400 INVALID_ARGUMENT rather than 401.
  if (res.status === 401 || res.status === 403 || (res.status === 400 && /api key/i.test(detail))) {
    return new ProviderError(`${label} rejected the API key`, { cooldownMs: CONFIG_COOLDOWN_MS });
  }
  if (res.status === 404) return new ProviderError(`${label} model not found: ${provider.model}`, { cooldownMs: CONFIG_COOLDOWN_MS });
  return new ProviderError(`${label} error ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
}

function retryAfter(res) {
  const seconds = Number(res.headers.get("retry-after"));
  return seconds > 0 ? seconds * 1000 : undefined;
}

function parseAssessment(provider, text, categories) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let assessment = null;
  try {
    assessment = normalizeAssessment(JSON.parse(cleaned), categories);
  } catch {
    // reported below
  }
  if (!assessment) throw new ProviderError(`${provider.label} returned malformed JSON`);
  return assessment;
}
