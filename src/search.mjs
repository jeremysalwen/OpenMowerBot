import path from "node:path";
import { readJsonl } from "./jsonl.mjs";

export async function searchMessages(indexDir, options = {}) {
  const messagesPath = path.join(indexDir, "messages.jsonl");
  const query = normalizeQuery(options.q || "");
  const limit = Number(options.limit || 20);
  const results = [];

  for await (const message of readJsonl(messagesPath)) {
    if (!matchesFilters(message, options)) {
      continue;
    }

    const score = scoreMessage(message, query);
    if (query.terms.length > 0 && score <= 0) {
      continue;
    }

    results.push({ score, message });
    results.sort((a, b) => b.score - a.score || compareTimestampDesc(a.message, b.message));

    if (results.length > limit * 4) {
      results.length = limit * 2;
    }
  }

  return results
    .sort((a, b) => b.score - a.score || compareTimestampDesc(a.message, b.message))
    .slice(0, limit);
}

export function formatSearchResult(result) {
  const message = result.message;
  const author = message.authorNickname || message.authorName || message.authorId || "unknown";
  const channel = message.channelName || message.channelId || "unknown";
  const timestamp = message.timestamp || "unknown-time";
  const content = singleLine(message.content || "");
  const attachments = message.attachmentCount > 0
    ? ` attachments=${message.attachmentCount}`
    : "";

  return `[${timestamp}] #${channel} ${author}: ${content}${attachments}`;
}

function normalizeQuery(input) {
  const phrase = input.trim().toLowerCase();
  return {
    phrase,
    terms: tokenize(phrase),
  };
}

function scoreMessage(message, query) {
  if (query.terms.length === 0) {
    return 0;
  }

  const haystack = [
    message.content,
    message.authorName,
    message.authorNickname,
    message.channelName,
    ...((message.attachments || []).map((attachment) => attachment.fileName || "")),
  ].join(" ").toLowerCase();

  let score = 0;
  if (query.phrase && haystack.includes(query.phrase)) {
    score += 10;
  }

  for (const term of query.terms) {
    if (haystack.includes(term)) {
      score += 1;
    }
  }

  if (message.content && message.content.toLowerCase().includes(query.phrase)) {
    score += 5;
  }

  return score;
}

function matchesFilters(message, options) {
  if (options.author && !fieldIncludes([message.authorId, message.authorName, message.authorNickname], options.author)) {
    return false;
  }

  if (options.channel && !fieldIncludes([message.channelId, message.channelName], options.channel)) {
    return false;
  }

  if (options.after && compareDate(message.timestamp, options.after) < 0) {
    return false;
  }

  if (options.before && compareDate(message.timestamp, options.before) > 0) {
    return false;
  }

  if (options.hasAttachment && Number(message.attachmentCount || 0) <= 0) {
    return false;
  }

  if (options.attachment && !attachmentMatches(message, options.attachment)) {
    return false;
  }

  return true;
}

function attachmentMatches(message, query) {
  const needle = query.toLowerCase();
  return (message.attachments || []).some((attachment) => {
    return [attachment.fileName, attachment.contentType, attachment.url]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });
}

function fieldIncludes(values, query) {
  const needle = String(query).toLowerCase();
  return values
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

function compareDate(value, boundary) {
  return Date.parse(value || 0) - Date.parse(boundary);
}

function compareTimestampDesc(left, right) {
  return (Date.parse(right.timestamp || 0) || 0) - (Date.parse(left.timestamp || 0) || 0);
}

function tokenize(input) {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_#.-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
}

function singleLine(value) {
  return value.replace(/\s+/g, " ").trim();
}
