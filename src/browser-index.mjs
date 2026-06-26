import fs from "node:fs/promises";
import path from "node:path";
import { readJsonl } from "./jsonl.mjs";

const DEFAULT_SHARD_SIZE = 1000;
const DEFAULT_MAX_POSTINGS = 50000;

export async function buildBrowserIndex(corpusDir, outDir, options = {}) {
  const messagesPath = path.join(corpusDir, "messages.jsonl");
  const shardSize = Number(options.shardSize || DEFAULT_SHARD_SIZE);
  const maxPostings = Number(options.maxPostings || DEFAULT_MAX_POSTINGS);
  const minTermLength = Number(options.minTermLength || 2);
  const messagesDir = path.join(outDir, "messages");
  const searchDir = path.join(outDir, "search");

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(messagesDir, { recursive: true });
  await fs.mkdir(searchDir, { recursive: true });

  const termPostings = new Map();
  const shards = [];
  let shard = [];
  let ordinal = 0;

  for await (const message of readJsonl(messagesPath)) {
    const compact = compactBrowserMessage(message, ordinal);
    shard.push(compact);
    addTerms(termPostings, message, ordinal, { minTermLength, maxPostings });
    ordinal += 1;

    if (shard.length >= shardSize) {
      shards.push(await writeMessageShard(messagesDir, shards.length, shard));
      shard = [];
    }
  }

  if (shard.length > 0) {
    shards.push(await writeMessageShard(messagesDir, shards.length, shard));
  }

  const termBuckets = await writeTermBuckets(searchDir, termPostings);
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    corpus: path.relative(outDir, corpusDir) || ".",
    messageCount: ordinal,
    messageShardSize: shardSize,
    messageShards: shards,
    termBuckets,
    files: {
      messages: "messages/messages-000.json",
      search: "search/terms-0-9.json",
    },
  };

  const manifestPath = path.join(outDir, "manifest.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    manifest,
    manifestPath,
    outDir,
  };
}

function compactBrowserMessage(message, ordinal) {
  return {
    o: ordinal,
    id: message.id,
    t: message.timestamp,
    ch: message.channelName || message.channelId || null,
    chId: message.channelId || null,
    a: message.authorNickname || message.authorName || message.authorId || null,
    aId: message.authorId || null,
    text: message.content || "",
    url: message.messageUrl || null,
    replyUrl: message.replyToMessageUrl || null,
    at: (message.attachments || []).map((attachment) => ({
      name: attachment.fileName || null,
      type: attachment.contentType || null,
      path: attachment.localPath || null,
      url: attachment.url || null,
    })),
  };
}

async function writeMessageShard(messagesDir, index, records) {
  const fileName = `messages-${String(index).padStart(3, "0")}.json`;
  const filePath = path.join(messagesDir, fileName);
  await fs.writeFile(filePath, `${JSON.stringify(records)}\n`);
  return {
    index,
    file: path.posix.join("messages", fileName),
    firstOrdinal: records[0]?.o ?? null,
    lastOrdinal: records.at(-1)?.o ?? null,
    count: records.length,
  };
}

async function writeTermBuckets(searchDir, termPostings) {
  const buckets = new Map();

  for (const [term, postings] of termPostings) {
    const bucket = termBucket(term);
    if (!buckets.has(bucket)) {
      buckets.set(bucket, {});
    }
    buckets.get(bucket)[term] = postings;
  }

  const written = [];
  for (const [bucket, terms] of [...buckets.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const fileName = `terms-${bucket}.json`;
    await fs.writeFile(path.join(searchDir, fileName), `${JSON.stringify(terms)}\n`);
    written.push({
      bucket,
      file: path.posix.join("search", fileName),
      termCount: Object.keys(terms).length,
    });
  }

  return written;
}

function addTerms(termPostings, message, ordinal, options) {
  const fields = [
    message.content,
    message.channelName,
    message.authorName,
    message.authorNickname,
    ...(message.attachments || []).map((attachment) => attachment.fileName),
  ];

  for (const term of new Set(tokenize(fields.join(" "), options.minTermLength))) {
    const postings = termPostings.get(term) || [];
    if (postings.length < options.maxPostings) {
      postings.push(ordinal);
    }
    termPostings.set(term, postings);
  }
}

function tokenize(input, minTermLength) {
  return String(input)
    .toLowerCase()
    .split(/[^a-z0-9_#.-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= minTermLength);
}

function termBucket(term) {
  const first = term[0] || "_";
  if (first >= "0" && first <= "9") return "0-9";
  if (first >= "a" && first <= "z") return first;
  return "_";
}
