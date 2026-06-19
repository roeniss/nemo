// Upload a markdown (or any text) file as a new memo via the Integration API
// (POST /api/ext/memos). The memo title is derived server-side from the first
// non-empty line of content, so we just send the file's text as `content`.
//
//   NEMO_TOKEN=nemo_xxxx node scripts/upload-memo.mjs note.md [more.md ...]
//
// Env:
//   NEMO_TOKEN    (required) a PAT from the api_tokens table — Bearer auth.
//   NEMO_BASE_URL (optional) defaults to https://nemo.roeni.ss
//
// ponytail: no retries, no concurrency, no progress bar. Files are uploaded one
// at a time; we attempt every file and exit non-zero if any failed.
import { readFile } from "node:fs/promises";

const USAGE = "usage: node scripts/upload-memo.mjs <file> [<file>...]";
const BASE_URL = process.env.NEMO_BASE_URL ?? "https://nemo.roeni.ss";

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write(USAGE + "\n");
  process.exit(1);
}

const token = process.env.NEMO_TOKEN;
if (!token) {
  process.stderr.write("error: NEMO_TOKEN env var is required\n");
  process.exit(1);
}

async function upload(file) {
  const content = await readFile(file, "utf8");
  const res = await fetch(`${BASE_URL}/api/ext/memos`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ content }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.status === 201, response: body.response ?? `HTTP ${res.status}` };
}

let failed = false;
for (const file of files) {
  try {
    const { ok, response } = await upload(file);
    if (!ok) failed = true;
    console.log(`${file}: ${response}`);
  } catch (err) {
    failed = true;
    console.log(`${file}: ${err.message}`);
  }
}

process.exit(failed ? 1 : 0);
