import fs from "node:fs/promises";
import path from "node:path";
import { readJsonl } from "./jsonl.mjs";

const DEFAULT_SHARD_SIZE = 1000;
const DEFAULT_MAX_POSTINGS = 50000;
const DEFAULT_ARCHIVE_PAGE_SIZE = 200;

export async function buildBrowserIndex(corpusDir, outDir, options = {}) {
  const messagesPath = path.join(corpusDir, "messages.jsonl");
  const shardSize = positiveInteger(options.shardSize, DEFAULT_SHARD_SIZE);
  const maxPostings = positiveInteger(options.maxPostings, DEFAULT_MAX_POSTINGS);
  const minTermLength = positiveInteger(options.minTermLength, 2);
  const archivePageSize = positiveInteger(options.archivePageSize || options["archive-page-size"], DEFAULT_ARCHIVE_PAGE_SIZE);
  const generatedAt = new Date().toISOString();
  const messagesDir = path.join(outDir, "messages");
  const searchDir = path.join(outDir, "search");
  const archiveDir = path.join(outDir, "archive");

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(messagesDir, { recursive: true });
  await fs.mkdir(searchDir, { recursive: true });

  const termPostings = new Map();
  const archiveChannels = new Map();
  const shards = [];
  let shard = [];
  let ordinal = 0;

  for await (const message of readJsonl(messagesPath)) {
    const compact = compactBrowserMessage(message, ordinal);
    shard.push(compact);
    addTerms(termPostings, message, ordinal, { minTermLength, maxPostings });
    addArchiveMessage(archiveChannels, message, ordinal);
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
  const archive = await writeStaticArchive(archiveDir, archiveChannels, {
    generatedAt,
    pageSize: archivePageSize,
  });
  const manifest = {
    schemaVersion: 1,
    generatedAt,
    corpus: path.relative(outDir, corpusDir) || ".",
    messageCount: ordinal,
    messageShardSize: shardSize,
    messageShards: shards,
    termBuckets,
    archive,
    files: {
      messages: "messages/messages-000.json",
      search: "search/terms-0-9.json",
      archive: archive.root,
    },
  };

  const manifestPath = path.join(outDir, "manifest.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    manifest,
    manifestPath,
    archivePath: path.join(archiveDir, "index.html"),
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

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }
  return Math.round(number);
}

function addArchiveMessage(channels, message, ordinal) {
  const key = message.channelId || message.channelName || "unknown";

  if (!channels.has(key)) {
    channels.set(key, {
      id: message.channelId || null,
      name: message.channelName || "unknown",
      categoryName: message.categoryName || null,
      guildName: message.guildName || null,
      firstTimestamp: null,
      lastTimestamp: null,
      attachmentCount: 0,
      messages: [],
    });
  }

  const channel = channels.get(key);
  if (!channel.categoryName && message.categoryName) channel.categoryName = message.categoryName;
  if (!channel.guildName && message.guildName) channel.guildName = message.guildName;
  channel.firstTimestamp = minIso(channel.firstTimestamp, message.timestamp);
  channel.lastTimestamp = maxIso(channel.lastTimestamp, message.timestamp);
  channel.attachmentCount += Number(message.attachmentCount || 0);
  channel.messages.push(compactArchiveMessage(message, ordinal));
}

function compactArchiveMessage(message, ordinal) {
  return {
    ordinal,
    id: message.id || null,
    timestamp: message.timestamp || null,
    content: message.content || "",
    authorId: message.authorId || null,
    authorName: message.authorName || null,
    authorNickname: message.authorNickname || null,
    authorIsBot: Boolean(message.authorIsBot),
    messageUrl: message.messageUrl || null,
    replyToMessageUrl: message.replyToMessageUrl || null,
    attachments: (message.attachments || []).map((attachment) => ({
      fileName: attachment.fileName || null,
      contentType: attachment.contentType || null,
      fileSizeBytes: attachment.fileSizeBytes || null,
      url: attachment.url || null,
      localPath: attachment.localPath || null,
    })),
  };
}

async function writeStaticArchive(archiveDir, channelsMap, options) {
  await fs.mkdir(archiveDir, { recursive: true });
  await fs.writeFile(path.join(archiveDir, "styles.css"), archiveCss());

  const channels = [...channelsMap.values()]
    .sort(compareChannels)
    .map((channel) => prepareArchiveChannel(channel, options.pageSize));

  assignChannelSlugs(channels);

  let pageCount = 1;
  for (const channel of channels) {
    pageCount += await writeChannelArchive(archiveDir, channel, options);
  }

  await fs.writeFile(
    path.join(archiveDir, "index.html"),
    renderArchiveIndex(channels, options),
  );

  return {
    root: "archive/index.html",
    pageSize: options.pageSize,
    channelCount: channels.length,
    pageCount,
  };
}

function prepareArchiveChannel(channel, pageSize) {
  channel.messages.sort(compareArchiveMessages);
  const pageCount = Math.max(1, Math.ceil(channel.messages.length / pageSize));
  const fileWidth = Math.max(3, String(pageCount).length);
  const pages = [];
  const days = new Map();
  const months = new Map();

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const start = pageIndex * pageSize;
    const end = Math.min(channel.messages.length, start + pageSize);
    const messages = channel.messages.slice(start, end);
    const pageNumber = pageIndex + 1;
    const page = {
      pageNumber,
      file: pageFileName(pageNumber, fileWidth),
      start,
      end,
      count: messages.length,
      firstTimestamp: messages[0]?.timestamp || null,
      lastTimestamp: messages.at(-1)?.timestamp || null,
      firstDate: dateKey(messages[0]?.timestamp),
      lastDate: dateKey(messages.at(-1)?.timestamp),
    };

    pages.push(page);

    for (const message of messages) {
      const dayKey = dateKey(message.timestamp);
      if (!dayKey) continue;

      if (!days.has(dayKey)) {
        days.set(dayKey, {
          date: dayKey,
          pageNumber,
          file: page.file,
          count: 0,
        });
      }
      days.get(dayKey).count += 1;

      const monthKey = dayKey.slice(0, 7);
      if (!months.has(monthKey)) {
        months.set(monthKey, {
          month: monthKey,
          firstDate: dayKey,
          pageNumber,
          file: page.file,
          count: 0,
        });
      }
      months.get(monthKey).count += 1;
    }
  }

  return {
    ...channel,
    pageCount,
    fileWidth,
    pages,
    days: [...days.values()],
    months: [...months.values()],
  };
}

