# Browser App

`index.html` is a static search page for the generated browser index in `data/index/browser`.

Build the index first:

```bash
npm run build-browser-index
```

Serve the repository root, then open `/web/`:

```bash
python3 -m http.server 8080
```

The page supports lexical search, channel/author/date/attachment filters, Discord source links, and selected local attachment links. The Answer button can use:

- Chrome's built-in local LLM API when available.
- WebLLM loaded from CDN with a browser-cached WebGPU model.
- Transformers.js loaded from CDN with a browser-cached ONNX model.
- Evidence-only mode when no local LLM is available.

WebLLM does not require built-in browser LLM support, but it does require WebGPU. Firefox builds without WebGPU should use Auto LLM or Transformers.js mode, which runs through WASM/CPU by default. The first model load downloads model artifacts and can take several minutes.
