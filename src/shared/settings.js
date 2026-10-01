export const DEFAULT_SETTINGS = {
  enabled: true,
  // true: rate posts as they scroll into view; false: rate only when the 🤡 badge is clicked.
  autoScan: true,
};

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(DEFAULT_SETTINGS)) };
}

export function setSettings(patch) {
  return chrome.storage.sync.set(patch);
}