function assignChannelSlugs(channels) {
  const used = new Set();

  for (const channel of channels) {
    const base = slugify(channel.name || channel.id || "channel").slice(0, 70) || "channel";
    const idSuffix = channel.id ? `-${channel.id}` : "";
    let slug = `${base}${idSuffix}`;
    let suffix = 2;

    while (used.has(slug)) {
      slug = `${base}-${suffix}`;
      suffix += 1;
    }

    used.add(slug);
    channel.slug = slug;
  }
}

async function writeChannelArchive(archiveDir, channel, options) {
  const channelDir = path.join(archiveDir, "channels", channel.slug);
  await fs.mkdir(channelDir, { recursive: true });

  await fs.writeFile(
    path.join(channelDir, "index.html"),
    renderChannelIndex(channel, options),
  );
  await fs.writeFile(
    path.join(channelDir, "dates.html"),
    renderDateIndex(channel, options),
  );

  for (const page of channel.pages) {
    const messages = channel.messages.slice(page.start, page.end);
    await fs.writeFile(
      path.join(channelDir, page.file),
      renderChannelPage(channel, page, messages, options),
    );
  }

  return channel.pages.length + 2;
}

function renderArchiveIndex(channels, options) {
  const totalMessages = channels.reduce((sum, channel) => sum + channel.messages.length, 0);
  const grouped = groupChannelsByCategory(channels);
  const body = `
    <header class="site-header">
      <p class="eyebrow">OpenMower Discord History</p>
      <h1>Static Chat Archive</h1>
      <p>${formatCount(totalMessages)} messages across ${formatCount(channels.length)} channels. Pick a channel to read paged, indexable chat history with date jumps.</p>
      <p class="muted">Generated ${escapeHtml(formatDateTime(options.generatedAt))}</p>
    </header>
    <main class="container">
      <section class="toolbar" aria-label="Archive navigation">
        <a href="#channels">Channels</a>
      </section>
      <section id="channels">
        <h2>Channels</h2>
        ${grouped.map(([categoryName, categoryChannels]) => `
          <section class="category">
            <h3>${escapeHtml(categoryName)}</h3>
            <ol class="channel-list">
              ${categoryChannels.map((channel) => renderChannelListItem(channel, "")).join("")}
            </ol>
          </section>
        `).join("")}
      </section>
    </main>
  `;

  return renderHtmlPage({
    title: "OpenMower Discord Chat Archive",
    description: "Static, human-readable OpenMower Discord chat archive with channel navigation, pagination, and date indexes.",
    cssHref: "styles.css",
    body,
  });
}

