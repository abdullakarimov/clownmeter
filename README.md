# 🤡 Clownmeter

A Chrome extension that reads posts on **X** and **Threads**, sends them to an LLM, and adds a badge next to each post's timestamp. The badge shows how much of a clown show the post is:

- **Bait**: engagement or rage farming, clickbait hooks, flamebait.
- **Troll**: bad-faith provocation, dunking, deliberate misrepresentation.
- **Dumb**: plainly wrong or incoherent reasoning. Bad spelling and opinions you disagree with don't count.
- **🤡 score**: the overall 0–100 rating. Click the badge for the breakdown, a one-line verdict and the reasons.

Supports **Google Gemini**, **Groq**, **Anthropic Claude** and any OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama, LM Studio, …). You can chain several providers: when one is rate-limited, failing or unreachable, the next one rates the post.

## Setup

Requires Node 21.7+.

```bash
npm install
cp .env.example .env   # then fill in GEMINI_API_KEY / GROQ_API_KEY (or other providers)
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and pick the `dist/` folder.

After changing `.env`, run `npm run build` again and click the reload icon on the extension card. `npm run watch` rebuilds the JS on save.

### `.env` options

`LLM_PROVIDERS` sets the order providers are tried in (default: every provider with an API key, in the order gemini, groq, anthropic, openai). Each provider `<ID>` reads:

| Variable | Notes |
|---|---|
| `<ID>_API_KEY` | Required. May be empty only for a local server set via `<ID>_BASE_URL` |
| `<ID>_MODEL` | Defaults: `gemini-3.5-flash-lite`, `openai/gpt-oss-120b` (Groq), `claude-opus-5-5`; required for `openai` |
| `<ID>_EFFORT` | Optional reasoning effort such as `low`. Sent as Gemini `thinkingLevel`, OpenAI-style `reasoning_effort`, or Claude `effort` |
| `<ID>_RPM` / `<ID>_RPD` | Optional client-side request caps per minute and per day. Daily counts reset at midnight Pacific, matching Gemini's quota reset |
| `<ID>_BASE_URL` | Optional API base URL override |

The default setup in `.env.example` is Gemini (capped at 15/min and 500/day to match the free tier) with Groq as the fallback.

The build adds every provider's API origin to the manifest's `host_permissions` automatically.

### Rate limits and fallback

- Before each request, the extension checks the provider's `RPM`/`RPD` budget. When the budget is used up, it skips straight to the next provider.
- On an HTTP 429 the provider is paused for the time the API asks for (Gemini's `retryDelay`, or `Retry-After`). If the 429 is a Gemini **per-day** quota error, it is paused until midnight Pacific.
- 5xx errors, timeouts (30 s) and network errors pause the provider for 30 s. A rejected key or unknown model pauses it for 10 minutes.
- If every provider is unavailable, badges show `🤡 ⏳`. Each one retries automatically once a slot frees up, but only if the post is still on screen; posts off screen are rated when you scroll back to them.
- The popup shows each provider's usage for the day and the minute, and when a provider is paused.

## Using it

- **Popup** (toolbar icon): turn the extension on or off and switch **Auto-rate visible posts**. With auto-rate off, posts show `🤡 ?` and are rated only when clicked.
- Ratings are cached per post (up to 1000) and survive browser restarts. You can clear the cache from the popup.
- At most 3 requests run at once. Posts are rated only as they scroll near the viewport.

**Cost and quota:** with auto-rate on, every post you scroll past is one API call. A fast scroll uses up Gemini's 15/min quickly; Groq absorbs the overflow. Switch to click-to-rate mode to save quota.

## How it works

```
content script (x.com / threads.com)
  ├─ MutationObserver finds posts → site adapter extracts author, text, quoted post, media flag
  ├─ IntersectionObserver triggers rating when a post nears the viewport
  └─ sends post to ↓
background service worker
  ├─ cache + in-flight de-dupe + concurrency limit
  └─ provider chain (budget check → call → fall back on 429/5xx/timeout)
       with a JSON-schema-constrained response → { why, bait, troll, dumb, clown, verdict }
```

| Path | What it does |
|---|---|
| `src/content/adapters.js` | DOM selectors for X and Threads. Check here first when a site redesign breaks extraction. |
| `src/content/index.js` | Badge, popover, scanning |
| `src/background/prompt.js` | System prompt, scoring rubric and response schema |
| `src/background/llm.js` | Provider fallback chain |
| `src/background/providers.js` | Gemini, OpenAI-compatible (Groq, …) and Claude (official `@anthropic-ai/sdk`) API calls |
| `src/background/ratelimit.js` | Per-provider minute/day budgets and cooldowns |
| `scripts/build.mjs` | Reads `.env`, bundles with esbuild into `dist/` |

Only the text is judged. Images and video aren't sent, though the model is told when a post has media.

## Security note

The API keys are baked into `dist/background.js`. That's fine for an extension you load unpacked for yourself. **Don't publish `dist/` or ship it to the Chrome Web Store:** anyone with the package could read the keys. `.env` and `dist/` are git-ignored.
