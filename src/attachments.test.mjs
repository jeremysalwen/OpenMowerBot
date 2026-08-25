import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  describeUnusable,
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

test("describeUnusable accepts real files and rejects junk", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
  const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(64)]);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(64)]);

  // A re-encoded image is still a valid image, so it must pass.
  assert.equal(describeUnusable(png, "7/1-a.png"), null);
  assert.equal(describeUnusable(jpg, "7/1-a.jpg"), null);
  assert.equal(describeUnusable(gif, "7/1-a.gif"), null);
  assert.equal(describeUnusable(webp, "7/1-a.webp"), null);

  // Attachments with no signature worth checking are accepted on content alone.
  assert.equal(describeUnusable(Buffer.from("key: value\n"), "7/1-a.yaml"), null);

  // The cases this gate exists for.
  assert.match(describeUnusable(Buffer.alloc(0), "7/1-a.png"), /empty/);
  assert.match(describeUnusable(Buffer.from("<!DOCTYPE html><html>nope"), "7/1-a.png"), /HTML/);
  assert.match(describeUnusable(Buffer.from("not an image at all"), "7/1-a.png"), /not a recognizable/);
  assert.match(describeUnusable(Buffer.from("RIFFxxxxAVI "), "7/1-a.webp"), /not a recognizable/);

  // The archive really contains a PNG named .jpg, so a mislabelled but valid
  // file must be kept rather than discarded over its extension.
  assert.equal(describeUnusable(png, "7/1-a.jpg"), null);

  // An actual HTML attachment must not be rejected for looking like HTML.
  assert.equal(describeUnusable(Buffer.from("<!DOCTYPE html><html>real"), "7/1-a.html"), null);
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
