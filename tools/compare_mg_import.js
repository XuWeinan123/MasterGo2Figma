#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");

const root = path.resolve(__dirname, "..");
function newestMatchingFile(pattern) {
  return fs.readdirSync(root)
    .filter(name => pattern.test(name))
    .map(name => ({ name, mtimeMs: fs.statSync(path.join(root, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.name;
}

const mgPath = path.resolve(root, process.argv[2] || newestMatchingFile(/\.mg$/i) || "插件测试.mg");
const baselineZipPath = path.resolve(root, process.argv[3] || newestMatchingFile(/^mastergo2figma-.*\.zip$/i) || "mastergo2figma-partial-pages-2026-06-05T08-52-29-134Z.zip");
const mgPackagePath = path.join(root, "ReceiveFromMasterGo", "src", "ui", "mgPackage.js");
const textDecoder = new TextDecoder("utf-8");

function decodeUtf8(bytes) {
  return textDecoder.decode(bytes);
}

function readZipEntries(filePath) {
  const buf = fs.readFileSync(filePath);
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocdOffset = -1;

  for (let offset = view.byteLength - 22; offset >= 0; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error(`Invalid zip: ${filePath}`);

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const entries = {};
  let offset = centralOffset;

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Bad central directory");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decodeUtf8(bytes.slice(offset + 46, offset + 46 + nameLength));

    if (!name.endsWith("/")) {
      if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("Bad local header");
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

async function convertMgWithUiDecoder() {
  const mgPackageSource = fs.readFileSync(mgPackagePath, "utf8");
  const sandbox = {
    console,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    DataView,
    Date,
    RegExp,
    JSON,
    Math,
    Number,
    String,
    Boolean,
    Object,
    Array,
    Error,
    Promise,
    setTimeout,
    clearTimeout,
    window: {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(mgPackageSource, sandbox, { filename: mgPackagePath });

  const entries = sandbox.window.MasterGoMg.convertMgPackageToV2Entries(readZipEntries(mgPath), path.basename(mgPath));
  return loadPackageRecords(entries);
}

function loadPackageRecords(entries) {
  const manifest = JSON.parse(decodeUtf8(entries["manifest.json"]));
  const recordsById = new Map();
  for (const page of manifest.pages) {
    const pageIndex = JSON.parse(decodeUtf8(entries[page.pageFile]));
    for (const chunkPath of pageIndex.layerChunks) {
      const chunk = JSON.parse(decodeUtf8(entries[chunkPath]));
      for (const record of chunk.records) {
        if (!recordsById.has(record.id)) {
          recordsById.set(record.id, { ...record, pageId: page.id, pageName: page.name });
        }
      }
    }
  }
  return { manifest, records: Array.from(recordsById.values()) };
}

function summarizePaints(records, key) {
  const counts = {};
  for (const record of records) {
    const paints = record.props && record.props.geometry && record.props.geometry[key];
    const first = Array.isArray(paints) && paints[0] ? paints[0].type : "NONE";
    counts[first] = (counts[first] || 0) + 1;
  }
  return counts;
}

function normalizeComparableEffects(effects) {
  if (!Array.isArray(effects)) return [];
  return effects.map(effect => {
    if (!effect || typeof effect !== "object") return effect;
    const copy = { ...effect };
    if (copy.visible === undefined && copy.isVisible !== undefined) copy.visible = copy.isVisible;
    if (copy.visible === undefined) copy.visible = true;
    if (copy.blendMode === "PASS_THROUGH") copy.blendMode = "NORMAL";
    if ((copy.type === "DROP_SHADOW" || copy.type === "INNER_SHADOW") && copy.showShadowBehindNode === undefined) {
      copy.showShadowBehindNode = true;
    }
    delete copy.isVisible;
    return copy;
  });
}

function normalizeComparablePaints(paints) {
  if (!Array.isArray(paints)) return [];
  return paints.map(paint => {
    if (!paint || typeof paint !== "object") return paint;
    const copy = JSON.parse(JSON.stringify(paint));
    if (copy.blendMode === "NORMAL") copy.blendMode = "PASS_THROUGH";
    normalizeTinyNumbers(copy);
    return copy;
  });
}

function normalizeTinyNumbers(value) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] === "number") {
        if (Math.abs(value[i]) < 1e-8) value[i] = 0;
      } else {
        normalizeTinyNumbers(value[i]);
      }
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (typeof value[key] === "number") {
      if (Math.abs(value[key]) < 1e-8) value[key] = 0;
    } else {
      normalizeTinyNumbers(value[key]);
    }
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function compareRecords(actual, expected) {
  const actualById = new Map(actual.records.map(record => [record.id, record]));
  const expectedById = new Map(expected.records.map(record => [record.id, record]));
  const missing = expected.records.filter(record => !actualById.has(record.id));
  const extra = actual.records.filter(record => !expectedById.has(record.id));
  const typeMismatches = [];
  const parentMismatches = [];
  const indexMismatches = [];
  const childOrderMismatches = [];
  const geometryMismatches = [];
  const transformMismatches = [];
  const effectMismatches = [];
  const textMismatches = [];
  const fontMismatches = [];
  const vectorNetworkMismatches = [];
  const paintMismatches = [];

  for (const expectedRecord of expected.records) {
    const actualRecord = actualById.get(expectedRecord.id);
    if (!actualRecord) continue;
    const expectedProps = expectedRecord.props || {};
    const actualProps = actualRecord.props || {};
    if (actualProps.type !== expectedProps.type) {
      typeMismatches.push([expectedRecord.id, actualProps.type, expectedProps.type, expectedRecord.name]);
    }
    if ((actualRecord.parentId || null) !== (expectedRecord.parentId || null)) {
      parentMismatches.push([expectedRecord.id, actualRecord.parentId || null, expectedRecord.parentId || null, expectedRecord.name]);
    }
    if ((actualRecord.index || 0) !== (expectedRecord.index || 0)) {
      indexMismatches.push([expectedRecord.id, actualRecord.index || 0, expectedRecord.index || 0, expectedRecord.name]);
    }
    const actualChildIds = (actualRecord.childIds || []).join(",");
    const expectedChildIds = (expectedRecord.childIds || []).join(",");
    if (actualChildIds !== expectedChildIds) {
      childOrderMismatches.push([expectedRecord.id, actualRecord.childIds || [], expectedRecord.childIds || [], expectedRecord.name]);
    }
    const aLayout = actualProps.layout || {};
    const eLayout = expectedProps.layout || {};
    for (const key of ["x", "y", "width", "height"]) {
      if (Math.abs((aLayout[key] || 0) - (eLayout[key] || 0)) > 0.01) {
        geometryMismatches.push([expectedRecord.id, key, aLayout[key], eLayout[key], expectedRecord.name]);
        break;
      }
    }
    if (Math.abs((aLayout.rotation || 0) - (eLayout.rotation || 0)) > 0.01) {
      transformMismatches.push([expectedRecord.id, "rotation", aLayout.rotation || 0, eLayout.rotation || 0, expectedRecord.name]);
    } else {
      const actualTransform = aLayout.relativeTransform || [];
      const expectedTransform = eLayout.relativeTransform || [];
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 3; col++) {
          const av = actualTransform[row] ? actualTransform[row][col] : undefined;
          const ev = expectedTransform[row] ? expectedTransform[row][col] : undefined;
          if (Math.abs((av || 0) - (ev || 0)) > 0.01) {
            transformMismatches.push([expectedRecord.id, `relativeTransform[${row}][${col}]`, av, ev, expectedRecord.name]);
            row = 2;
            break;
          }
        }
      }
    }
    const actualEffects = normalizeComparableEffects(actualProps.blend && actualProps.blend.effects);
    const expectedEffects = normalizeComparableEffects(expectedProps.blend && expectedProps.blend.effects);
    if (JSON.stringify(actualEffects) !== JSON.stringify(expectedEffects)) {
      effectMismatches.push([expectedRecord.id, actualEffects, expectedEffects, expectedRecord.name]);
    }
    const actualGeometry = actualProps.geometry || {};
    const expectedGeometry = expectedProps.geometry || {};
    for (const paintKey of ["fills", "strokes"]) {
      const actualPaints = normalizeComparablePaints(actualGeometry[paintKey]);
      const expectedPaints = normalizeComparablePaints(expectedGeometry[paintKey]);
      if (stableJson(actualPaints) !== stableJson(expectedPaints)) {
        paintMismatches.push([expectedRecord.id, paintKey, actualPaints, expectedPaints, expectedRecord.name]);
        break;
      }
    }
    if (expectedProps.type === "TEXT" || actualProps.type === "TEXT") {
      if ((actualProps.characters || "") !== (expectedProps.characters || "")) {
        textMismatches.push([expectedRecord.id, actualProps.characters, expectedProps.characters, expectedRecord.name]);
      }
      const actualFont = actualProps.fontName ? `${actualProps.fontName.family}/${actualProps.fontName.style}` : "";
      const expectedFont = expectedProps.fontName ? `${expectedProps.fontName.family}/${expectedProps.fontName.style}` : "";
      if (actualFont !== expectedFont || Math.abs((actualProps.fontSize || 0) - (expectedProps.fontSize || 0)) > 0.01) {
        fontMismatches.push([expectedRecord.id, `${actualFont} ${actualProps.fontSize || 0}`, `${expectedFont} ${expectedProps.fontSize || 0}`, expectedRecord.name]);
      }
    }
    const actualHasVectorNetwork = !!actualProps.vectorNetwork;
    const expectedHasVectorNetwork = !!expectedProps.vectorNetwork;
    if (actualHasVectorNetwork !== expectedHasVectorNetwork) {
      vectorNetworkMismatches.push([expectedRecord.id, actualHasVectorNetwork, expectedHasVectorNetwork, expectedRecord.name]);
    }
  }

  return {
    missing,
    extra,
    typeMismatches,
    parentMismatches,
    indexMismatches,
    childOrderMismatches,
    geometryMismatches,
    transformMismatches,
    effectMismatches,
    textMismatches,
    fontMismatches,
    vectorNetworkMismatches,
    paintMismatches
  };
}

(async function main() {
  const actual = await convertMgWithUiDecoder();
  const expected = loadPackageRecords(readZipEntries(baselineZipPath));
  const diff = compareRecords(actual, expected);

  console.log("Actual pages:", actual.manifest.pages.map(page => `${page.name}=${page.layerCount}`).join(", "));
  console.log("Expected pages:", expected.manifest.pages.map(page => `${page.name}=${page.layerCount}`).join(", "));
  console.log("Actual records:", actual.records.length);
  console.log("Expected records:", expected.records.length);
  console.log("Missing records:", diff.missing.length);
  console.log("Extra records:", diff.extra.length);
  console.log("Type mismatches:", diff.typeMismatches.length);
  console.log("Parent mismatches:", diff.parentMismatches.length);
  console.log("Index mismatches:", diff.indexMismatches.length);
  console.log("Child order mismatches:", diff.childOrderMismatches.length);
  console.log("Geometry mismatches:", diff.geometryMismatches.length);
  console.log("Transform mismatches:", diff.transformMismatches.length);
  console.log("Effect mismatches:", diff.effectMismatches.length);
  console.log("Text mismatches:", diff.textMismatches.length);
  console.log("Font mismatches:", diff.fontMismatches.length);
  console.log("Paint mismatches:", diff.paintMismatches.length);
  console.log("Vector network presence mismatches:", diff.vectorNetworkMismatches.length);
  console.log("Actual fill types:", summarizePaints(actual.records, "fills"));
  console.log("Actual stroke types:", summarizePaints(actual.records, "strokes"));
  console.log("Geometry mismatch sample:", diff.geometryMismatches.slice(0, 10));
  console.log("Transform mismatch sample:", diff.transformMismatches.slice(0, 10));
  console.log("Effect mismatch sample:", diff.effectMismatches.slice(0, 10));
  console.log("Index mismatch sample:", diff.indexMismatches.slice(0, 10));
  console.log("Child order mismatch sample:", diff.childOrderMismatches.slice(0, 10));
  console.log("Text mismatch sample:", diff.textMismatches.slice(0, 10));
  console.log("Font mismatch sample:", diff.fontMismatches.slice(0, 10));
  console.log("Paint mismatch sample:", diff.paintMismatches.slice(0, 10));
  console.log("Vector network mismatch sample:", diff.vectorNetworkMismatches.slice(0, 10));

  if (diff.missing.length || diff.extra.length || diff.typeMismatches.length || diff.parentMismatches.length || diff.indexMismatches.length || diff.childOrderMismatches.length || diff.transformMismatches.length || diff.effectMismatches.length || diff.paintMismatches.length) {
    console.log("Missing sample:", diff.missing.slice(0, 10).map(record => [record.id, record.name]));
    console.log("Extra sample:", diff.extra.slice(0, 10).map(record => [record.id, record.name]));
    console.log("Type mismatch sample:", diff.typeMismatches.slice(0, 10));
    console.log("Parent mismatch sample:", diff.parentMismatches.slice(0, 10));
    process.exitCode = 1;
  }
})();
