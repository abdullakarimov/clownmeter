// Per-provider overrides set in the options page: { [providerId]: { apiKey?, model?, rpm?, rpd? } }.
// Missing fields fall back to the values built in from .env. Stored in chrome.storage.local (this device
// only) rather than sync, so API keys aren't copied to Google's sync servers.
export const PROVIDER_SETTINGS_KEY = "providerSettings";

export async function getProviderSettings() {
  return (await chrome.storage.local.get(PROVIDER_SETTINGS_KEY))[PROVIDER_SETTINGS_KEY] ?? {};
}

export function setProviderSettings(settings) {
  return chrome.storage.local.set({ [PROVIDER_SETTINGS_KEY]: settings });
}
