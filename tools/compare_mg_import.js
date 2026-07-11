#!/usr/bin/env node

const crypto = require("crypto");
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

const argv = process.argv.slice(2);
const jsonOutput = argv.includes("--json");
const includeRecords = argv.includes("--include-records");
const positional = argv.filter(arg => arg !== "--json" && arg !== "--include-records");
if (positional.length !== 2) {
  console.error("Usage: node tools/compare_mg_import.js <file.mg> <baseline.zip> [--json] [--include-records]");
  process.exit(2);
}
const mgPath = path.resolve(root, positional[0]);
const baselineZipPath = path.resolve(root, positional[1]);
const mgPackagePath = path.join(root, "ReceiveFromMasterGo", "src", "ui", "mgPackage.js");
const packageValidationPath = path.join(root, "ReceiveFromMasterGo", "src", "ui", "packageValidation.js");
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
  return { ...loadPackageRecords(entries), entries };
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
  return { manifest, records: Array.from(recordsById.values()), resolveImageRef: makeImageRefResolver(manifest, entries) };
}

// imageRef naming is exporter-specific (SendToFigma numbers assets `image-001`,
// the native decoder keeps MasterGo's content-hash filenames). Canonicalize an
// imageRef to the SHA-1 of the referenced asset bytes so paints compare by
// image CONTENT, not by name.
function makeImageRefResolver(manifest, entries) {
  const assets = (manifest && manifest.assets) || {};
  const cache = new Map();
  return function resolveImageRef(ref) {
    if (!ref || typeof ref !== "string") return ref;
    if (cache.has(ref)) return cache.get(ref);
    const asset = assets[ref] || assets[ref.replace(/\.[^.]+$/, "")] || assets[ref + ".png"];
    const bytes = asset && asset.path ? entries[asset.path] : null;
    const canonical = bytes ? "sha1:" + crypto.createHash("sha1").update(bytes).digest("hex") : ref;
    cache.set(ref, canonical);
    return canonical;
  };
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

// MasterGo's plugin API folds the radial/angular/diamond minor-axis ratio to
// min(ratio, 2·|major|/ratio) when it builds the transform SendToFigma reads,
// so ZIP baselines carry the folded ratio while the native .mg decoder emits
// the render-truth value. Canonicalize both sides to the folded form so the
// known exporter-side information loss doesn't read as a decoder regression.
function foldGradientTransform(transform) {
  if (!Array.isArray(transform) || !transform[0] || !transform[1]) return transform;
  const a00 = transform[0][0], a01 = transform[0][1], t0 = transform[0][2];
  const a10 = transform[1][0], a11 = transform[1][1], t1 = transform[1][2];
  const det = a00 * a11 - a01 * a10;
  if (!isFinite(det) || Math.abs(det) < 1e-12) return transform;
  // Node-space ellipse axes: A⁻¹·(0.5,0) = major radius, A⁻¹·(0,0.5) = minor.
  const majX = (a11 * 0.5) / det, majY = (-a10 * 0.5) / det;
  const minX = (-a01 * 0.5) / det, minY = (a00 * 0.5) / det;
  const major = Math.hypot(majX, majY);
  const minor = Math.hypot(minX, minY);
  if (!(major > 0) || !(minor > 0)) return transform;
  const ratio = minor / major;
  const folded = Math.min(ratio, 2 * major / ratio);
  if (Math.abs(folded - ratio) < 1e-6) return transform;
  // Rebuild with the folded minor length; center = A⁻¹·((0.5,0.5) − t).
  // majX/minX are already the RADIUS vectors (gradient-space offset 0.5).
  const scale = folded / ratio;
  const ux = majX, uy = majY;
  const vx = minX * scale, vy = minY * scale;
  const cgx = 0.5 - t0, cgy = 0.5 - t1;
  const p0 = { x: (a11 * cgx - a01 * cgy) / det, y: (-a10 * cgx + a00 * cgy) / det };
  const det2 = ux * vy - vx * uy;
  if (!isFinite(det2) || Math.abs(det2) < 1e-12) return transform;
  const inv = 0.5 / det2;
  const b00 = vy * inv, b01 = -vx * inv;
  const b10 = -uy * inv, b11 = ux * inv;
  return [
    [b00, b01, 0.5 - (b00 * p0.x + b01 * p0.y)],
    [b10, b11, 0.5 - (b10 * p0.x + b11 * p0.y)]
  ];
}

function normalizeComparablePaints(paints, resolveImageRef) {
  if (!Array.isArray(paints)) return [];
  return paints.map(paint => {
    if (!paint || typeof paint !== "object") return paint;
    const copy = JSON.parse(JSON.stringify(paint));
    if (copy.blendMode === "NORMAL") copy.blendMode = "PASS_THROUGH";
    if (copy.type === "IMAGE" && resolveImageRef) copy.imageRef = resolveImageRef(copy.imageRef);
    if ((copy.type === "GRADIENT_RADIAL" || copy.type === "GRADIENT_ANGULAR" || copy.type === "GRADIENT_DIAMOND") && copy.gradientTransform) {
      copy.gradientTransform = foldGradientTransform(copy.gradientTransform);
    }
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

function numbersClose(actual, expected) {
  return Math.abs(actual - expected) <= Math.max(0.015, Math.abs(expected) * 1e-4) ||
    (Math.abs(actual) < 1e-8 && Math.abs(expected) < 1e-8);
}

function anglesClose(actual, expected) {
  const delta = ((actual - expected + 180) % 360 + 360) % 360 - 180;
  return numbersClose(delta, 0);
}

// Recursive full-props diff with a small numeric tolerance. This is the
// strict parity net: any prop the field-specific checks below don't cover
// (strokeAlign/strokeCap/strokeJoin, textAutoResize, isMask, clipsContent,
// constraints, auto-layout fields, dashPattern, arcData, …) is caught here.
function deepDiffProps(pathStr, a, e, out, id, name) {
  if (a === undefined && e === undefined) return;
  const ta = a === null ? "null" : Array.isArray(a) ? "array" : typeof a;
  const te = e === null ? "null" : Array.isArray(e) ? "array" : typeof e;
  if (a === undefined || e === undefined || ta !== te) {
    out.push([id, pathStr, a, e, name]);
    return;
  }
  if (ta === "number") {
    const close = pathStr.endsWith(".rotation") ? anglesClose(a, e) : numbersClose(a, e);
    if (!close) out.push([id, pathStr, a, e, name]);
    return;
  }
  if (ta === "array") {
    if (a.length !== e.length) {
      out.push([id, pathStr + ".length", a.length, e.length, name]);
      return;
    }
    for (let i = 0; i < e.length; i++) deepDiffProps(pathStr + "[" + i + "]", a[i], e[i], out, id, name);
    return;
  }
  if (ta === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(e)]);
    for (const key of keys) deepDiffProps(pathStr + "." + key, a[key], e[key], out, id, name);
    return;
  }
  if (a !== e) out.push([id, pathStr, a, e, name]);
}

function comparableValuesEqual(actual, expected) {
  const diff = [];
  deepDiffProps("", actual, expected, diff, "", "");
  return diff.length === 0;
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
  const deepPropMismatches = [];

  // Apply the gradient-ratio fold to every paint list a record can carry so
  // the strict deep-diff sees the same canonical form the paint check uses.
  function cloneWithFoldedGradients(props) {
    const copy = JSON.parse(JSON.stringify(props));
    const foldList = paints => {
      if (!Array.isArray(paints)) return;
      for (const paint of paints) {
        if (paint && (paint.type === "GRADIENT_RADIAL" || paint.type === "GRADIENT_ANGULAR" || paint.type === "GRADIENT_DIAMOND") && paint.gradientTransform) {
          paint.gradientTransform = foldGradientTransform(paint.gradientTransform);
        }
      }
    };
    if (copy.geometry) { foldList(copy.geometry.fills); foldList(copy.geometry.strokes); }
    if (Array.isArray(copy.styledTextSegments)) for (const segment of copy.styledTextSegments) foldList(segment.fills);
    return copy;
  }

  for (const expectedRecord of expected.records) {
    const actualRecord = actualById.get(expectedRecord.id);
    if (!actualRecord) continue;
    const expectedProps = cloneWithFoldedGradients(expectedRecord.props || {});
    const actualProps = cloneWithFoldedGradients(actualRecord.props || {});
    deepDiffProps("", actualProps, expectedProps, deepPropMismatches, expectedRecord.id, expectedRecord.name);
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
      if (!numbersClose(aLayout[key] || 0, eLayout[key] || 0)) {
        geometryMismatches.push([expectedRecord.id, key, aLayout[key], eLayout[key], expectedRecord.name]);
        break;
      }
    }
    if (!anglesClose(aLayout.rotation || 0, eLayout.rotation || 0)) {
      transformMismatches.push([expectedRecord.id, "rotation", aLayout.rotation || 0, eLayout.rotation || 0, expectedRecord.name]);
    } else {
      const actualTransform = aLayout.relativeTransform || [];
      const expectedTransform = eLayout.relativeTransform || [];
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 3; col++) {
          const av = actualTransform[row] ? actualTransform[row][col] : undefined;
          const ev = expectedTransform[row] ? expectedTransform[row][col] : undefined;
          if (!numbersClose(av || 0, ev || 0)) {
            transformMismatches.push([expectedRecord.id, `relativeTransform[${row}][${col}]`, av, ev, expectedRecord.name]);
            row = 2;
            break;
          }
        }
      }
    }
    const actualEffects = normalizeComparableEffects(actualProps.blend && actualProps.blend.effects);
    const expectedEffects = normalizeComparableEffects(expectedProps.blend && expectedProps.blend.effects);
    if (!comparableValuesEqual(actualEffects, expectedEffects)) {
      effectMismatches.push([expectedRecord.id, actualEffects, expectedEffects, expectedRecord.name]);
    }
    const actualGeometry = actualProps.geometry || {};
    const expectedGeometry = expectedProps.geometry || {};
    for (const paintKey of ["fills", "strokes"]) {
      const actualPaints = normalizeComparablePaints(actualGeometry[paintKey], actual.resolveImageRef);
      const expectedPaints = normalizeComparablePaints(expectedGeometry[paintKey], expected.resolveImageRef);
      if (!comparableValuesEqual(actualPaints, expectedPaints)) {
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
      if (actualFont !== expectedFont || !numbersClose(actualProps.fontSize || 0, expectedProps.fontSize || 0)) {
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
    paintMismatches,
    deepPropMismatches
  };
}

(async function main() {
  const actual = await convertMgWithUiDecoder();
  const expectedEntries = readZipEntries(baselineZipPath);
  const expected = { ...loadPackageRecords(expectedEntries), entries: expectedEntries };
  const { validateV2Package } = require(packageValidationPath);
  const actualValidation = validateV2Package(actual.entries);
  const expectedValidation = validateV2Package(expected.entries);
  if (!actualValidation.ok || !expectedValidation.ok) {
    const result = { actualValidation, expectedValidation };
    if (jsonOutput) console.log(JSON.stringify(result, null, 2));
    else console.error("Package validation failed:", JSON.stringify(result, null, 2));
    process.exitCode = 1;
    return;
  }
  const diff = compareRecords(actual, expected);

  if (jsonOutput) {
    const actualById = new Map(actual.records.map(record => [record.id, record]));
    const expectedById = new Map(expected.records.map(record => [record.id, record]));
    console.log(JSON.stringify({
      actual: { pages: actual.manifest.pages, recordCount: actual.records.length, canonicalDigest: actualValidation.canonicalDigest },
      expected: { pages: expected.manifest.pages, recordCount: expected.records.length, canonicalDigest: expectedValidation.canonicalDigest },
      counts: Object.fromEntries(Object.entries(diff).map(([key, value]) => [key, value.length])),
      diff,
      ...(includeRecords ? {
        recordPairs: Object.fromEntries(Array.from(new Set([...actualById.keys(), ...expectedById.keys()])).map(id => [id, {
          actual: actualById.get(id),
          expected: expectedById.get(id)
        }]))
      } : {})
    }, null, 2));
    if (Object.values(diff).some(list => list.length > 0)) process.exitCode = 1;
    return;
  }

  console.log("Actual pages:", actual.manifest.pages.map(page => `${page.name}=${page.layerCount}`).join(", "));
  console.log("Expected pages:", expected.manifest.pages.map(page => `${page.name}=${page.layerCount}`).join(", "));
  console.log("Actual records:", actual.records.length);
  console.log("Expected records:", expected.records.length);
  console.log("Actual canonical digest:", actualValidation.canonicalDigest);
  console.log("Expected canonical digest:", expectedValidation.canonicalDigest);
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
  console.log("Deep prop mismatches:", diff.deepPropMismatches.length);
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
  console.log("Deep prop mismatch sample:", diff.deepPropMismatches.slice(0, 20));

  if (Object.values(diff).some(list => list.length > 0)) {
    console.log("Missing sample:", diff.missing.slice(0, 10).map(record => [record.id, record.name]));
    console.log("Extra sample:", diff.extra.slice(0, 10).map(record => [record.id, record.name]));
    console.log("Type mismatch sample:", diff.typeMismatches.slice(0, 10));
    console.log("Parent mismatch sample:", diff.parentMismatches.slice(0, 10));
    process.exitCode = 1;
  }
})();
