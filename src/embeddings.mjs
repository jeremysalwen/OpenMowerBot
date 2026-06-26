import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { readJsonl } from "./jsonl.mjs";

const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_MAX_CHARS = 1800;

export async function buildEmbeddings(corpusDir, indexDir, options = {}) {
  let pipeline;
  try {
    ({ pipeline } = await import("@huggingface/transformers"));
  } catch (error) {
    throw new Error(
      "build-embeddings requires @huggingface/transformers. Install it with: npm install --save-optional @huggingface/transformers",
      { cause: error },
    );
  }

  const model = String(options.model || DEFAULT_EMBEDDING_MODEL);
  const batchSize = Number(options.batchSize || DEFAULT_BATCH_SIZE);
  const maxChars = Number(options.maxChars || DEFAULT_MAX_CHARS);
  const limit = options.limit ? Number(options.limit) : Infinity;
  const messagesPath = path.join(corpusDir, "messages.jsonl");
  const embeddingsPath = path.join(indexDir, "embeddings.jsonl");
  const manifestPath = path.join(indexDir, "embeddings-manifest.json");

  await fsp.mkdir(indexDir, { recursive: true });
  const extractor = await pipeline("feature-extraction", model, {
    device: options.device || "cpu",
    dtype: options.dtype || "auto",
  });

  const output = fs.createWriteStream(embeddingsPath, { encoding: "utf8" });
  let count = 0;
  let dims = null;
  let batch = [];

  try {
    for await (const message of readJsonl(messagesPath)) {
      if (count + batch.length >= limit) {
        break;
      }

      const text = embeddingText(message, maxChars);
      if (!text) {
        continue;
      }

      batch.push({
        id: message.id,
        timestamp: message.timestamp,
        channelId: message.channelId,
        channelName: message.channelName,
        text,
      });

      if (batch.length >= batchSize) {
        const result = await embedBatch(extractor, batch.slice(0, limit - count), model);
        dims = dims || result.dims;
        for (const record of result.records) {
          output.write(`${JSON.stringify(record)}\n`);
          count += 1;
        }
        batch = [];
      }

      if (count >= limit) {
        break;
      }
    }

    if (batch.length > 0 && count < limit) {
      const result = await embedBatch(extractor, batch.slice(0, limit - count), model);
      dims = dims || result.dims;
      for (const record of result.records) {
        output.write(`${JSON.stringify(record)}\n`);
        count += 1;
      }
    }
  } finally {
    await new Promise((resolve, reject) => {
      output.on("error", reject);
      output.end(resolve);
    });
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    model,
    dims,
    recordCount: count,
    files: {
      embeddings: "embeddings.jsonl",
    },
  };
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    manifest,
    embeddingsPath,
    manifestPath,
  };
}

export async function searchEmbeddings(indexDir, queryVector, options = {}) {
  const embeddingsPath = path.join(indexDir, "embeddings.jsonl");
  if (!fs.existsSync(embeddingsPath)) {
    throw new Error(`No embeddings index found at ${embeddingsPath}`);
  }

  const limit = Number(options.limit || 20);
  const results = [];

  for await (const record of readJsonl(embeddingsPath)) {
    if (!Array.isArray(record.vector)) {
      continue;
    }

    const score = cosineSimilarity(queryVector, record.vector);
    results.push({ score, id: record.id });
    results.sort((a, b) => b.score - a.score);

    if (results.length > limit * 4) {
      results.length = limit * 2;
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function cosineSimilarity(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

async function embedBatch(extractor, batch, model) {
  const tensor = await extractor(batch.map((record) => record.text), {
    pooling: "mean",
    normalize: true,
  });
  const vectors = tensorToVectors(tensor, batch.length);
  const dims = vectors[0]?.length || null;

  return {
    dims,
    records: batch.map((record, index) => ({
      id: record.id,
      model,
      dims,
      timestamp: record.timestamp,
      channelId: record.channelId,
      channelName: record.channelName,
      vector: vectors[index],
    })),
  };
}

function tensorToVectors(tensor, batchSize) {
  const dims = tensor.dims || tensor.shape || [];
  const data = Array.from(tensor.data || []);

  if (dims.length === 2) {
    const width = dims[1];
    return splitVectorData(data, width, batchSize);
  }

  if (dims.length === 1 && batchSize === 1) {
    return [data];
  }

  if (typeof tensor.tolist === "function") {
    const listed = tensor.tolist();
    return Array.isArray(listed[0]) ? listed : [listed];
  }

  throw new Error(`Unsupported embedding tensor shape: ${JSON.stringify(dims)}`);
}

function splitVectorData(data, width, batchSize) {
  const vectors = [];
  for (let index = 0; index < Math.min(batchSize, data.length / width); index += 1) {
    vectors.push(data.slice(index * width, (index + 1) * width));
  }
  return vectors;
}

function embeddingText(message, maxChars) {
  const parts = [
    message.channelName ? `Channel: ${message.channelName}` : null,
    message.authorNickname || message.authorName ? `Author: ${message.authorNickname || message.authorName}` : null,
    message.content || null,
    ...(message.attachments || []).map((attachment) => attachment.fileName ? `Attachment: ${attachment.fileName}` : null),
  ].filter(Boolean);

  return parts.join("\n").slice(0, maxChars).trim();
}
