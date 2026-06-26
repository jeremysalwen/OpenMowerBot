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

The page is a tool-calling agent built on each engine's **native** function
calling. Tools are given to the model through the chat template (WebLLM uses
OpenAI-style `tools`/`tool_calls`; Transformers.js renders the tools into the
template and the model emits its native tool-call markup, e.g. Qwen's
`<tool_call>…</tool_call>`). There is no hard-coded retrieval strategy: the
selected local LLM decides, step by step, which tool to call and with what
arguments. The loop feeds each tool's results back as a `tool` message — with
numbered, citable sources — until the model answers (or the tool-call budget is
reached).

The agent code lives in `agent.js` (model protocol and loop) and
`index-store.js` (static-index access); both are DOM-free and unit-tested in
`agent.test.mjs` (`node --test web/agent.test.mjs`). `app.js` is the browser
glue (engine loading and rendering).

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

Model reliability for native tool calling varies a lot by size:

- **Qwen3 0.6B** (Transformers.js) is the smallest model that reliably calls
  tools and grounds its answer; it is the default and recommended WASM model.
  Give reasoning models room — the loop allows a large token budget so the
  model can think *and* still emit the tool call.
- **WebLLM** models (Llama 3.2 1B/3B, Qwen2 0.5B) use grammar-constrained
  decoding for structured tool calls and are generally reliable; the 3B model
  is the strongest option when WebGPU is available.
- **SmolLM2 135M** and **Gemma 3 270M** are too small to drive tool calls
  consistently (they tend to narrate intent or loop) and are kept only as
  low-resource fallbacks.

The output handling tolerates `<tool_call>` tags, bare/fenced JSON, reasoning
(`<think>`) blocks, and placeholder argument values, but it cannot make a model
that won't call a tool call one.
