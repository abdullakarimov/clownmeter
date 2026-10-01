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

export function createProviders(configs) {
  return configs.map((config) => ({ ...config, budget: new Budget(config.id, config) }));
}

export async function assess(providers, post) {
  await Promise.all(providers.map((p) => p.budget.load()));
  const failures = [];

  for (const provider of providers) {
    if (provider.budget.tryAcquire()) {
      failures.push({ provider, message: `${provider.label} is rate-limited`, temporary: true });
      continue;
    }
    try {
      const assessment = await CALLERS[provider.kind](provider, post);
      return { ...assessment, ratedBy: `${provider.label} · ${provider.model}` };
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
