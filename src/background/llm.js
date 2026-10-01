// Tries providers in configured order, skipping any that are over budget or cooling down.
import { Budget } from "./ratelimit.js";
import { CALLERS, ProviderError } from "./providers.js";

export class AssessmentError extends Error {
  /** retryAt is set when every provider failed only for temporary reasons (rate limits, outages). */
  constructor(message, retryAt = 0) {
    super(message);
    this.retryAt = retryAt;
  }
}

/** Built-in provider configs (from .env), each with a persistent request budget. */
export function createProviders(configs) {
  return configs.map((base) => ({ base, budget: new Budget(base.id, base) }));
}

/** Applies options-page overrides on top of the built-in configs. */
export function resolveProviders(providers, overrides) {
  return providers.map(({ base, budget }) => {
    const o = overrides[base.id] ?? {};
    const provider = {
      ...base,
      apiKey: o.apiKey || base.apiKey,
      model: o.model || base.model,
      rpm: o.rpm ?? base.rpm,
      rpd: o.rpd ?? base.rpd,
      keySource: o.apiKey ? "options" : base.apiKey ? ".env" : "",
      budget,
    };
    budget.rpm = provider.rpm;
    budget.rpd = provider.rpd;
    return provider;
  });
}

// Local OpenAI-compatible servers (custom base URL) may not need a key; hosted APIs do.
export const isUsable = (provider) => !!provider.model && (!!provider.apiKey || provider.customBaseUrl);

/** Calls one provider directly, outside the budget and fallback chain. */
export function callProvider(provider, post, categories) {
  return CALLERS[provider.kind](provider, post, categories);
}

/** Rates the post on the given categories; returns { [category]: { score, why, ratedBy } }. */
export async function assess(allProviders, post, categories) {
  const providers = allProviders.filter(isUsable);
  if (!providers.length) {
    throw new AssessmentError("No API key set. Add one in the Clownmeter options (right-click the toolbar icon → Options).");
  }
  await Promise.all(providers.map((p) => p.budget.load()));
  const failures = [];

  for (const provider of providers) {
    if (provider.budget.tryAcquire()) {
      failures.push({ provider, message: `${provider.label} is rate-limited`, temporary: true });
      continue;
    }
    try {
      const assessment = await callProvider(provider, post, categories);
      const ratedBy = `${provider.label} · ${provider.model}`;
      for (const axis of Object.values(assessment)) axis.ratedBy = ratedBy;
      return assessment;
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      if (err.cooldownMs) provider.budget.coolDown(err.cooldownMs);
      console.warn(`Clownmeter: ${err.message}`);
      failures.push({ provider, message: err.message, temporary: err.temporary });
    }
  }

  if (failures.every((f) => f.temporary)) {
    const retryAt = Math.min(...providers.map((p) => p.budget.nextAvailable()).filter(Boolean));
    throw new AssessmentError("All providers are rate-limited or unavailable.", Number.isFinite(retryAt) ? retryAt : Date.now() + 30_000);
  }
  throw new AssessmentError(failures.map((f) => f.message).join(" · "));
}
