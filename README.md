# 🤡 Clownmeter

A Chrome extension that reads posts on **X** and **Threads**, sends them to an LLM, and adds 0–100 score badges next to each post's timestamp. It can rate three categories; choose which ones in the popup:

| Badge | Category | Default |
|---|---|---|
| 🎣 | **Bait**: engagement or rage farming, clickbait hooks, flamebait | off |
| 🧌 | **Troll**: bad-faith provocation, dunking, deliberate misrepresentation | off |
| 🤡 | **Dumb**: plainly wrong or incoherent reasoning. Bad spelling and opinions you disagree with don't count | **on** |

Each enabled category gets its own badge. Click a badge for the reason behind its score and which model rated it.

Supports **Google Gemini**, **Groq**, **Anthropic Claude** and any OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama, LM Studio, …). You can chain several providers: when one is rate-limited, failing or unreachable, the next one rates the post.

## Setup

Requires Node 21.7+.

```bash
npm install
cp .env.example .env   # optional: built-in keys, models and limits
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and pick the `dist/` folder.

API keys don't have to be in `.env`. They can also be set in the extension's **options page** (see below).

After changing `.env`, run `npm run build` again and click the reload icon on the extension card. `npm run watch` rebuilds the JS on save.

### `.env` options

`LLM_PROVIDERS` sets the order providers are tried in. By default it's every provider with an API key in `.env`, in the order gemini, groq, anthropic, openai, or `gemini,groq` if no keys are set. Each provider `<ID>` reads:

| Variable | Notes |
|---|---|
| `<ID>_API_KEY` | Optional, if the key is set in the options page instead. Not needed for a local server set via `<ID>_BASE_URL` |
| `<ID>_MODEL` | Defaults: `gemini-3.5-flash-lite`, `openai/gpt-oss-120b` (Groq), `claude-opus-5-5`. `openai` has no default; set it here or in the options page |
| `<ID>_EFFORT` | Optional reasoning effort such as `low`. Sent as Gemini `thinkingLevel`, OpenAI-style `reasoning_effort`, or Claude `effort` |
| `<ID>_RPM` / `<ID>_RPD` | Optional client-side request caps per minute and per day. Daily counts reset at midnight Pacific, matching Gemini's quota reset |
| `<ID>_BASE_URL` | Optional API base URL override |

The default setup in `.env.example` is Gemini with Groq as the fallback. Gemini is capped at 10/min and 500/day: the free tier allows 15/min, but staying under it avoids most of its rate-limit errors.

The build adds every provider's API origin to the manifest's `host_permissions` automatically.

### Options page: your own keys and models

Open it from the popup (**API keys & models…**) or by right-clicking the toolbar icon → **Options**. For each provider in the chain you can set:

- an API key,
- a model,
- requests per minute and per day.

Each provider also has a **Test** button, which sends a sample post using the values in the form, even before you save. Empty fields fall back to the built-in `.env` values. A provider with no key from either source is skipped.

Settings are stored in `chrome.storage.local`: on this device only, not synced. Changing a provider's key or model resets its usage counters and any pause.

### Sharing the extension

```bash
npm run build:shareable
```

This builds `dist/` **without** any API keys from `.env`, but keeps the provider order, models and limits as defaults. You can zip and share that folder; each person adds their own keys in the options page.

### Rate limits and fallback

- Before each request, the extension checks the provider's `RPM`/`RPD` budget. When the budget is used up, it skips straight to the next provider.
- On an HTTP 429 the provider is paused for the time the API asks for (Gemini's `retryDelay`, or `Retry-After`). If the 429 is a Gemini **per-day** quota error, it is paused until midnight Pacific.
- 5xx errors, timeouts (30 s) and network errors pause the provider for 30 s. A rejected key or unknown model pauses it for 10 minutes.
- If every provider is unavailable, badges show `⏳`. Each one retries automatically once a slot frees up, but only if the post is still on screen; posts off screen are rated when you scroll back to them.
- The popup shows each provider's usage for the day and the minute, and when a provider is paused.

## Using it

- **Popup** (toolbar icon) settings:
  - turn the extension on or off;
  - choose the categories to **Rate posts for**;
  - **Auto-rate visible posts**: when off, badges show `?` and posts are rated only when clicked;
  - **Skip posts with media**, explained below;
  - see each provider's usage, open the options page, or clear cached ratings.
- **Skip posts with media** (on by default): posts with images, video, GIFs or link previews, including inside a quoted post, aren't sent to the LLM, which only sees text. They get a faded 🖼️ badge instead; click it to rate that post anyway. Media often loads after the text, so each post is re-checked right before it would be rated.
- Only the enabled categories are sent to the LLM. If you enable another category later, posts already rated are re-rated for the new category only, and their existing scores are kept.
- Ratings are cached per post and category (up to 1000 posts) and survive browser restarts. You can clear the cache from the popup.
- At most 3 requests run at once. Posts are rated only as they scroll near the viewport.

**Cost and quota:** with auto-rate on, every text-only post you scroll past is one API call. A fast scroll uses up Gemini's per-minute limit quickly, and Groq takes the overflow. Click-to-rate mode saves quota.

## How it works

```
content script (x.com / threads.com)
  ├─ MutationObserver finds posts → site adapter extracts author, text, quoted post, media flag
  ├─ IntersectionObserver triggers rating when a post nears the viewport
  │    (posts with media are skipped with a 🖼️ badge unless clicked)
  └─ sends post to ↓
background service worker
  ├─ cache + in-flight de-dupe + concurrency limit
  └─ provider chain (budget check → call → fall back on 429/5xx/timeout)
       rating only the enabled categories, with a JSON-schema-constrained response
       → { dumb: { why, score }, ... }, merged into the post's cache entry
```

| Path | What it does |
|---|---|
| `src/content/adapters.js` | DOM selectors for X and Threads. Check here first when a site redesign breaks extraction. |
| `src/content/index.js` | Badges, popover, scanning |
| `src/options/` | Options page: per-provider key, model, limits, test button |
| `src/shared/categories.js` | Category list (id, label, emoji) |
| `src/background/prompt.js` | Category definitions, prompt and response schema, built per request from the enabled categories |
| `src/background/llm.js` | Provider fallback chain |
| `src/background/providers.js` | Gemini, OpenAI-compatible (Groq, …) and Claude (official `@anthropic-ai/sdk`) API calls |
| `src/background/ratelimit.js` | Per-provider minute/day budgets and cooldowns |
| `scripts/build.mjs` | Reads `.env`, bundles with esbuild into `dist/` |

Only the text is judged. Images and video aren't sent. Posts with media are skipped by default, and when one is rated anyway, the model is told it has media it can't see.

## Security note

`npm run build` bakes any API keys from `.env` into `dist/background.js`. That's fine for an extension you load unpacked for yourself. **Don't share that build or ship it to the Chrome Web Store:** anyone with the package could read the keys. To share it, use `npm run build:shareable`. `.env` and `dist/` are git-ignored.

Keys entered in the options page live in the browser profile's extension storage and are only sent to their own provider's API.
