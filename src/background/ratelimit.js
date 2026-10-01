// Client-side request budgets per provider, persisted so service-worker restarts don't reset them.
// Daily counters roll over at midnight Pacific, when Gemini's free-tier quotas reset.

const WINDOW_MS = 60_000;
const QUOTA_TZ = "America/Los_Angeles";

const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: QUOTA_TZ });
const clockFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: QUOTA_TZ,
  hourCycle: "h23",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

const quotaDay = (now) => dayFormat.format(now);

export function msUntilQuotaReset(now = Date.now()) {
  const t = Object.fromEntries(clockFormat.formatToParts(now).map((p) => [p.type, Number(p.value)]));
  return 86_400_000 - ((t.hour * 60 + t.minute) * 60 + t.second) * 1000;
}

export class Budget {
  constructor(id, { rpm = 0, rpd = 0 } = {}) {
    this.storageKey = `usage:${id}`;
    this.rpm = rpm;
    this.rpd = rpd;
    this.state = { day: quotaDay(Date.now()), dayCount: 0, recent: [], cooldownUntil: 0 };
    this.loading = null;
  }

  load() {
    this.loading ??= chrome.storage.local.get(this.storageKey).then((stored) => {
      Object.assign(this.state, stored[this.storageKey]);
    });
    return this.loading;
  }

  #roll(now) {
    const day = quotaDay(now);
    if (day !== this.state.day) Object.assign(this.state, { day, dayCount: 0 });
    this.state.recent = this.state.recent.filter((t) => now - t < WINDOW_MS);
  }

  #save() {
    chrome.storage.local.set({ [this.storageKey]: this.state });
  }

  /** 0 if a request can be sent now, otherwise the timestamp when it can. */
  nextAvailable(now = Date.now()) {
    this.#roll(now);
    const { cooldownUntil, dayCount, recent } = this.state;
    if (cooldownUntil > now) return cooldownUntil;
    if (this.rpd && dayCount >= this.rpd) return now + msUntilQuotaReset(now);
    if (this.rpm && recent.length >= this.rpm) return recent[recent.length - this.rpm] + WINDOW_MS;
    return 0;
  }

  /** Records a request if the budget allows one; returns nextAvailable() otherwise (0 = acquired). */
  tryAcquire(now = Date.now()) {
    const wait = this.nextAvailable(now);
    if (wait) return wait;
    this.state.recent.push(now);
    this.state.dayCount++;
    this.#save();
    return 0;
  }

  /** Forgets usage and cooldowns, e.g. after the API key changes. */
  reset() {
    this.state = { day: quotaDay(Date.now()), dayCount: 0, recent: [], cooldownUntil: 0 };
    this.#save();
  }

  coolDown(ms) {
    this.state.cooldownUntil = Math.max(this.state.cooldownUntil, Date.now() + ms);
    this.#save();
  }

  snapshot(now = Date.now()) {
    const nextAvailable = this.nextAvailable(now);
    return {
      minute: this.state.recent.length,
      rpm: this.rpm,
      today: this.state.dayCount,
      rpd: this.rpd,
      nextAvailable,
    };
  }
}
