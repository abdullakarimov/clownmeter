import { CATEGORY_IDS } from "./categories.js";

export const DEFAULT_SETTINGS = {
  enabled: true,
  // true: rate posts as they scroll into view; false: rate only when a badge is clicked.
  autoScan: true,
  // Skip posts with images, video or link cards: the model only sees text. Skipped posts can still be rated on click.
  skipMedia: true,
  // Which axes to rate posts on; each enabled one gets its own badge.
  categories: { bait: false, troll: false, dumb: true },
};

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(DEFAULT_SETTINGS)) };
}

export function setSettings(patch) {
  return chrome.storage.sync.set(patch);
}

export function enabledCategories(settings) {
  return CATEGORY_IDS.filter((id) => settings.categories?.[id]);
}
