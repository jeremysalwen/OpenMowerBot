import fs from "node:fs/promises";
import path from "node:path";
import { readJsonl } from "./jsonl.mjs";
import { buildCorpusFromDiscordChatExporter, mergeCorpusDirs } from "./corpus.mjs";
import { searchMessages, getConversationContext, formatSearchResult, formatContextMessage } from "./search.mjs";
import { buildEmbeddings, searchEmbeddings } from "./embeddings.mjs";
import { buildBrowserIndex } from "./browser-index.mjs";
import { runDiscordChatExporter } from "./exporter.mjs";
import { downloadSelectedAttachments } from "./attachments.mjs";

export async function main(argv) {
  const [command, ...rest] = argv;
  const options = parseArgs(rest);

  switch (command) {
    case "export":
      await exportDiscord(options);
      break;
    case "ingest":
    case "build-corpus":
      await ingest(options);
      break;
    case "merge-corpus":
      await mergeCorpus(options);
      break;
    case "download-attachments":
      await downloadAttachments(options);
      break;
    case "build-browser-index":
      await browserIndex(options);
      break;
    case "build-embeddings":
      await embeddings(options);
      break;
    case "search":
      await search(options);
      break;
    case "context":
      await context(options);
      break;
    case "vector-search":
      await vectorSearch(options);
      break;
    case "stats":
      await stats(options);
      break;
    case "help":
    case "-h":
    case "--help":
    case undefined:
      printHelp();
      break;
    default:
      throw new Error(`Unknown command: ${command}\n\nRun: discord-history help`);
  }
}

async function ingest(options) {
  const rawDir = path.resolve(options.raw || "data/raw");
  const outDir = path.resolve(options.out || options.corpus || "data/corpus");
  const result = await buildCorpusFromDiscordChatExporter(rawDir, outDir, {
    allowEmpty: Boolean(options.allowEmpty),
  });

  console.log(`Built corpus with ${result.manifest.messageCount} messages from ${result.sourceFileCount} files.`);
  console.log(`Wrote ${result.messagesPath}`);
  console.log(`Wrote ${result.manifestPath}`);
}

async function exportDiscord(options) {
  const result = await runDiscordChatExporter({
    ...options,
    incremental: Boolean(options.incremental),
  });

  if (result.after) {
    console.log(`Exported messages after ${result.after} into ${result.rawDir}`);
  } else {
    console.log(`Exported messages into ${result.rawDir}`);
  }
}

async function mergeCorpus(options) {
  const baseDir = path.resolve(options.base || "data/corpus");
  const deltaDir = path.resolve(options.delta || "data/corpus-incremental");
  const outDir = path.resolve(options.out || "data/corpus");
  const result = await mergeCorpusDirs(baseDir, deltaDir, outDir);

  console.log(`Merged corpus now has ${result.manifest.messageCount} messages.`);
  console.log(`Wrote ${result.messagesPath}`);
  console.log(`Wrote ${result.manifestPath}`);
}

async function downloadAttachments(options) {
  const stats = await downloadSelectedAttachments(options);

  console.log(`Considered attachments: ${stats.considered}`);
  console.log(`Selected attachments: ${stats.selected}`);
  console.log(`Selected bytes: ${stats.selectedBytes}`);
  console.log(`Downloaded attachments: ${stats.downloaded}`);
  console.log(`Skipped existing: ${stats.skippedExisting}`);
  console.log(`Skipped by size: ${stats.skippedSize}`);
  console.log(`Skipped by type: ${stats.skippedType}`);
  console.log(`Failed: ${stats.failed}`);
  console.log(`Downloaded bytes: ${stats.bytes}`);
}

async function browserIndex(options) {
  const corpusDir = path.resolve(options.corpus || "data/corpus");
  const outDir = path.resolve(options.out || options.index || "data/index/browser");
  const result = await buildBrowserIndex(corpusDir, outDir, options);

  console.log(`Built browser index with ${result.manifest.messageCount} messages.`);
  console.log(`Wrote ${result.manifestPath}`);
  console.log(`Wrote ${result.archivePath}`);
}

async function embeddings(options) {
  const corpusDir = path.resolve(options.corpus || "data/corpus");
  const indexDir = path.resolve(options.out || options.index || "data/index");
  const result = await buildEmbeddings(corpusDir, indexDir, options);

  console.log(`Built embeddings with ${result.manifest.recordCount} records.`);
  console.log(`Model: ${result.manifest.model}`);
  console.log(`Dimensions: ${result.manifest.dims || "unknown"}`);
  console.log(`Wrote ${result.embeddingsPath}`);
  console.log(`Wrote ${result.manifestPath}`);
}

