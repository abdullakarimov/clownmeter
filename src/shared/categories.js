// The axes a post can be rated on. Order here is the badge order on the page.
export const CATEGORIES = [
  { id: "bait", label: "Bait", emoji: "🎣" },
  { id: "troll", label: "Troll", emoji: "🧌" },
  { id: "dumb", label: "Dumb", emoji: "🤡" },
  { id: "slop", label: "AI slop", emoji: "🤖" },
];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
