// Per-site DOM scraping. Each adapter finds post elements and extracts
// { id, author, text, quote, hasMedia } plus the element the badge is placed after.
// hasMedia covers anything the model can't see: images, video, GIFs and link preview cards,
// in the post itself or in a post it quotes.
// These selectors track the live sites and are the first thing to check when a site redesigns.

const textOf = (el) => (el?.innerText ?? "").trim();

const x = {
  platform: "x",
  postSelector: 'article[data-testid="tweet"]',

  extract(article) {
    // Quoted posts render inside a nested role="link" card.
    const inQuote = (el) => {
      const card = el.closest('div[role="link"]');
      return !!card && article.contains(card);
    };
    const timeLink = [...article.querySelectorAll('a[href*="/status/"] time')]
      .map((t) => t.closest("a"))
      .find((a) => !inQuote(a));
    if (!timeLink) return null; // promoted posts have no permalink

    const texts = [...article.querySelectorAll('[data-testid="tweetText"]')];
    const mainText = texts.find((el) => !inQuote(el));
    const quoteText = texts.find((el) => inQuote(el));
    const names = [...article.querySelectorAll('[data-testid="User-Name"]')];
    const quoteCard = quoteText?.closest('div[role="link"]');

    return {
      id: new URL(timeLink.href).pathname,
      author: xAuthor(names.find((el) => !inQuote(el))),
      text: textOf(mainText),
      quote: quoteText ? { text: textOf(quoteText), author: xAuthor(quoteCard?.querySelector('[data-testid="User-Name"]')) } : null,
      hasMedia: !!article.querySelector('[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="card.wrapper"]'),
      anchor: timeLink,
    };
  },
};

function xAuthor(userNameEl) {
  const lines = textOf(userNameEl).split("\n").map((l) => l.trim()).filter(Boolean);
  const handle = lines.find((l) => l.startsWith("@"));
  return lines[0] && handle ? `${lines[0]} (${handle})` : lines[0] ?? "";
}

const threads = {
  platform: "threads",
  postSelector: 'div[data-pressable-container="true"]',

  extract(container) {
    const timeLink = container.querySelector('a[href*="/post/"] time')?.closest("a");
    if (!timeLink) return null;

    // Body text lives in top-level span[dir=auto]s that aren't the author link, timestamp or action counts.
    const parts = [...container.querySelectorAll('span[dir="auto"]')].filter((span) => {
      if (span.closest("a, [role='button']") || span.querySelector("time")) return false;
      const outer = span.parentElement.closest('span[dir="auto"]');
      return !(outer && container.contains(outer));
    });
    const authorLink = [...container.querySelectorAll('a[href^="/@"]')].find(
      (a) => !a.getAttribute("href").includes("/post/") && textOf(a),
    );

    return {
      id: new URL(timeLink.href).pathname,
      author: authorLink ? `@${textOf(authorLink)}` : "",
      text: parts.map(textOf).filter(Boolean).join("\n"),
      quote: null,
      hasMedia: !!container.querySelector('video, picture, img:not([alt*="profile picture"])'),
      anchor: timeLink,
    };
  },
};

export function adapterForHost(host) {
  return host.includes("threads.") ? threads : x;
}