function renderChannelIndex(channel, options) {
  const firstPage = channel.pages[0];
  const latestPage = channel.pages.at(-1);
  const body = `
    ${renderBreadcrumbs([
      ["../../index.html", "All channels"],
      [null, channelLabel(channel)],
    ])}
    <header class="site-header compact">
      <p class="eyebrow">${escapeHtml(channel.categoryName || "Channel")}</p>
      <h1>${escapeHtml(channelLabel(channel))}</h1>
      <p>${formatCount(channel.messages.length)} messages from ${escapeHtml(formatDate(channel.firstTimestamp))} to ${escapeHtml(formatDate(channel.lastTimestamp))}.</p>
    </header>
    <main class="container">
      <section class="toolbar" aria-label="Channel navigation">
        ${firstPage ? `<a href="${escapeAttr(firstPage.file)}">First page</a>` : ""}
        ${latestPage ? `<a href="${escapeAttr(latestPage.file)}">Latest page</a>` : ""}
        <a href="dates.html">Date index</a>
      </section>
      <section>
        <h2>Pages</h2>
        <ol class="page-list">
          ${channel.pages.map((page) => `
            <li>
              <a href="${escapeAttr(page.file)}">Page ${page.pageNumber}</a>
              <span>${escapeHtml(formatDateRange(page.firstTimestamp, page.lastTimestamp))}</span>
              <span>${formatCount(page.count)} messages</span>
            </li>
          `).join("")}
        </ol>
      </section>
      <section>
        <h2>Jump To Month</h2>
        ${renderMonthList(channel.months)}
      </section>
    </main>
  `;

  return renderHtmlPage({
    title: `${channelLabel(channel)} - OpenMower Discord Archive`,
    description: `${channelLabel(channel)} Discord chat archive index with pages and date links.`,
    cssHref: "../../styles.css",
    body,
  });
}

