import Anthropic from "@anthropic-ai/sdk";
import { ASSESSMENT_SCHEMA, SYSTEM_PROMPT, buildUserMessage, normalizeAssessment } from "./prompt.js";

export class AssessmentError extends Error {}

// Claude models that accept output_config.effort, and those that accept server-side refusal fallbacks.
const EFFORT_MODELS = /^claude-(opus-(4-[5-9]|5)|sonnet-(4-6|5)|fable|mythos)/;
const FALLBACK_MODELS = /^claude-(opus-5|fable-5-1|sonnet-5-5)/;

export function assess(config, post) {
  return config.provider === "anthropic" ? assessWithClaude(config, post) : assessWithOpenAICompatible(config, post);
}

let anthropicClient;

async function assessWithClaude(config, post) {
  anthropicClient ??= new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl || undefined,
    // The key lives inside the user's own unpacked extension; see README for the trade-off.
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
  });

  const params = {
    model: config.model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserMessage(post) }],
    output_config: { format: { type: "json_schema", schema: ASSESSMENT_SCHEMA } },
  };
  if (config.effort && EFFORT_MODELS.test(config.model)) params.output_config.effort = config.effort;
  // On a safety-classifier decline, let the API re-run the request on its recommended fallback model.
  if (!config.baseUrl && FALLBACK_MODELS.test(config.model)) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }

  let response;
  try {
    response = await anthropicClient.beta.messages.create(params);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new AssessmentError("Invalid API key (check LLM_API_KEY).");
    if (err instanceof Anthropic.PermissionDeniedError) throw new AssessmentError("API key lacks access to this model.");
    if (err instanceof Anthropic.NotFoundError) throw new AssessmentError(`Model not found: ${config.model}`);
    if (err instanceof Anthropic.RateLimitError) throw new AssessmentError("Rate limited — try again shortly.");
    if (err instanceof Anthropic.BadRequestError) throw new AssessmentError(`Bad request: ${err.message}`);
    if (err instanceof Anthropic.APIConnectionError) throw new AssessmentError("Could not reach the Claude API.");
    if (err instanceof Anthropic.APIError) throw new AssessmentError(`Claude API error ${err.status ?? ""}: ${err.message}`);
    throw err;
  }

  if (response.stop_reason === "refusal") {
    throw new AssessmentError(`Model declined to rate this post${response.stop_details?.category ? ` (${response.stop_details.category})` : ""}.`);
  }
  if (response.stop_reason === "max_tokens") throw new AssessmentError("Response was cut off (max_tokens).");

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return normalizeAssessment(parseJson(text));
}

async function assessWithOpenAICompatible(config, post) {
  const url = `${config.baseUrl || "https://api.openai.com/v1"}/chat/completions`;
  const messages = [
    { role: "system", content: `${SYSTEM_PROMPT}\n\nRespond with a single JSON object with keys: why, bait, troll, dumb, clown, verdict.` },
    { role: "user", content: buildUserMessage(post) },
  ];
  const strictFormat = { type: "json_schema", json_schema: { name: "clownmeter_assessment", strict: true, schema: ASSESSMENT_SCHEMA } };

  let res = await postChat(url, config, { model: config.model, messages, response_format: strictFormat });
  // Not every OpenAI-compatible server supports json_schema; fall back to plain JSON mode.
  if (res.status === 400) res = await postChat(url, config, { model: config.model, messages, response_format: { type: "json_object" } });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 401) throw new AssessmentError("Invalid API key (check LLM_API_KEY).");
    if (res.status === 404) throw new AssessmentError(`Endpoint or model not found: ${config.model}`);
    if (res.status === 429) throw new AssessmentError("Rate limited — try again shortly.");
    throw new AssessmentError(`LLM API error ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const choice = data.choices?.[0];
  if (choice?.message?.refusal) throw new AssessmentError("Model declined to rate this post.");
  if (choice?.finish_reason === "length") throw new AssessmentError("Response was cut off (max tokens).");
  return normalizeAssessment(parseJson(choice?.message?.content ?? ""));
}

async function postChat(url, config, body) {
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AssessmentError(`Could not reach ${new URL(url).origin}.`);
  }
}

function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new AssessmentError("Model returned malformed JSON.");
  }
}
