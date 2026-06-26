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

The page supports lexical search, channel/author/date/attachment filters, Discord source links, and selected local attachment links. The Answer button uses a browser-provided local language model when one is available; otherwise it falls back to ranked evidence.
