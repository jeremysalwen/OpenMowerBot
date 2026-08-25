import fs from "node:fs/promises";
import path from "node:path";
import { readJsonl } from "./jsonl.mjs";

// The corpus is split into one file per calendar year.
//
// A single messages.jsonl grew past 98 MB, and GitHub rejects any file over
// 100 MB outright, which would have stopped the nightly update from pushing.
// Year shards keep every file far below that ceiling and confine day-to-day
// growth to the current year, while staying plain greppable JSONL:
// `grep data/corpus/messages-*.jsonl` still works.
const SHARD_PREFIX = "messages-";
const SHARD_SUFFIX = ".jsonl";
const LEGACY_MESSAGES_FILE = "messages.jsonl";
// Messages without a parseable timestamp; sorts last, after every year.
const UNDATED_KEY = "undated";

export function shardKeyForTimestamp(timestamp) {
  const year = String(timestamp || "").slice(0, 4);
  return /^\d{4}$/.test(year) ? year : UNDATED_KEY;
}

export function shardFileName(key) {
  return `${SHARD_PREFIX}${key}${SHARD_SUFFIX}`;
}

// Corpus message files in read order. Year shards sort chronologically because
// the keys are zero-padded years, and UNDATED_KEY sorts after them all.
//
// A corpus that still has the pre-split messages.jsonl and no shards is read
// as-is, so an older checkout keeps working.
export async function listCorpusMessageFiles(corpusDir) {
  let entries = [];
  try {
    entries = await fs.readdir(corpusDir);
  } catch {
    return [];
  }

  const shards = entries
    .filter((name) => name.startsWith(SHARD_PREFIX) && name.endsWith(SHARD_SUFFIX))
    .sort();

  if (shards.length > 0) {
    return shards.map((name) => path.join(corpusDir, name));
  }

  // Never mix the two layouts: that would yield every message twice.
  return entries.includes(LEGACY_MESSAGES_FILE)
    ? [path.join(corpusDir, LEGACY_MESSAGES_FILE)]
    : [];
}

// Every corpus message, in timestamp order across shards.
export async function* readCorpusMessages(corpusDir) {
  for (const file of await listCorpusMessageFiles(corpusDir)) {
    yield* readJsonl(file);
  }
}

// Writes messages into per-year files, opening each shard on first use so a
// build never holds the whole corpus in memory.
export class CorpusShardWriter {
  constructor(outDir) {
    this.outDir = outDir;
    this.handles = new Map();
  }

  async write(message) {
    const key = shardKeyForTimestamp(message?.timestamp);
    let handle = this.handles.get(key);
    if (!handle) {
      handle = await fs.open(path.join(this.outDir, shardFileName(key)), "w");
      this.handles.set(key, handle);
    }
    await handle.write(`${JSON.stringify(message)}\n`);
  }

  async close() {
    for (const handle of this.handles.values()) {
      await handle.close();
    }
    // The split replaces the single-file layout; leaving it behind would double
    // every message for any reader that preferred it.
    await fs.rm(path.join(this.outDir, LEGACY_MESSAGES_FILE), { force: true });
    return this.fileNames();
  }

  fileNames() {
    return [...this.handles.keys()].sort().map(shardFileName);
  }
}
