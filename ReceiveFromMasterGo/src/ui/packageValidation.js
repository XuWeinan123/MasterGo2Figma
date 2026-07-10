(function(global) {
  "use strict";

  function text(bytes) { return new TextDecoder("utf-8").decode(bytes); }
  function issue(errors, code, path, message) { errors.push({ code: code, path: path, message: message }); }
  function entry(entries, name) {
    if (entries[name]) return entries[name];
    return entries[Object.keys(entries).find(key => key === name || key.endsWith("/" + name))];
  }

  function fnv1a32Bytes(bytes) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  function stableJson(value) {
    if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
    if (!value || typeof value !== "object") return JSON.stringify(value);
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
  }

  function canonicalValue(value, assetDigestByAlias, key) {
    if (key === "imageRef" && typeof value === "string" && assetDigestByAlias[value]) {
      return assetDigestByAlias[value];
    }
    if (Array.isArray(value)) return value.map(item => canonicalValue(item, assetDigestByAlias, ""));
    if (!value || typeof value !== "object") return value;
    const result = {};
    for (const childKey of Object.keys(value)) {
      result[childKey] = canonicalValue(value[childKey], assetDigestByAlias, childKey);
    }
    return result;
  }

  function canonicalDigest(entries, manifest, pageIndexes, records) {
    const assetDigestByAlias = {};
    const assetDigests = [];
    const assets = manifest.assets || {};
    for (const alias of Object.keys(assets)) {
      const asset = assets[alias] || {};
      const bytes = asset.path ? entry(entries, asset.path) : null;
      const digest = asset.missing ? "missing" : (bytes ? "fnv1a32:" + fnv1a32Bytes(bytes) : "missing");
      assetDigestByAlias[alias] = digest;
      if (asset.path) assetDigestByAlias[asset.path.slice(asset.path.lastIndexOf("/") + 1)] = digest;
      assetDigests.push(digest);
    }

    const pages = pageIndexes.map(page => {
      const orderedRecords = [];
      const seen = new Set();
      const visit = id => {
        if (seen.has(id)) return;
        seen.add(id);
        const item = records.get(id);
        if (!item) return;
        orderedRecords.push(canonicalValue(item.record, assetDigestByAlias, ""));
        for (const childId of item.record.childIds) visit(childId);
      };
      for (const rootId of page.index.rootNodeIds) visit(rootId);
      return {
        id: page.manifest.id,
        name: page.manifest.name || "",
        rootNodeIds: page.index.rootNodeIds.slice(),
        records: orderedRecords
      };
    });
    const canonical = {
      schema: manifest.schema,
      version: manifest.version,
      documentId: manifest.documentId === undefined ? null : manifest.documentId,
      scope: manifest.scope || "",
      pages: pages,
      assetContentDigests: assetDigests.sort()
    };
    return "fnv1a32:" + fnv1a32Bytes(new TextEncoder().encode(stableJson(canonical)));
  }

  // Validate a decoded v2 package without retaining layer chunks. This is used
  // by both the browser UI and the Node comparator, so malformed packages fail
  // identically before they can create a Figma page.
  function validateV2Package(entries, options) {
    options = options || {};
    const errors = [], warnings = [];
    const manifestPath = options.manifestPath || (entries["manifest.json"] ? "manifest.json" : Object.keys(entries).find(p => p.endsWith("/manifest.json")));
    if (!manifestPath || !entries[manifestPath]) {
      issue(errors, "MANIFEST_MISSING", "manifest.json", "manifest.json is missing");
      return { ok: false, errors: errors, warnings: warnings };
    }
    let manifest;
    try { manifest = JSON.parse(text(entries[manifestPath])); }
    catch (_) { issue(errors, "MANIFEST_JSON", manifestPath, "manifest.json is invalid JSON"); return { ok: false, errors, warnings }; }
    if (manifest.schema !== "mastergo2figma.package.v2" || manifest.version !== 2) issue(errors, "MANIFEST_SCHEMA", manifestPath, "expected mastergo2figma.package.v2 version 2");
    if (!Array.isArray(manifest.pages)) issue(errors, "PAGES_INVALID", manifestPath, "manifest.pages must be an array");
    if (errors.length) return { ok: false, manifest, errors, warnings };

    const records = new Map();
    const pageIds = new Set();
    const pageIndexes = [];
    for (const page of manifest.pages) {
      const pagePath = String(page && page.pageFile || "");
      if (!page || !page.id || !pagePath) { issue(errors, "PAGE_INVALID", pagePath || "pages", "page id/pageFile is required"); continue; }
      if (pageIds.has(page.id)) issue(errors, "PAGE_DUPLICATE", page.id, "duplicate page id");
      pageIds.add(page.id);
      const bytes = entry(entries, pagePath);
      if (!bytes) { issue(errors, "PAGE_INDEX_MISSING", pagePath, "page index is missing"); continue; }
      let index;
      try { index = JSON.parse(text(bytes)); } catch (_) { issue(errors, "PAGE_INDEX_JSON", pagePath, "page index is invalid JSON"); continue; }
      if (!Array.isArray(index.rootNodeIds) || !Array.isArray(index.layerChunks)) { issue(errors, "PAGE_INDEX_INVALID", pagePath, "rootNodeIds/layerChunks must be arrays"); continue; }
      pageIndexes.push({ manifest: page, index: index, path: pagePath });
      for (const chunkPath of index.layerChunks) {
        const chunkBytes = entry(entries, chunkPath);
        if (!chunkBytes) { issue(errors, "CHUNK_MISSING", chunkPath, "layer chunk is missing"); continue; }
        let chunk;
        try { chunk = JSON.parse(text(chunkBytes)); } catch (_) { issue(errors, "CHUNK_JSON", chunkPath, "layer chunk is invalid JSON"); continue; }
        if (!Array.isArray(chunk.records)) { issue(errors, "CHUNK_INVALID", chunkPath, "chunk.records must be an array"); continue; }
        for (const record of chunk.records) {
          // The v2 wire format stores its version on the chunk; early valid
          // SendToFigma exports do not repeat it on each individual record.
          if (!record || !record.id || !record.props || !Array.isArray(record.childIds)) { issue(errors, "RECORD_INVALID", chunkPath, "invalid v2 layer record"); continue; }
          if (records.has(record.id)) issue(errors, "RECORD_DUPLICATE", record.id, "duplicate layer id");
          else records.set(record.id, { record: record, pageId: page.id });
        }
      }
    }

    const reachable = new Set();
    for (const page of pageIndexes) {
      const roots = page.index.rootNodeIds;
      if (page.manifest.layerCount !== undefined && Number(page.manifest.layerCount) !== roots.length && Number(page.manifest.layerCount) === 0 && roots.length !== 0) issue(errors, "PAGE_COUNT_INVALID", page.path, "empty page count conflicts with roots");
      const stack = roots.slice();
      while (stack.length) {
        const id = stack.pop();
        const item = records.get(id);
        if (!item) { issue(errors, "ROOT_OR_CHILD_MISSING", id, "referenced layer record is missing"); continue; }
        if (item.pageId !== page.manifest.id) issue(errors, "CROSS_PAGE_NODE", id, "node is referenced by a different page");
        if (reachable.has(id)) { issue(errors, "NODE_NOT_UNIQUE_REACHABLE", id, "node is reachable more than once"); continue; }
        reachable.add(id);
        if (item.record.parentId !== null && item.record.parentId !== undefined) {
          const parent = records.get(item.record.parentId);
          if (!parent || parent.pageId !== item.pageId || parent.record.childIds.indexOf(id) < 0) issue(errors, "PARENT_SYMMETRY", id, "parentId does not point back to child");
        }
        for (let childIndex = item.record.childIds.length - 1; childIndex >= 0; childIndex--) {
          const childId = item.record.childIds[childIndex];
          const child = records.get(childId);
          if (child && child.record.parentId !== id) issue(errors, "CHILD_SYMMETRY", childId, "child parentId does not match container");
          stack.push(childId);
        }
      }
    }
    for (const [id, item] of records) {
      if (!reachable.has(id)) issue(errors, "NODE_UNREACHABLE", id, "layer record is not reachable from a page root");
      const parent = item.record.parentId && records.get(item.record.parentId);
      if (parent && Number.isFinite(item.record.index) && parent.record.childIds[item.record.index] !== id) issue(errors, "INDEX_MISMATCH", id, "record index does not match parent childIds");
    }
    const assetTable = manifest.assets || {};
    for (const key of Object.keys(assetTable)) {
      const asset = assetTable[key] || {};
      if (asset.missing) { warnings.push({ code: "ASSET_DECLARED_MISSING", path: key }); continue; }
      if (!asset.path || !entry(entries, asset.path)) issue(errors, "ASSET_MISSING", key, "asset path is missing");
    }
    const expectedCount = manifest.stats && Number(manifest.stats.layerCount);
    if (Number.isFinite(expectedCount) && expectedCount !== records.size) issue(errors, "MANIFEST_LAYER_COUNT", "manifest.stats.layerCount", "layer count does not match records");
    const ok = errors.length === 0;
    return {
      ok: ok,
      manifest: manifest,
      records: records,
      reachableCount: reachable.size,
      canonicalDigest: ok ? canonicalDigest(entries, manifest, pageIndexes, records) : null,
      errors: errors,
      warnings: warnings
    };
  }

  const api = { validateV2Package: validateV2Package };
  global.MasterGoPackageValidation = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