function renderDateIndex(channel) {
  const daysByMonth = new Map();
  for (const day of channel.days) {
    const month = day.date.slice(0, 7);
    if (!daysByMonth.has(month)) daysByMonth.set(month, []);
    daysByMonth.get(month).push(day);
  }

  const body = `
    ${renderBreadcrumbs([
      ["../../index.html", "All channels"],
      ["index.html", channelLabel(channel)],
      [null, "Dates"],
    ])}
    <header class="site-header compact">
      <p class="eyebrow">Date Index</p>
      <h1>${escapeHtml(channelLabel(channel))}</h1>
      <p>Jump to any day that has messages in this channel.</p>
    </header>
    <main class="container">
      <section class="toolbar" aria-label="Channel navigation">
        <a href="index.html">Channel index</a>
        ${channel.pages.at(-1) ? `<a href="${escapeAttr(channel.pages.at(-1).file)}">Latest page</a>` : ""}
      </section>
      ${[...daysByMonth.entries()].map(([month, days]) => `
        <section class="date-month">
          <h2 id="month-${escapeAttr(month)}">${escapeHtml(formatMonth(month))}</h2>
          <ol class="date-list">
            ${days.map((day) => `
              <li>
                <a href="${escapeAttr(day.file)}#date-${escapeAttr(day.date)}"><time datetime="${escapeAttr(day.date)}">${escapeHtml(day.date)}</time></a>
                <span>${formatCount(day.count)} messages</span>
              </li>
            `).join("")}
          </ol>
        </section>
      `).join("")}
    </main>
  `;

  return renderHtmlPage({
    title: `${channelLabel(channel)} Date Index - OpenMower Discord Archive`,
    description: `Date index for the ${channelLabel(channel)} Discord chat archive.`,
    cssHref: "../../styles.css",
    body,
  });
}

function renderChannelPage(channel, page, messages) {
  const previousPage = channel.pages.find((candidate) => candidate.pageNumber === page.pageNumber - 1);
  const nextPage = channel.pages.find((candidate) => candidate.pageNumber === page.pageNumber + 1);
  let currentDay = null;

  const body = `
    ${renderBreadcrumbs([
      ["../../index.html", "All channels"],
      ["index.html", channelLabel(channel)],
      [null, `Page ${page.pageNumber}`],
    ])}
    <header class="site-header compact">
      <p class="eyebrow">${escapeHtml(channel.categoryName || "Channel")}</p>
      <h1>${escapeHtml(channelLabel(channel))}</h1>
      <p>Page ${page.pageNumber} of ${channel.pageCount}. ${escapeHtml(formatDateRange(page.firstTimestamp, page.lastTimestamp))}.</p>
    </header>
    <main class="container">
      ${renderPager(channel, page, previousPage, nextPage)}
      <section class="messages" aria-label="Messages">
        ${messages.map((message) => {
          const messageDay = dateKey(message.timestamp);
          const dayHeading = messageDay && messageDay !== currentDay
            ? `<h2 class="day-heading" id="date-${escapeAttr(messageDay)}">${escapeHtml(formatDate(message.timestamp))}</h2>`
            : "";
          currentDay = messageDay || currentDay;
          return `${dayHeading}${renderMessage(message)}`;
        }).join("")}
      </section>
      ${renderPager(channel, page, previousPage, nextPage)}
    </main>
  `;

  return renderHtmlPage({
    title: `${channelLabel(channel)} Page ${page.pageNumber} - OpenMower Discord Archive`,
    description: `${channelLabel(channel)} Discord messages from ${formatDateRange(page.firstTimestamp, page.lastTimestamp)}.`,
    cssHref: "../../styles.css",
    body,
  });
}

function renderChannelListItem(channel, prefix) {
  const latestPage = channel.pages.at(-1);
  return `
    <li class="channel-card">
      <div>
        <a class="channel-title" href="${escapeAttr(prefix)}channels/${escapeAttr(channel.slug)}/">${escapeHtml(channelLabel(channel))}</a>
        <p>${formatCount(channel.messages.length)} messages, ${escapeHtml(formatDateRange(channel.firstTimestamp, channel.lastTimestamp))}</p>
      </div>
      <div class="channel-actions">
        <a href="${escapeAttr(prefix)}channels/${escapeAttr(channel.slug)}/dates.html">Dates</a>
        ${latestPage ? `<a href="${escapeAttr(prefix)}channels/${escapeAttr(channel.slug)}/${escapeAttr(latestPage.file)}">Latest</a>` : ""}
      </div>
    </li>
  `;
}

