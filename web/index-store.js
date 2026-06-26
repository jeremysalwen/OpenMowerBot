// DOM-free access layer over the static browser index.
//
// Everything here is pure data: it depends only on an injected `fetchJson`
// (browser `fetch` in the app, a filesystem reader in tests) and the index
// root path. app.js wires it to the network; the end-to-end test wires it to
// disk so the exact same retrieval code runs under test.

export const MAX_RESULTS = 48;
const MAX_CANDIDATES = 900;
const CONTEXT_ORDINAL_SCAN = 2500;

export function createStore({ fetchJson, indexRoot }) {
  const state = {
    manifest: null,
    termBuckets: new Map(),
    messageShards: new Map(),
    seenById: new Map(),
  };

  async function loadManifest() {
    state.manifest = await fetchJson(`${indexRoot}manifest.json`);
    return state.manifest;
  }

  function manifest() {
    if (!state.manifest) throw new Error("Index manifest not loaded yet.");
    return state.manifest;
  }

  function seenById(id) {
    return state.seenById.get(String(id)) || null;
  }

  async function searchMessages(args) {
    const terms = tokenize(args.query);
    const scores = new Map();
    const count = manifest().messageCount;

    if (terms.length === 0) {
      for (let ordinal = count - 1; ordinal >= 0 && scores.size < MAX_CANDIDATES; ordinal -= 1) {
        scores.set(ordinal, 0);
      }
    } else {
      for (const term of terms) {
        const postings = await postingsForTerm(term);
        const weight = term.includes(".") || term.includes("_") || term.includes("-") ? 2 : 1;
        for (const ordinal of postings) {
          scores.set(ordinal, (scores.get(ordinal) || 0) + weight);
        }
      }
    }

    const candidates = [...scores.entries()]
      .sort((left, right) => right[1] - left[1] || right[0] - left[0])
      .slice(0, MAX_CANDIDATES);

    const messages = [];
    for (const [ordinal, score] of candidates) {
      const message = await messageForOrdinal(ordinal);
      if (message && matchesFilters(message, args)) {
        messages.push({ message, score });
      }
      if (messages.length >= (args.limit || MAX_RESULTS)) break;
    }

    return messages;
  }

  async function getConversationContext(args) {
    const centerTime = Date.parse(args.centerTimestamp || 0);
    if (!Number.isFinite(centerTime)) return [];

    const fromTime = centerTime - args.minutesBefore * 60 * 1000;
    const toTime = centerTime + args.minutesAfter * 60 * 1000;
    const start = Math.max(0, args.centerOrdinal - CONTEXT_ORDINAL_SCAN);
    const end = Math.min(manifest().messageCount - 1, args.centerOrdinal + CONTEXT_ORDINAL_SCAN);
    const matches = [];

    for (let ordinal = start; ordinal <= end; ordinal += 1) {
      const message = await messageForOrdinal(ordinal);
      if (!message) continue;
      if (!sameChannel(message, args)) continue;

      const messageTime = Date.parse(message.t || 0);
      if (!Number.isFinite(messageTime)) continue;
      if (messageTime < fromTime || messageTime > toTime) continue;

      matches.push({ message, distance: Math.abs(messageTime - centerTime) });
    }

    return matches
      .sort((left, right) => left.distance - right.distance)
      .slice(0, args.maxMessages)
      .map((entry) => entry.message)
      .sort((left, right) => Date.parse(left.t || 0) - Date.parse(right.t || 0));
  }

  async function getChannelRange(args) {
    const after = args.after ? Date.parse(args.after) : Number.NEGATIVE_INFINITY;
    const before = args.before ? Date.parse(`${args.before}T23:59:59`) : Number.POSITIVE_INFINITY;
    const messages = [];
    const count = manifest().messageCount;

    for (let ordinal = 0; ordinal < count; ordinal += 1) {
      const message = await messageForOrdinal(ordinal);
      if (!message) continue;
      if (args.channel && !includes(message.ch, args.channel) && message.chId !== args.channel) continue;
      if (args.author && !includes(message.a, args.author) && message.aId !== args.author) continue;
      if (args.attachments && (!message.at || message.at.length === 0)) continue;

      const messageTime = Date.parse(message.t || 0);
      if (!Number.isFinite(messageTime) || messageTime < after || messageTime > before) continue;
      messages.push(message);
      if (messages.length >= (args.limit || 80)) break;
    }

    return messages;
  }

  async function postingsForTerm(term) {
    const bucket = termBucket(term);
    const terms = await loadTermBucket(bucket);
    return terms[term] || [];
  }

  async function loadTermBucket(bucket) {
    if (!state.termBuckets.has(bucket)) {
      const bucketInfo = manifest().termBuckets.find((entry) => entry.bucket === bucket);
      state.termBuckets.set(bucket, bucketInfo ? await fetchJson(`${indexRoot}${bucketInfo.file}`) : {});
    }
    return state.termBuckets.get(bucket);
  }

  async function messageForOrdinal(ordinal) {
    const shardIndex = Math.floor(ordinal / manifest().messageShardSize);
    if (!state.messageShards.has(shardIndex)) {
      const shard = manifest().messageShards.find((entry) => entry.index === shardIndex);
      if (!shard) return null;
      const records = await fetchJson(`${indexRoot}${shard.file}`);
      state.messageShards.set(shardIndex, records);
      for (const record of records) {
        if (record && record.id != null) state.seenById.set(String(record.id), record);
      }
    }

    return state.messageShards.get(shardIndex).find((message) => message.o === ordinal) || null;
  }

  return {
    loadManifest,
    manifest,
    seenById,
    searchMessages,
    getConversationContext,
    getChannelRange,
    messageForOrdinal,
  };
}

function sameChannel(message, args) {
  if (args.channelId && message.chId) return message.chId === args.channelId;
  return message.ch === args.channelName;
}

function matchesFilters(message, args) {
  if (args.channel && !includes(message.ch, args.channel)) return false;
  if (args.author && !includes(message.a, args.author)) return false;
  if (args.after && Date.parse(message.t || 0) < Date.parse(args.after)) return false;
  if (args.before && Date.parse(message.t || 0) > Date.parse(`${args.before}T23:59:59`)) return false;
  if (args.attachments && (!message.at || message.at.length === 0)) return false;
  return true;
}

export function tokenize(input) {
  return String(input)
    .toLowerCase()
    .split(/[^a-z0-9_#.-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
}

function termBucket(term) {
  const first = term[0] || "_";
  if (first >= "0" && first <= "9") return "0-9";
  if (first >= "a" && first <= "z") return first;
  return "_";
}

export function includes(value, query) {
  return String(value || "").toLowerCase().includes(String(query).toLowerCase());
}

export function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}
