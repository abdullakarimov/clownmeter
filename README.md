# 🤡 Clownmeter

A Chrome extension that reads posts on **X** and **Threads**, sends them to an LLM, and adds a badge next to each post's timestamp. The badge shows how much of a clown show the post is:

- **Bait**: engagement or rage farming, clickbait hooks, flamebait.
- **Troll**: bad-faith provocation, dunking, deliberate misrepresentation.
- **Dumb**: plainly wrong or incoherent reasoning. Bad spelling and opinions you disagree with don't count.
- **🤡 score**: the overall 0–100 rating. Click the badge for the breakdown, a one-line verdict and the reasons.

Works with the Claude API (default) or any OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, Ollama, LM Studio, …).

## Setup

Requires Node 21.7+.

```bash
npm install
cp .env.example .env   # then fill in LLM_API_KEY (and optionally provider/model)
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and pick the `dist/` folder.

After changing `.env`, run `npm run build` again and click the reload icon on the extension card. `npm run watch` rebuilds the JS on save.

### `.env` options

| Variable | Default | Notes |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` | `anthropic` or `openai` (any OpenAI-compatible `/chat/completions` API) |
| `LLM_API_KEY` | — | Required, except for local servers set via `LLM_BASE_URL` |
| `LLM_MODEL` | — | e.g. `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-4-5`, `gpt-5-mini` |
| `LLM_BASE_URL` | provider default | e.g. `https://openrouter.ai/api/v1`, `http://localhost:11434/v1` |
| `LLM_EFFORT` | `low` | Claude effort level, sent only to models that support it |

The build adds the API's origin to the manifest's `host_permissions` automatically.

## Using it

- **Popup** (toolbar icon): turn the extension on or off and switch **Auto-rate visible posts**. With auto-rate off, posts show `🤡 ?` and are rated only when clicked.
- Ratings are cached per post (up to 1000) and survive browser restarts. You can clear the cache from the popup.
- At most 3 requests run at once. Posts are rated only as they scroll near the viewport.

**Cost:** with auto-rate on, every post you scroll past is one API call. A cheaper model (e.g. `claude-haiku-4-5` or `claude-sonnet-5-5`) or click-to-rate mode keeps the bill down on long scrolling sessions.

## How it works

```
content script (x.com / threads.com)
  ├─ MutationObserver finds posts → site adapter extracts author, text, quoted post, media flag
  ├─ IntersectionObserver triggers rating when a post nears the viewport
  └─ sends post to ↓
background service worker
  ├─ cache + in-flight de-dupe + concurrency limit
  └─ LLM call with a JSON-schema-constrained response → { why, bait, troll, dumb, clown, verdict }
```

| Path | What it does |
|---|---|
| `src/content/adapters.js` | DOM selectors for X and Threads. Check here first when a site redesign breaks extraction. |
| `src/content/index.js` | Badge, popover, scanning |
| `src/background/prompt.js` | System prompt, scoring rubric and response schema |
| `src/background/llm.js` | Claude (official `@anthropic-ai/sdk`) and OpenAI-compatible clients |
| `scripts/build.mjs` | Reads `.env`, bundles with esbuild into `dist/` |

Only the text is judged. Images and video aren't sent, though the model is told when a post has media.

## Security note

The API key is baked into `dist/background.js`. That's fine for an extension you load unpacked for yourself. **Don't publish `dist/` or ship it to the Chrome Web Store:** anyone with the package could read the key. `.env` and `dist/` are git-ignored.