function renderMonthList(months) {
  if (months.length === 0) {
    return `<p class="muted">No dated messages.</p>`;
  }

  return `
    <ol class="month-list">
      ${months.map((month) => `
        <li>
          <a href="dates.html#month-${escapeAttr(month.month)}">${escapeHtml(formatMonth(month.month))}</a>
          <span>${formatCount(month.count)} messages</span>
        </li>
      `).join("")}
    </ol>
  `;
}

function renderPager(channel, page, previousPage, nextPage) {
  return `
    <nav class="pager" aria-label="Page navigation">
      ${previousPage ? `<a rel="prev" href="${escapeAttr(previousPage.file)}">Previous</a>` : `<span aria-disabled="true">Previous</span>`}
      <a href="index.html">Channel index</a>
      <a href="dates.html">Date index</a>
      <span>Page ${page.pageNumber} of ${channel.pageCount}</span>
      ${nextPage ? `<a rel="next" href="${escapeAttr(nextPage.file)}">Next</a>` : `<span aria-disabled="true">Next</span>`}
    </nav>
  `;
}

function renderBreadcrumbs(items) {
  return `
    <nav class="breadcrumbs" aria-label="Breadcrumb">
      ${items.map(([href, label], index) => {
        const separator = index === 0 ? "" : `<span aria-hidden="true">/</span>`;
        const content = href
          ? `<a href="${escapeAttr(href)}">${escapeHtml(label)}</a>`
          : `<span>${escapeHtml(label)}</span>`;
        return `${separator}${content}`;
      }).join("")}
    </nav>
  `;
}

function renderMessage(message) {
  const anchorId = messageAnchorId(message);
  const author = message.authorNickname || message.authorName || message.authorId || "unknown";
  const content = message.content ? `<div class="message-content">${renderContent(message.content)}</div>` : "";
  const reply = message.replyToMessageUrl
    ? `<p class="reply"><a href="${escapeAttr(message.replyToMessageUrl)}">In reply to another message</a></p>`
    : "";
  const discordLink = message.messageUrl
    ? `<a class="message-link" href="${escapeAttr(message.messageUrl)}">Discord</a>`
    : "";

  return `
    <article class="message" id="${escapeAttr(anchorId)}">
      <header class="message-header">
        <div>
          <span class="author">${escapeHtml(author)}</span>
          ${message.authorIsBot ? `<span class="bot-label">bot</span>` : ""}
          <a class="message-time" href="#${escapeAttr(anchorId)}"><time datetime="${escapeAttr(message.timestamp || "")}">${escapeHtml(formatDateTime(message.timestamp))}</time></a>
        </div>
        ${discordLink}
      </header>
      ${reply}
      ${content}
      ${renderAttachments(message.attachments)}
    </article>
  `;
}

function renderAttachments(attachments = []) {
  if (attachments.length === 0) {
    return "";
  }

  return `
    <ul class="attachments">
      ${attachments.map((attachment) => {
        const href = safeHttpUrl(attachment.url || "");
        const label = attachment.fileName || "attachment";
        const meta = [attachment.contentType, formatBytes(attachment.fileSizeBytes)].filter(Boolean).join(", ");
        const preview = href && isImageAttachment(attachment)
          ? `<a class="attachment-preview" href="${escapeAttr(href)}"><img src="${escapeAttr(href)}" loading="lazy" alt="${escapeAttr(label)}"></a>`
          : "";
        const link = href
          ? `<a href="${escapeAttr(href)}">${escapeHtml(label)}</a>`
          : `<span>${escapeHtml(label)}</span>`;
        return `
          <li>
            ${preview}
            <div>${link}${meta ? `<span>${escapeHtml(meta)}</span>` : ""}</div>
          </li>
        `;
      }).join("")}
    </ul>
  `;
}

