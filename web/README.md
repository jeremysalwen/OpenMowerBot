# Browser App

`index.html` is a static chat page for the generated browser index in `data/index/browser`.

> The most capable way to get AI help with this corpus is to clone the repo and
> run an agent CLI — [Claude Code](https://claude.com/claude-code) or
> [Codex](https://github.com/openai/codex) — inside the directory and ask your
> questions directly. `AGENTS.md` teaches the agent to use the bundled search
> CLI. This browser page is the no-install convenience option.

Build the index first:

```bash
npm run build-browser-index
```

Serve the repository root, then open `/web/`:

```bash
python3 -m http.server 8080
```

## Hosting on GitHub Pages

The app is published automatically by `.github/workflows/deploy-pages.yml`. It
rebuilds the browser index from the committed corpus and deploys `web/` plus the
index to GitHub Pages, so nothing under `data/index/` needs to be committed. Set
the repository's **Pages → Source** to **GitHub Actions** once; the live app is
then at `https://jeremysalwen.github.io/OpenMowerBot/`.

`config.js` holds build-time site config. The committed default
(`attachmentsLocal: true`) is for serving the repository locally, where
`data/attachments/` exists. The Pages deploy overwrites it with
`attachmentsLocal: false`, because attachments are not published; attachment
links then fall back to the original Discord CDN URLs.

## How it works

The page is a plain tool-calling agent. There is no hard-coded retrieval
strategy: the selected local LLM drives the conversation and decides, step by
step, which tool to call and with what arguments. Each step the model emits a
single JSON object — either a tool call or a final answer — and the loop feeds
the tool results back as observations until the model answers (or the tool-call
budget is reached).

Tools exposed to the model:

- `search_messages(query, channel?, author?, after?, before?, has_attachment?, limit?)`:
  full-text search over the static lexical index.
- `get_context(message_id, minutes_before?, minutes_after?)`: same-channel
  conversation surrounding a message id returned by a previous search.
- `read_channel(channel, after?, before?, author?, limit?)`: messages from a
  channel within a date range, in chronological order.

Each tool call is shown in the transcript as a collapsible card so you can see
what the agent did.

## Citations

Sources are not embedded in the answer text or repeated below it. The answer
cites messages with bracketed numbers like `[1]`, and the matching source cards
(timestamp, channel, author, snippet, Discord link, and any local attachments)
are listed in the **Sources** panel on the right. Clicking a `[n]` citation
scrolls to and highlights that source. Clicking an earlier assistant turn
switches the panel to that turn's sources.

## Answer models

The single answer-model selector can use:

- `Hosted API (OpenAI-compatible)`, where you supply a base URL, model name, and
  API key. This is the most reliable tool-caller in the browser. It works with
  any OpenAI-compatible chat-completions endpoint — OpenAI, OpenRouter, Groq,
  Together, Anthropic's compatibility endpoint (`https://api.anthropic.com/v1`),
  and local servers such as Ollama or LM Studio. The base URL, model, and key
  are stored only in this browser's `localStorage` and the request goes directly
  from your browser to the endpoint, so the endpoint must allow CORS.
- Chrome's built-in local LLM API when available.
- Specific WebLLM models loaded from CDN with browser-cached WebGPU artifacts.
- Specific Transformers.js models loaded from CDN with browser-cached ONNX artifacts.
- `Evidence only`, which skips the LLM and just lists the top search matches in
  the Sources panel (no tool-calling agent).

In `Auto local model` mode the page tries the built-in model, then WebLLM
(requires WebGPU), then Transformers.js (WASM/CPU). WebLLM does not require
built-in browser LLM support, but it does require WebGPU. Firefox builds without
WebGPU should use Auto or a Transformers.js model. The first model load
downloads model artifacts and can take several minutes.

Note that small local models are not always reliable at producing well-formed
tool calls; the loop tolerates fenced JSON, minor formatting slips, and plain
prose answers, but larger models follow the protocol more consistently.
