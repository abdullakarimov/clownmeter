# Clownmeter Privacy Policy

_Effective: October 1, 2026_

Clownmeter is a browser extension that rates posts on X (x.com, twitter.com) and Threads (threads.com, threads.net) for bait, trolling, dumbness and AI slop, using an AI model you choose. This policy explains what data the extension handles and where it goes.

**In short:** post text goes only to the AI provider whose API key you entered, so it can rate the post. Your settings and keys stay in your browser. Nothing is sent to the developer of Clownmeter, and there are no analytics, ads or tracking.

## What the extension reads

On X and Threads pages only, the extension reads the posts shown on screen:

- the post's text, and the text of any post it quotes;
- the author's display name and handle;
- the post's link (used as a cache key);
- whether the post contains images, video or link previews.

It does not read your direct messages, account details, passwords, cookies, browsing history, or any other website.

## Where post data is sent

To rate a post, the extension sends the items listed above to the AI provider configured in the extension, over HTTPS, using **your own API key**. Depending on your settings this is one or more of:

- Google Gemini API (`generativelanguage.googleapis.com`)
- Groq API (`api.groq.com`)

Builds made from the source code can also be configured for Anthropic Claude or another OpenAI-compatible API.

Posts with images or video are skipped by default. Media itself is never sent, only text.

Once a post reaches the provider, how it is handled is governed by your agreement with that provider and its privacy policy. Some providers' free tiers may use submitted content to improve their services; check your provider's terms if this matters to you.

## What is stored on your device

All of the following is stored in your browser's extension storage and never sent to the developer:

| Data | Where | Purpose |
|---|---|---|
| API keys, models, rate limits | `chrome.storage.local` (this device only) | Calling your AI provider |
| Ratings already received (scores and short reasons) | `chrome.storage.local` | Avoid rating the same post twice; up to 1000 posts |
| Request counts per provider | `chrome.storage.local` | Staying within your provider's rate limits |
| Preferences (on/off, categories, auto-rate, skip media) | `chrome.storage.sync` | Your settings; synced between your browsers if Chrome Sync is on |

You can clear cached ratings from the extension's popup. Uninstalling the extension deletes all of this data.

## What the developer receives

Nothing. Clownmeter has no server, account system, analytics, telemetry, advertising or third-party tracking. The developer cannot see your posts, ratings, settings or API keys.

## Sale and other uses of data

Data is used only to provide the extension's single purpose: rating posts. It is not sold, not shared for advertising, not used to determine creditworthiness, and not used for any purpose unrelated to that feature.

## Children

Clownmeter is not directed at children under 13 and does not knowingly collect their personal information.

## Changes

If this policy changes, the updated version is published at this address with a new effective date.

## Contact

Questions or concerns: open an issue at <https://github.com/abdullakarimov/clownmeter/issues>.