function renderHtmlPage({ title, description, cssHref, body }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="${escapeAttr(description)}">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="${escapeAttr(cssHref)}">
  </head>
  <body>
${body}
  </body>
</html>
`;
}

function archiveCss() {
  return `:root {
  color-scheme: light;
  --bg: #f7f8fa;
  --panel: #ffffff;
  --text: #1d2430;
  --muted: #647084;
  --line: #d9dee7;
  --link: #0b5cad;
  --link-bg: #eaf3ff;
  --accent: #216e4e;
  --shadow: 0 1px 2px rgba(30, 41, 59, 0.08);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

a {
  color: var(--link);
  text-decoration-thickness: 0.08em;
  text-underline-offset: 0.16em;
}

.site-header,
.container,
.breadcrumbs {
  max-width: 1120px;
  margin: 0 auto;
  padding-left: 20px;
  padding-right: 20px;
}

.site-header {
  padding-top: 38px;
  padding-bottom: 26px;
}

.site-header.compact {
  padding-top: 18px;
  padding-bottom: 18px;
}

.site-header h1 {
  margin: 0;
  font-size: 4rem;
  line-height: 1;
  letter-spacing: 0;
}

.site-header.compact h1 {
  font-size: 2.8rem;
}

.site-header p {
  max-width: 760px;
  margin: 14px 0 0;
  color: var(--muted);
}

.eyebrow {
  margin: 0 0 10px;
  color: var(--accent);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0;
}

.muted {
  color: var(--muted);
}

.breadcrumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 16px;
  color: var(--muted);
  font-size: 0.95rem;
}

.toolbar,
.pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 0 0 22px;
  padding: 12px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: var(--shadow);
}

.toolbar a,
.pager a,
.pager span {
  display: inline-flex;
  align-items: center;
  min-height: 34px;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--link-bg);
}

.pager span {
  background: transparent;
  color: var(--muted);
}

.category,
.date-month {
  margin-bottom: 30px;
}

h2,
h3 {
  letter-spacing: 0;
}

.channel-list,
.page-list,
.month-list,
.date-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.channel-card,
.page-list li,
.month-list li,
.date-list li {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 10px;
  padding: 14px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: var(--shadow);
}

.channel-title {
  font-weight: 700;
}

.channel-card p,
.page-list span,
.month-list span,
.date-list span {
  margin: 4px 0 0;
  color: var(--muted);
}

.channel-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  white-space: nowrap;
}

.messages {
  margin-bottom: 22px;
}

.day-heading {
  margin: 30px 0 12px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 1rem;
}

.message {
  margin-bottom: 12px;
  padding: 14px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: var(--shadow);
}

.message-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--muted);
  font-size: 0.95rem;
}

.author {
  color: var(--text);
  font-weight: 700;
}

.bot-label {
  margin-left: 6px;
  padding: 1px 5px;
  border-radius: 4px;
  background: #e8f5ef;
  color: var(--accent);
  font-size: 0.78rem;
  font-weight: 700;
  text-transform: uppercase;
}

.message-time {
  margin-left: 8px;
  color: var(--muted);
}

.message-link {
  white-space: nowrap;
}

.reply {
  margin: 10px 0 0;
  color: var(--muted);
}

.message-content {
  margin-top: 10px;
  overflow-wrap: anywhere;
  white-space: normal;
}

.attachments {
  list-style: none;
  padding: 0;
  margin: 12px 0 0;
  display: grid;
  gap: 10px;
}

.attachments li {
  display: grid;
  gap: 8px;
}

.attachments span {
  display: block;
  color: var(--muted);
  font-size: 0.9rem;
}

.attachment-preview img {
  display: block;
  max-width: min(420px, 100%);
  max-height: 320px;
  border-radius: 6px;
  border: 1px solid var(--line);
  object-fit: contain;
}

