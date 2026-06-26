# Browser App

`index.html` is a static chat page for the generated browser index in `data/index/browser`.

Build the index first:

```bash
npm run build-browser-index
```

Serve the repository root, then open `/web/`:

```bash
python3 -m http.server 8080
```

The page supports a chat interface, channel/author/date/attachment filters, Discord source links, and selected local attachment links. Each question runs a bounded agent loop before answering. The loop can make multiple tool calls, inspect observations, and stop when it has enough cited context.

Available browser tools:

- `searchDiscord`: finds likely messages from the static lexical index.
- `getConversationContext`: expands a promising message into same-channel surrounding conversation.
- `getChannelRange`: reads a channel time range directly when the filters define one.

The answer engine can use:

- Chrome's built-in local LLM API when available.
- WebLLM loaded from CDN with a browser-cached WebGPU model.
- Transformers.js loaded from CDN with a browser-cached ONNX model.
- Evidence-only mode when no local LLM is available.

WebLLM does not require built-in browser LLM support, but it does require WebGPU. Firefox builds without WebGPU should use Auto LLM or Transformers.js mode, which runs through WASM/CPU by default. The first model load downloads model artifacts and can take several minutes.