async function search(options) {
  const corpusDir = path.resolve(options.corpus || options.index || "data/corpus");
  const results = await searchMessages(corpusDir, {
    q: options.q || options.query || "",
    author: options.author,
    channel: options.channel,
    after: options.after,
    before: options.before,
    hasAttachment: Boolean(options["has-attachment"] || options.hasAttachment),
    attachment: options.attachment,
    limit: options.limit || 20,
  });

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  for (const result of results) {
    console.log(formatSearchResult(result));
  }
}

async function context(options) {
  const corpusDir = path.resolve(options.corpus || options.index || "data/corpus");
  const messages = await getConversationContext(corpusDir, {
    messageId: options["message-id"] || options.messageId,
    channel: options.channel,
    around: options.around,
    after: options.after,
    before: options.before,
    minutesBefore: options["minutes-before"] || options.minutesBefore,
    minutesAfter: options["minutes-after"] || options.minutesAfter,
    limit: options.limit || 80,
  });

  if (options.json) {
    console.log(JSON.stringify(messages, null, 2));
    return;
  }

  for (const message of messages) {
    console.log(formatContextMessage(message));
  }
}

async function vectorSearch(options) {
  const indexDir = path.resolve(options.index || "data/index");
  const corpusDir = path.resolve(options.corpus || "data/corpus");
  const vector = await readVector(options);
  const results = await searchEmbeddings(indexDir, vector, {
    limit: options.limit || 20,
  });

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const messages = await loadMessagesById(path.join(corpusDir, "messages.jsonl"), results.map((result) => result.id));
  for (const result of results) {
    const message = messages.get(result.id);
    if (message) {
      console.log(`${result.score.toFixed(4)} ${formatSearchResult({ score: result.score, message })}`);
    } else {
      console.log(`${result.score.toFixed(4)} ${result.id}`);
    }
  }
}

async function stats(options) {
  const corpusDir = path.resolve(options.corpus || options.index || "data/corpus");
  const manifest = JSON.parse(await fs.readFile(path.join(corpusDir, "manifest.json"), "utf8"));
  const channelCount = Object.keys(manifest.channels || {}).length;
  const authorCount = Object.keys(manifest.authors || {}).length;

  console.log(`Messages: ${manifest.messageCount}`);
  console.log(`Sources: ${manifest.sourceFileCount || 0}`);
  console.log(`Channels: ${channelCount}`);
  console.log(`Authors: ${authorCount}`);
  console.log(`Attachment messages: ${manifest.attachmentMessageCount}`);
  if (manifest.attachmentCount !== undefined) {
    console.log(`Attachments: ${manifest.attachmentCount}`);
  }
  if (manifest.attachmentBytes !== undefined) {
    console.log(`Attachment bytes: ${manifest.attachmentBytes}`);
  }
  console.log(`Date range: ${manifest.dateRange.after || "unknown"} to ${manifest.dateRange.before || "unknown"}`);
}

async function readVector(options) {
  const raw = options.vector
    || (options["vector-file"] ? await fs.readFile(path.resolve(options["vector-file"]), "utf8") : null)
    || (options.vectorFile ? await fs.readFile(path.resolve(options.vectorFile), "utf8") : null);

  if (!raw) {
    throw new Error("vector-search requires --vector '[0.1, 0.2]' or --vector-file query-vector.json");
  }

  const trimmed = String(raw).trim();
  const parsed = trimmed.startsWith("[")
    ? JSON.parse(trimmed)
    : trimmed.split(",").map((value) => Number(value.trim()));

  if (!Array.isArray(parsed) || parsed.some((value) => !Number.isFinite(value))) {
    throw new Error("Query vector must be a JSON array or comma-separated list of numbers.");
  }

  return parsed;
}

async function loadMessagesById(messagesPath, ids) {
  const wanted = new Set(ids);
  const messages = new Map();

  for await (const message of readJsonl(messagesPath)) {
    if (wanted.has(message.id)) {
      messages.set(message.id, message);
      if (messages.size === wanted.size) {
        break;
      }
    }
  }

  return messages;
}

function parseArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg.startsWith("--")) {
      options._ = options._ || [];
      options._.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

    if (inlineValue !== undefined) {
      options[rawKey] = inlineValue;
      options[key] = inlineValue;
    } else if (args[index + 1] && !args[index + 1].startsWith("--")) {
      options[rawKey] = args[index + 1];
      options[key] = args[index + 1];
      index += 1;
    } else {
      options[rawKey] = true;
      options[key] = true;
    }
  }

  return options;
}

function printHelp() {
  console.log(`DiscordHistory

Usage:
  discord-history export --incremental
  discord-history ingest --raw data/raw --out data/corpus
  discord-history merge-corpus --delta data/corpus-incremental
  discord-history download-attachments --dry-run
  discord-history build-browser-index
  discord-history build-embeddings --model Xenova/all-MiniLM-L6-v2
  discord-history search --q "gps fix" --channel general --after 2024-01-01
  discord-history context --message-id 1234567890
  discord-history context --channel general --after 2024-01-01 --before 2024-01-02
  discord-history vector-search --vector-file query-vector.json
  discord-history stats

Commands:
  export   Run DiscordChatExporter. Use --incremental to export after the corpus watermark.
  ingest   Build readable data/corpus/messages.jsonl from DiscordChatExporter JSON.
  build-corpus
           Alias for ingest.
  merge-corpus
           Merge an incremental corpus into the checked-in corpus by message ID.
  download-attachments
           Download selected small/useful attachments listed in the corpus.
  build-browser-index
           Build static JSON shards, lexical term buckets, and HTML archive pages.
  build-embeddings
           Build data/index/embeddings.jsonl using @huggingface/transformers.
  search   Search the readable corpus with text and metadata filters.
  context  Show same-channel conversation around a message or channel time range.
  vector-search
           Search data/index/embeddings.jsonl with a precomputed query vector.
  stats    Print corpus coverage from data/corpus/manifest.json.

Export options:
  --incremental         Export only messages after data/corpus/manifest.json dateRange.before.
  --after DATE_OR_ID    Override the incremental watermark.
  --raw DIR             Destination for raw DiscordChatExporter JSON.
  --parallel N          Channel export concurrency, default 8.
  --retries N           Retry rate-limited exporter failures, default 0.
  --retry-delay-seconds N
                         Minimum wait before retrying a rate-limited export, default 60.
  --partition SIZE      Export partition size, default 25mb.
  --exporter PATH       DiscordChatExporter.Cli path.
  --media               Ask DiscordChatExporter to download media too.
  --media-dir DIR       Media destination when --media is enabled.

Attachment download:
  --max-size BYTES      Max attachment size, default 500000.
  --extensions LIST     Comma-separated extensions, or "all".
  --dry-run             Count what would be downloaded.
  --force               Re-download existing files.

Browser index:
  --out DIR             Output directory, default data/index/browser.
  --shard-size N        Messages per browser shard, default 1000.
  --max-postings N      Max postings retained per search term, default 50000.
  --archive-page-size N Messages per static archive page, default 200.

Embedding build:
  --model NAME          Transformers.js feature-extraction model, default Xenova/all-MiniLM-L6-v2.
  --batch-size N        Embedding batch size, default 8.
  --max-chars N         Max source text chars per message, default 1800.
  --device NAME         Transformers.js device, default cpu.
  --dtype NAME          Transformers.js dtype, default auto.
  --limit N             Debug limit for embedding records.

Search filters:
  --q TEXT              Text query.
  --author TEXT         Author id, username, or nickname substring.
  --channel TEXT        Channel id or name substring.
  --after DATE          Include messages on or after a parseable date.
  --before DATE         Include messages on or before a parseable date.
  --has-attachment      Only messages with attachments.
  --attachment TEXT     Attachment filename, content type, or URL substring.
  --limit N             Result limit, default 20.
  --json                Print structured JSON results.

Context:
  --message-id ID       Center context around this Discord message id.
  --channel TEXT        Channel id or name substring for time-range context.
  --around DATE         Center time when not using --message-id.
  --after DATE          Start of a channel time range.
  --before DATE         End of a channel time range.
  --minutes-before N    Minutes before --message-id/--around, default 45.
  --minutes-after N     Minutes after --message-id/--around, default 45.
  --limit N             Max context messages, default 80.
  --json                Print structured JSON messages.

Vector search:
  --vector JSON         Query vector as a JSON array or comma-separated numbers.
  --vector-file PATH    File containing the query vector.
`);
}
