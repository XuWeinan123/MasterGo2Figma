#!/usr/bin/env node
// Dump decoded records from a .mg (via the repo's live mgPackage.js) and a
// baseline zip into JSON files for record-by-record diffing.
//
// Usage: node .agents/skills/mg-import-fix/scripts/dump_records.js <file.mg> <baseline.zip> <outDir>
//   actual_records.json   = native .mg decode (what the plugin would import)
//   expected_records.json = SendToFigma baseline zip
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const [mgArg, zipArg, outArg] = process.argv.slice(2);
if (!mgArg || !zipArg || !outArg) {
  console.error("Usage: node dump_records.js <file.mg> <baseline.zip> <outDir>");
  process.exit(2);
}
const mgPath = path.resolve(REPO_ROOT, mgArg);
const zipPath = path.resolve(REPO_ROOT, zipArg);
const outDir = path.resolve(outArg);

const textDecoder = new TextDecoder("utf-8");
function decodeUtf8(bytes) { return textDecoder.decode(bytes); }

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
    const name = decodeUtf8(bytes.slice(offset + 46, offset + 46 + nameLength));
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

function loadPackageRecords(entries) {
  const manifest = JSON.parse(decodeUtf8(entries["manifest.json"]));
  const recordsById = {};
  for (const page of manifest.pages) {
    const pageIndex = JSON.parse(decodeUtf8(entries[page.pageFile]));
    for (const chunkPath of pageIndex.layerChunks) {
      const chunk = JSON.parse(decodeUtf8(entries[chunkPath]));
      for (const record of chunk.records) {
        if (!recordsById[record.id]) recordsById[record.id] = { ...record, pageId: page.id, pageName: page.name };
      }
    }
  }
  return recordsById;
}

const mgPackagePath = path.join(REPO_ROOT, "ReceiveFromMasterGo", "src", "ui", "mgPackage.js");
const mgPackageSource = fs.readFileSync(mgPackagePath, "utf8");
const sandbox = {
  console, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, DataView, Date, RegExp,
  JSON, Math, Number, String, Boolean, Object, Array, Error, Promise, setTimeout, clearTimeout,
  window: {}
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(mgPackageSource, sandbox, { filename: mgPackagePath });

const mgEntries = sandbox.window.MasterGoMg.convertMgPackageToV2Entries(readZipEntries(mgPath), path.basename(mgPath));
const actual = loadPackageRecords(mgEntries);
const expected = loadPackageRecords(readZipEntries(zipPath));

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "actual_records.json"), JSON.stringify(actual, null, 1));
fs.writeFileSync(path.join(outDir, "expected_records.json"), JSON.stringify(expected, null, 1));
console.log("actual:", Object.keys(actual).length, "expected:", Object.keys(expected).length, "->", outDir);
