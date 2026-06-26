import fs from "node:fs";
import readline from "node:readline";

export async function* readJsonl(path) {
  const input = fs.createReadStream(path, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      yield JSON.parse(trimmed);
    }
  }
}

export function writeJsonl(path, records) {
  const output = fs.createWriteStream(path, { encoding: "utf8" });

  return new Promise((resolve, reject) => {
    output.on("error", reject);
    output.on("finish", resolve);

    for (const record of records) {
      output.write(`${JSON.stringify(record)}\n`);
    }

    output.end();
  });
}
