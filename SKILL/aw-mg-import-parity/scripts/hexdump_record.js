#!/usr/bin/env node
// Hexdump raw .mg document bytes around every RECORD-shaped occurrence of an id
// (`\x01<id>\x00` followed by a 02 parent / 03 sort-code / 05 style-kind tag),
// falling back to plain substring occurrences when no record anchor matches.
//
// Usage: node hexdump_record.js <repoRoot> <file.mg> <recordId> [bytes=200]
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const [repoRoot, mgArg, recordId, lenArg] = process.argv.slice(2);
if (!repoRoot || !mgArg || !recordId) {
  console.error("Usage: node hexdump_record.js <repoRoot> <file.mg> <recordId> [bytes=200]");
  process.exit(2);
}
const span = Math.max(32, parseInt(lenArg || "200", 10) || 200);
const mgPath = path.resolve(repoRoot, mgArg);

function readZipEntries(filePath) {
  const buf = fs.readFileSync(filePath);
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocdOffset = -1;
  for (let offset = view.byteLength - 22; offset >= 0; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocdOffset = offset; break; }
  }
  if (eocdOffset < 0) throw new Error(`Invalid zip: ${filePath}`);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const entries = {};
  let offset = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder("utf-8").decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    if (!name.endsWith("/")) {
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = Buffer.from(bytes.slice(dataStart, dataStart + compressedSize));
      entries[name] = method === 0 ? compressed : zlib.inflateRawSync(compressed);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const docBytes = readZipEntries(mgPath)["document"];
if (!docBytes) { console.error("no `document` entry in", mgPath); process.exit(1); }
const latin = new TextDecoder("latin1").decode(docBytes);

function dump(label, idx) {
  const seg = docBytes.slice(Math.max(0, idx - 8), idx + span);
  console.log(`--- ${label} at ${idx}`);
  console.log(Buffer.from(seg).toString("hex").replace(/(..)/g, "$1 "));
  console.log(JSON.stringify(latin.slice(idx, idx + span)).slice(0, 2 * span));
}

const pat = "\x01" + recordId + "\x00";
let idx = -1, anchored = 0;
while ((idx = latin.indexOf(pat, idx + 1)) >= 0) {
  const next = latin.charCodeAt(idx + pat.length);
  if (next === 0x02 || next === 0x03 || next === 0x05) { dump("record", idx); anchored++; }
}
if (anchored === 0) {
  console.log("(no record anchor; plain occurrences)");
  idx = -1;
  let shown = 0;
  while ((idx = latin.indexOf(recordId, idx + 1)) >= 0 && shown < 8) { dump("occurrence", idx); shown++; }
  if (shown === 0) console.log("id not found:", recordId);
}