@media (max-width: 700px) {
  .site-header,
  .container,
  .breadcrumbs {
    padding-left: 14px;
    padding-right: 14px;
  }

  .channel-card,
  .page-list li,
  .month-list li,
  .date-list li,
  .message-header {
    display: block;
  }

  .channel-actions {
    margin-top: 8px;
  }

  .message-link {
    display: inline-block;
    margin-top: 6px;
  }

  .site-header h1 {
    font-size: 2.3rem;
  }

  .site-header.compact h1 {
    font-size: 2rem;
  }
}
`;
}

function groupChannelsByCategory(channels) {
  const groups = new Map();
  for (const channel of channels) {
    const category = channel.categoryName || "Uncategorized";
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(channel);
  }

  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function compareChannels(left, right) {
  return String(left.categoryName || "").localeCompare(String(right.categoryName || ""))
    || String(left.name || "").localeCompare(String(right.name || ""))
    || String(left.id || "").localeCompare(String(right.id || ""));
}

function compareArchiveMessages(left, right) {
  const byTime = (Date.parse(left.timestamp || 0) || 0) - (Date.parse(right.timestamp || 0) || 0);
  if (byTime !== 0) return byTime;
  return String(left.id || left.ordinal).localeCompare(String(right.id || right.ordinal));
}

function channelLabel(channel) {
  const name = channel.name || channel.id || "unknown";
  return `#${name}`;
}

function pageFileName(pageNumber, width) {
  return `page-${String(pageNumber).padStart(width, "0")}.html`;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "channel";
}

function dateKey(timestamp) {
  return timestamp ? String(timestamp).slice(0, 10) : null;
}

function formatDate(timestamp) {
  return dateKey(timestamp) || "unknown date";
}

function formatDateTime(timestamp) {
  if (!timestamp) return "unknown time";
  const text = String(timestamp);
  const date = text.slice(0, 10);
  const time = text.slice(11, 16);
  return date && time ? `${date} ${time}` : text;
}

function formatDateRange(firstTimestamp, lastTimestamp) {
  const first = formatDate(firstTimestamp);
  const last = formatDate(lastTimestamp);
  return first === last ? first : `${first} to ${last}`;
}

function formatMonth(month) {
  return month || "unknown month";
}

function formatCount(count) {
  return Number(count || 0).toLocaleString("en-US");
}

function formatBytes(bytes) {
  const number = Number(bytes);
  if (!Number.isFinite(number) || number <= 0) return null;
  const units = ["B", "KB", "MB", "GB"];
  let value = number;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 || unit === "B" ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function renderContent(content) {
  const text = String(content || "");
  const urlPattern = /\bhttps?:\/\/[^\s<>"']+/gi;
  let rendered = "";
  let lastIndex = 0;

  for (const match of text.matchAll(urlPattern)) {
    const url = match[0];
    const index = match.index || 0;
    rendered += escapeHtml(text.slice(lastIndex, index));
    rendered += `<a href="${escapeAttr(url)}">${escapeHtml(url)}</a>`;
    lastIndex = index + url.length;
  }

  rendered += escapeHtml(text.slice(lastIndex));
  return rendered.replace(/\r\n|\r|\n/g, "<br>");
}

function messageAnchorId(message) {
  const id = message.id || message.ordinal || "message";
  return `m-${String(id).replace(/[^a-z0-9_-]+/gi, "-")}`;
}

function isImageAttachment(attachment) {
  return /^image\//i.test(attachment.contentType || "")
    || /\.(png|jpe?g|gif|webp)$/i.test(attachment.fileName || "");
}

function minIso(current, next) {
  if (!next) return current;
  if (!current) return next;
  return new Date(next) < new Date(current) ? next : current;
}

function maxIso(current, next) {
  if (!next) return current;
  if (!current) return next;
  return new Date(next) > new Date(current) ? next : current;
}

function safeHttpUrl(value) {
  const url = String(value || "").trim();
  return /^https?:\/\//i.test(url) ? url : "";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]));
}

const escapeAttr = escapeHtml;
