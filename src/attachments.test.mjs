import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  downloadSelectedAttachments,
  recoverMissingAttachments,
  writeAttachmentIndex,
} from "./attachments.mjs";

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dh-attach-"));
  const corpus = path.join(dir, "corpus");
  const mirror = path.join(dir, "mirror");
  await fs.mkdir(corpus, { recursive: true });
  await fs.mkdir(mirror, { recursive: true });

  const message = {
    id: "1",
    timestamp: "2024-03-01T00:00:00.000+00:00",
    attachments: [{
      id: "10",
      fileName: "a.png",
      fileSizeBytes: 1234,
      contentType: "image/png",
      url: "https://cdn.discordapp.com/attachments/7/10/a.png",
      localPath: "data/attachments/7/10-a.png",
    }],
  };
  await fs.writeFile(path.join(corpus, "messages-2024.jsonl"), `${JSON.stringify(message)}\n`);
  return { dir, corpus, mirror };
}

// Regression: --out was read before it was declared, so any run with --out
// threw "ReferenceError: outRoot is not defined" before touching the network.
test("download-attachments honours --out without throwing", async () => {
  const { corpus, mirror } = await fixture();
  const stats = await downloadSelectedAttachments({
    corpus,
    out: mirror,
    maxSize: 1049600,
    noRefresh: true,
    dryRun: true,
    env: path.join(mirror, "no-such.env"),
  });

  assert.equal(stats.considered, 1);
  assert.equal(stats.selected, 1);
  assert.equal(stats.downloaded, 0);
});

// With --out the mirror is the source of truth for what already exists, so a
// file present there must not be re-downloaded.
test("download-attachments skips files already in the mirror", async () => {
  const { corpus, mirror } = await fixture();
  await fs.mkdir(path.join(mirror, "7"), { recursive: true });
  await fs.writeFile(path.join(mirror, "7", "10-a.png"), "already here");

  const stats = await downloadSelectedAttachments({
    corpus,
    out: mirror,
    maxSize: 1049600,
    noRefresh: true,
    dryRun: true,
    env: path.join(mirror, "no-such.env"),
  });

  assert.equal(stats.skippedExisting, 1);
});

test("write-attachment-index lists held files and prunes recovered ones", async () => {
  const { mirror } = await fixture();
  await fs.mkdir(path.join(mirror, "7"), { recursive: true });
  await fs.writeFile(path.join(mirror, "7", "10-a.png"), "bytes");

  const missing = path.join(mirror, "MISSING.tsv");
  await fs.writeFile(missing, [
    "# comment kept",
    "abc\t10\t7/10-a.png",      // now present, should be pruned
    "def\t20\t7/11-b.png",      // still missing, should stay
  ].join("\n") + "\n");

  const result = await writeAttachmentIndex(mirror, { missing });
  assert.equal(result.count, 1);
  assert.equal(result.pruned, 1);

  const index = await fs.readFile(path.join(mirror, "INDEX.txt"), "utf8");
  assert.equal(index.trim(), "7/10-a.png");

  const rest = await fs.readFile(missing, "utf8");
  assert.ok(rest.includes("# comment kept"), "comments survive pruning");
  assert.ok(rest.includes("7/11-b.png"), "still-missing entries survive");
  assert.ok(!rest.includes("7/10-a.png"), "recovered entry is pruned");
});

test("recover-attachments matches manifest entries against the corpus", async () => {
  const { corpus, mirror } = await fixture();
  const missing = path.join(mirror, "MISSING.tsv");
  await fs.writeFile(missing, "#oid\tsize\tpath\nabc\t1234\t7/10-a.png\n");

  const stats = await recoverMissingAttachments({
    corpus,
    manifest: missing,
    out: mirror,
    dryRun: true,
    env: path.join(mirror, "no-such.env"),
  });

  assert.equal(stats.wanted, 1);
  assert.equal(stats.matched, 1);
  assert.equal(stats.recovered, 0);
});
