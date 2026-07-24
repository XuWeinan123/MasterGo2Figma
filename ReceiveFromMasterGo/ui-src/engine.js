// Framework-free import engine, ported verbatim from the old ui.template.html
// inline script. Owns the package state (manifest/entries), the zip/.mg
// parsing, and the chunked import stream to the plugin main thread. The React
// layer only renders state received through the callbacks passed to
// initEngine(); message protocol and memory behavior are unchanged.

let ui = {};

let manifest = null;
let entries = {};
let importLibraryStyles = [];
let packageRoot = "";
let pages = [];
let importActive = false;
let restoreStartMs = 0;
let importProgressMode = "idle";
let importProgressStage = "idle";
let importPrepareUnitsTotal = 0;
let importPrepareUnitsDone = 0;
let importRestoreTotal = 0;
let importAssetBytesTotal = 0;
let importAssetBytesDone = 0;
let importPageRecordsTotal = 0;
let importPageRecordsDone = 0;
let importRestoredNodesDone = 0;
let importPostprocessUnitsDone = 0;
let importFinalizeUnitsDone = 0;
let activeImportTransferId = "";
let lastDisplayedPercent = 0;
let importTransferSeq = 0;
let importRequestSeq = 0;
let activeImportClientTimings = null;
let pendingImportClientTimings = null;
const importAckResolvers = {};
const IMPORT_CHUNK_SIZE = 64 * 1024;
const IMPORT_YIELD_EVERY_CHUNKS = 32;
const IMPORT_PROGRESS_STAGES = {
  prepare: { offset: 0, weight: 5 },
  assets: { offset: 5, weight: 20 },
  pageSend: { offset: 25, weight: 10 },
  restore: { offset: 35, weight: 55 },
  postprocess: { offset: 90, weight: 8 },
  finalize: { offset: 98, weight: 2 }
};

function send(pluginMessage) {
  parent.postMessage({ pluginMessage }, "*");
}

export function initEngine(callbacks) {
  ui = callbacks || {};
  window.onmessage = (event) => {
    const message = event.data && event.data.pluginMessage;
    if (!message) return;

    if (message.type === "import-ack") {
      resolveImportAck(message);
      return;
    }

    if (message.type === "progress") {
      handleRestoreProgressMessage(message);
      return;
    }

    if (message.type === "complete") {
      if (!isCurrentImportMessage(message)) return;
      lastDisplayedPercent = 100;
      const missingImageAssetCount = message.missingImageAssetCount || 0;
      const fallbackConnectorCount = message.fallbackConnectorCount || 0;
      const restoredMissingFontTextNodeCount = message.restoredMissingFontTextNodeCount || 0;
      const failedMissingFontTextNodeCount = message.failedMissingFontTextNodeCount || 0;
      const details = [];
      if (missingImageAssetCount) details.push(`${missingImageAssetCount} 个图片缺失`);
      if (fallbackConnectorCount) details.push(`${fallbackConnectorCount} 个连接线已降级为折线`);
      if (restoredMissingFontTextNodeCount) details.push(`${restoredMissingFontTextNodeCount} 个文本字体已恢复`);
      if (failedMissingFontTextNodeCount) details.push(`${failedMissingFontTextNodeCount} 个文本字体仍缺失`);
      resetImportProgressMode();
      importActive = false;
      if (ui.onComplete) ui.onComplete({
        pageCount: message.pageCount || 0,
        layerCount: message.layerCount || 0,
        details
      });
      return;
    }

    if (message.type === "refresh-fonts-complete") {
      const failedTextNodeCount = message.failedTextNodeCount || 0;
      const restoredTextNodeCount = message.restoredTextNodeCount || 0;
      const manuallyResolvedTextNodeCount = message.manuallyResolvedTextNodeCount || 0;
      const candidateTextNodeCount = message.candidateTextNodeCount || 0;
      const details = [`扫描到 ${candidateTextNodeCount} 个缺失字体文本图层`];
      if (manuallyResolvedTextNodeCount) details.push(`${manuallyResolvedTextNodeCount} 个已手动处理`);
      if (restoredTextNodeCount) details.push(`${restoredTextNodeCount} 个已替换`);
      if (failedTextNodeCount) details.push(`${failedTextNodeCount} 个仍缺失`);
      if (ui.onRefreshFontsComplete) ui.onRefreshFontsComplete(details.join("，"));
      return;
    }

    if (message.type === "error") {
      if (!isCurrentImportMessage(message)) return;
      const error = new Error(message.message || "还原失败");
      resetImportProgressMode();
      // Settle every in-flight request so the stream loop exits now instead
      // of hanging until its own (possibly minutes-long) ack timeout.
      rejectAllImportAcks(error);
      importActive = false;
      if (ui.onImportError) ui.onImportError(error.message);
    }
  };
  send({ type: "ui-ready" });
}

export function hasPackage() {
  return !!manifest;
}

export function getPages() {
  return pages;
}

function createImportClientTimings() {
  return {
    totalsMs: {},
    counts: {},
    bytes: {},
    startedAt: Date.now()
  };
}

function cloneImportClientTimings(timings) {
  return {
    totalsMs: { ...((timings && timings.totalsMs) || {}) },
    counts: { ...((timings && timings.counts) || {}) },
    bytes: { ...((timings && timings.bytes) || {}) },
    startedAt: Date.now()
  };
}

function addClientTiming(name, ms, count) {
  const timings = activeImportClientTimings || pendingImportClientTimings;
  if (!timings || !Number.isFinite(ms)) return;
  timings.totalsMs[name] = (timings.totalsMs[name] || 0) + Math.max(0, Math.round(ms));
  timings.counts[name] = (timings.counts[name] || 0) + (count === undefined ? 1 : Math.max(0, Math.round(count)));
}

function setClientTimingCount(name, count) {
  const timings = activeImportClientTimings || pendingImportClientTimings;
  if (!timings || !Number.isFinite(count)) return;
  timings.counts[name] = Math.max(0, Math.round(count));
}

function addClientTimingBytes(name, bytes) {
  const timings = activeImportClientTimings || pendingImportClientTimings;
  if (!timings || !Number.isFinite(bytes)) return;
  timings.bytes[name] = (timings.bytes[name] || 0) + Math.max(0, Math.round(bytes));
}

function postClientTimings(transferId) {
  if (!activeImportClientTimings) return;
  send({
    type: "import-client-timing",
    transferId,
    clientTimings: activeImportClientTimings
  });
}

function emitProgress(percent) {
  if (ui.onProgress) ui.onProgress({
    percent: Math.round(percent),
    stage: importProgressStage,
    layersDone: importRestoredNodesDone,
    layersTotal: importRestoreTotal
  });
}

function setProgress(current, total) {
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;
  setDisplayedProgress(percent);
}

function setStageProgress(stage, current, total) {
  const config = IMPORT_PROGRESS_STAGES[stage] || { offset: 0, weight: 100 };
  const ratio = total > 0 ? Math.max(0, Math.min(1, current / total)) : 0;
  const percent = config.offset + ratio * config.weight;
  importProgressStage = stage;
  setDisplayedProgress(percent);
}

function setDisplayedProgress(percent) {
  percent = Math.max(0, Math.min(100, Math.round(percent)));
  if (activeImportTransferId) percent = Math.max(lastDisplayedPercent, percent);
  lastDisplayedPercent = percent;
  emitProgress(percent);
}

function beginImportPrepareProgress(selectedPages, transferId) {
  importProgressMode = "prepare";
  importProgressStage = "prepare";
  activeImportTransferId = transferId || "";
  lastDisplayedPercent = 0;
  importPrepareUnitsDone = 0;
  importRestoreTotal = selectedPages.reduce((sum, page) => sum + (page.layerCount || 0), 0);
  importPrepareUnitsTotal = Math.max(1, selectedPages.reduce((sum, page) => {
    return sum + (page.layerCount || 0) * 2 + 20;
  }, 0));
  importAssetBytesTotal = 0;
  importAssetBytesDone = 0;
  importPageRecordsTotal = 0;
  importPageRecordsDone = 0;
  importRestoredNodesDone = 0;
  importPostprocessUnitsDone = 0;
  importFinalizeUnitsDone = 0;
  setPrepareProgress();
}

function setPrepareProgress() {
  if (importProgressMode !== "prepare") return;
  setStageProgress("prepare", Math.min(importPrepareUnitsDone, importPrepareUnitsTotal), importPrepareUnitsTotal);
}

function advancePrepareProgress(units) {
  if (importProgressMode !== "prepare") return;
  importPrepareUnitsDone = Math.min(importPrepareUnitsTotal, importPrepareUnitsDone + Math.max(0, units || 0));
  setPrepareProgress();
}

function beginImportRestoreProgress() {
  importProgressMode = "restore";
  importProgressStage = "restore";
  setStageProgress("restore", importRestoredNodesDone, importRestoreTotal);
}

function handleRestoreProgressMessage(message) {
  if (!isCurrentImportMessage(message)) return;
  const current = message.current || 0;
  const total = message.total || 0;
  if (message.stage === "postprocess") {
    importProgressMode = "restore";
    importRestoredNodesDone = Math.max(importRestoredNodesDone, current);
    importPostprocessUnitsDone = Math.max(importPostprocessUnitsDone, message.postprocessCurrent || 0);
    const percent = IMPORT_PROGRESS_STAGES.restore.offset +
      (importRestoreTotal > 0 ? (importRestoredNodesDone / importRestoreTotal) * IMPORT_PROGRESS_STAGES.restore.weight : 0) +
      (importRestoreTotal > 0 ? (importPostprocessUnitsDone / importRestoreTotal) * IMPORT_PROGRESS_STAGES.postprocess.weight : 0);
    importProgressStage = "postprocess";
    setDisplayedProgress(percent);
    return;
  }
  if (message.stage === "finalize") {
    importProgressMode = "restore";
    importFinalizeUnitsDone = Math.max(importFinalizeUnitsDone, message.finalizeCurrent || current || 0);
    setStageProgress("finalize", importFinalizeUnitsDone, message.finalizeTotal || total || 1);
    return;
  }
  if (message.stage === "restore" && current <= 0 && importProgressMode === "prepare") {
    return;
  }
  if (message.stage === "restore" || current > 0) {
    importRestoredNodesDone = Math.max(importRestoredNodesDone, current);
    if (importProgressMode === "prepare") {
      beginImportRestoreProgress();
    }
    setStageProgress("restore", importRestoredNodesDone, total || importRestoreTotal);
    return;
  }
  setProgress(current, total);
}

function resetImportProgressMode() {
  importProgressMode = "idle";
  importProgressStage = "idle";
  importPrepareUnitsTotal = 0;
  importPrepareUnitsDone = 0;
  importRestoreTotal = 0;
  importAssetBytesTotal = 0;
  importAssetBytesDone = 0;
  importPageRecordsTotal = 0;
  importPageRecordsDone = 0;
  importRestoredNodesDone = 0;
  importPostprocessUnitsDone = 0;
  importFinalizeUnitsDone = 0;
  activeImportTransferId = "";
  lastDisplayedPercent = 0;
}

function isCurrentImportMessage(message) {
  if (!message || !message.transferId) return true;
  // No active transfer (idle, or reset after a local failure): drop late
  // main-thread progress — it used to repaint over the error status with
  // stale "页面完成" labels and zeroed totals.
  return !!activeImportTransferId && message.transferId === activeImportTransferId;
}

export async function parseFiles(files) {
  pendingImportClientTimings = createImportClientTimings();
  activeImportClientTimings = null;

  importLibraryStyles = [];
  const mergedManifest = {
    schema: "mastergo2figma.package.v2",
    version: 2,
    source: "mastergo",
    exportedAt: new Date().toISOString(),
    scope: "composite-pages",
    pages: [],
    assets: {},
    stats: {
      pageCount: 0,
      layerCount: 0,
      imageAssetCount: 0,
      missingImageAssetCount: 0
    }
  };

  entries = {};
  const fileNames = [];

  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      fileNames.push(file.name);

      const fileReadStartedAt = Date.now();
      const buffer = await file.arrayBuffer();
      addClientTiming("ui.file.arrayBufferMs", Date.now() - fileReadStartedAt);
      addClientTimingBytes("ui.file.bytes", buffer.byteLength || 0);
      const zipReadStartedAt = Date.now();
      let zipEntries = await readZipEntries(buffer);
      addClientTiming("ui.zip.readEntriesMs", Date.now() - zipReadStartedAt, Object.keys(zipEntries).length);

      // MasterGo's native .mg export is also a zip, but instead of a v2
      // manifest it stores a binary "document" + meta.json + images/.
      // Convert it into the same in-memory v2 package the rest of the
      // pipeline already understands, so nothing downstream has to change.
      if (window.MasterGoMg.isMgPackage(file.name, zipEntries)) {
        // slimInstanceDescendants: instance-descendant records are only
        // read for override matching in the plugin — full props (455MB of
        // vectorNetwork etc. on the Tesla fixture) OOM the Figma tab.
        // CLI/compare-tool conversions stay full-fidelity (no options).
        zipEntries = window.MasterGoMg.convertMgPackageToV2Entries(zipEntries, file.name, { slimInstanceDescendants: true });
      }

      const manifestPath = findManifestPath(zipEntries);
      if (!manifestPath) {
        throw new Error(`文件 "${file.name}" 中没有 manifest.json`);
      }

      const zipPackageRoot = manifestPath.slice(0, manifestPath.length - "manifest.json".length);

      const manifestBytes = zipEntries[manifestPath];
      if (!manifestBytes) {
        throw new Error(`无法读取 "${file.name}" 的 manifest.json`);
      }

      const manifestParseStartedAt = Date.now();
      const zipManifest = JSON.parse(decodeUtf8(manifestBytes));
      addClientTiming("ui.manifest.parseMs", Date.now() - manifestParseStartedAt);
      const validation = window.MasterGoPackageValidation.validateV2Package(zipEntries, { manifestPath });
      if (!validation.ok) {
        const first = validation.errors[0];
        throw new Error(`文件 "${file.name}" 校验失败：${first.code}（${first.path}）`);
      }

      // Copy entries into global entries with prefix "zip_${i}/"
      for (const path in zipEntries) {
        entries[`zip_${i}/${path}`] = zipEntries[path];
      }

      // Library styles payload (native .mg conversions emit styles.json).
      // Style ids get the same per-zip prefix as record ids so the
      // record-level style refs keep resolving after the merge.
      const stylesBytes = zipEntries[`${zipPackageRoot}styles.json`] || zipEntries["styles.json"];
      if (stylesBytes) {
        try {
          const parsedStyles = JSON.parse(decodeUtf8(stylesBytes));
          if (parsedStyles && Array.isArray(parsedStyles.styles)) {
            for (const style of parsedStyles.styles) {
              if (style && style.id) importLibraryStyles.push({ ...style, id: `zip_${i}_${style.id}` });
            }
          }
        } catch (e) { /* styles are additive — ignore malformed payloads */ }
      }

      // Merge pages
      for (const page of zipManifest.pages) {
        const mergedPage = {
          ...page,
          id: `zip_${i}_${page.id}`,
          pageFile: `zip_${i}/${zipPackageRoot}${page.pageFile}`,
          zipIndex: i,
          zipPackageRoot: zipPackageRoot
        };
        mergedManifest.pages.push(mergedPage);
      }

      // Merge assets
      if (zipManifest.assets && typeof zipManifest.assets === "object") {
        for (const key in zipManifest.assets) {
          const asset = zipManifest.assets[key];
          if (asset) {
            const mergedKey = `zip_${i}_${key}`;
            mergedManifest.assets[mergedKey] = {
              ...asset,
              key: mergedKey,
              path: asset.path ? `zip_${i}/${zipPackageRoot}${asset.path}` : ""
            };
          }
        }
      }

      // Accumulate stats
      mergedManifest.stats.pageCount += zipManifest.stats?.pageCount || zipManifest.pages.length || 0;
      mergedManifest.stats.layerCount += zipManifest.stats?.layerCount || 0;
      mergedManifest.stats.imageAssetCount += zipManifest.stats?.imageAssetCount || 0;
      mergedManifest.stats.missingImageAssetCount += zipManifest.stats?.missingImageAssetCount || 0;
    }
  } catch (error) {
    resetPackage();
    throw error;
  }

  manifest = mergedManifest;
  pages = mergedManifest.pages;

  return {
    fileNames,
    pageCount: manifest.pages.length,
    layerCount: manifest.stats.layerCount || 0,
    pages: manifest.pages.map(page => ({
      id: page.id,
      name: page.name,
      displayName: page.originalName || page.name,
      layerCount: page.layerCount || 0
    }))
  };
}

export function resetPackage() {
  manifest = null;
  entries = {};
  importLibraryStyles = [];
  packageRoot = "";
  pages = [];
  pendingImportClientTimings = null;
  activeImportClientTimings = null;
  resetImportProgressMode();
}

export async function startImport(selectedIds) {
  if (importActive) throw new Error("导入正在进行中");
  if (!manifest) throw new Error("请先选择有效的 .mg 文件");
  const selectedSet = new Set(selectedIds);
  const selectedPages = pages.filter(page => selectedSet.has(page.id));
  if (selectedPages.length === 0) throw new Error("请至少选择一个页面");

  importActive = true;
  restoreStartMs = Date.now();
  try {
    await streamImportPayload(manifest, selectedPages);
  } catch (error) {
    resetImportProgressMode();
    importActive = false;
    throw error;
  }
}

export function refreshFonts() {
  send({ type: "refresh-fonts" });
}

export function closePlugin() {
  send({ type: "close" });
}

// Single recursive pass over a record's props doing what used to be three
// separate full-tree walks (prefixImageRefs + prefixConnectorEndpointNodeIds
// + collectImageRefs). The three mutations touch independent fields, so
// applying them in one visit per node yields identical results; imageRefs
// are collected after prefixing, matching the previous walk order.
function prepareImportProps(obj, prefix, assetKeys) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      prepareImportProps(obj[i], prefix, assetKeys);
    }
    return;
  }
  if (obj.type === "IMAGE" && typeof obj.imageRef === "string") {
    obj.imageRef = prefix + obj.imageRef;
    assetKeys[obj.imageRef] = true;
  }
  if (typeof obj.endpointNodeId === "string") {
    obj.endpointNodeId = prefix + obj.endpointNodeId;
  }
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      prepareImportProps(obj[key], prefix, assetKeys);
    }
  }
}

function prepareRecordForImport(record, prefix, assetKeys) {
  record.id = `${prefix}${record.id}`;
  if (record.parentId) record.parentId = `${prefix}${record.parentId}`;
  if (Array.isArray(record.childIds)) {
    record.childIds = record.childIds.map(cid => `${prefix}${cid}`);
  }
  // The component reference must be prefixed like every other record id:
  // the plugin resolves it against restoredNodeById, which is keyed by the
  // PREFIXED ids — an unprefixed ref silently misses and every instance
  // falls back to a frame shell.
  if (record.mainComponentId) record.mainComponentId = `${prefix}${record.mainComponentId}`;
  // Library style refs resolve against the per-zip prefixed style ids.
  if (record.fillStyleRef) record.fillStyleRef = `${prefix}${record.fillStyleRef}`;
  if (record.strokeStyleRef) record.strokeStyleRef = `${prefix}${record.strokeStyleRef}`;
  if (record.effectStyleRef) record.effectStyleRef = `${prefix}${record.effectStyleRef}`;
  if (record.textStyleRef) record.textStyleRef = `${prefix}${record.textStyleRef}`;
  if (record.props) {
    prepareImportProps(record.props, prefix, assetKeys);
  }
}

// Cheap pre-flight over all selected pages (page index files exist, parse
// and pass schema checks, every layer-chunk entry exists) so a broken
// package still fails BEFORE import-session-start — same failure timing as
// the old prepare-everything-first flow, without holding all pages' data.
function verifyPageEntriesExist(selectedPages) {
  for (const page of selectedPages) {
    if (!page.pageFile) throw new Error(`页面缺少索引文件：${page.name || page.id}`);
    const pageBytes = getPackageEntry(page.pageFile);
    if (!pageBytes) throw new Error(`缺少页面索引文件：${page.pageFile}`);
    const pageIndex = JSON.parse(decodeUtf8(pageBytes));
    if (pageIndex.schema !== "mastergo2figma.page.v2" || pageIndex.version !== 2) {
      throw new Error(`页面索引格式不正确：${page.pageFile}`);
    }
    if (!Array.isArray(pageIndex.layerChunks)) throw new Error(`页面缺少图层分块索引：${page.pageFile}`);
    for (const chunkPath of pageIndex.layerChunks) {
      const fullChunkPath = `zip_${page.zipIndex}/${page.zipPackageRoot}${chunkPath}`;
      if (!getPackageEntry(fullChunkPath)) throw new Error(`缺少图层分块文件：${fullChunkPath}`);
    }
  }
}

async function streamImportPayload(sourceManifest, selectedPages) {
  const transferId = `import_${Date.now()}_${++importTransferSeq}`;
  activeImportClientTimings = cloneImportClientTimings(pendingImportClientTimings);
  activeImportClientTimings.transferId = transferId;
  activeImportClientTimings.selectedPageCount = selectedPages.length;
  activeImportClientTimings.selectedLayerCount = selectedPages.reduce((sum, page) => sum + (page.layerCount || 0), 0);
  const importStartedAt = Date.now();
  beginImportPrepareProgress(selectedPages, transferId);
  const totalNodes = selectedPages.reduce((sum, page) => sum + (page.layerCount || 0), 0);
  const selectedManifest = {
    ...sourceManifest,
    pages: selectedPages.map(page => ({
      id: page.id,
      name: page.name,
      folder: page.folder,
      pageFile: page.pageFile,
      layerCount: page.layerCount || 0
    })),
    stats: {
      ...(sourceManifest.stats || {}),
      pageCount: selectedPages.length,
      layerCount: totalNodes
    }
  };

  setPrepareProgress();
  verifyPageEntriesExist(selectedPages);
  setClientTimingCount("ui.prepare.selectedPages", selectedPages.length);
  setClientTimingCount("ui.prepare.selectedLayers", totalNodes);

  const sessionStartStartedAt = Date.now();
  await sendImportRequest({
    type: "import-session-start",
    transferId,
    manifest: selectedManifest,
    totalPages: selectedPages.length,
    totalNodes,
    clientTimings: activeImportClientTimings
  });
  addClientTiming("ui.session.startAckMs", Date.now() - sessionStartStartedAt);

  // Library styles go right after the session opens, before any page —
  // node records reference them during restore.
  if (importLibraryStyles.length > 0) {
    await sendImportRequest({
      type: "import-styles",
      transferId,
      styles: importLibraryStyles
    }, 30000);
  }

  // Pages are prepared lazily, one at a time, right before they are sent:
  // the UI's memory peak drops from "records of ALL selected pages at
  // once" to a single page. The on-the-wire message order is unchanged
  // (session-start; then per page: assets → page-start → chunks →
  // page-end). Only progress pacing differs, and the progress bar is
  // monotonic by construction (setDisplayedProgress clamps).
  const sentAssetPaths = {};
  for (let pageIndex = 0; pageIndex < selectedPages.length; pageIndex++) {
    const page = selectedPages[pageIndex];
    setPrepareProgress();
    const pagePrepareStartedAt = Date.now();
    const pageData = buildPageImportData(page);
    addClientTiming("ui.prepare.pageDataMs", Date.now() - pagePrepareStartedAt);
    addClientTiming("ui.prepare.totalMs", Date.now() - pagePrepareStartedAt);
    const assetTransfers = getRequiredAssetTransfers(sourceManifest, pageData.assetKeys, sentAssetPaths);
    importAssetBytesTotal += getAssetTransferBytes(assetTransfers);
    importPageRecordsTotal += getLayerChunkRecordCount(pageData.layerChunks);

    if (assetTransfers.length > 0) {
      setStageProgress("assets", importAssetBytesDone, importAssetBytesTotal);
    }
    for (const asset of assetTransfers) {
      await streamImportAsset(transferId, asset);
    }

    setStageProgress("pageSend", importPageRecordsDone, importPageRecordsTotal);
    const pageStartAckStartedAt = Date.now();
    await sendImportRequest({
      type: "import-page-start",
      transferId,
      pageIndex,
      page: pageData.page
    }, 30000);
    addClientTiming("ui.page.startAckMs", Date.now() - pageStartAckStartedAt);
    const pageChunkPostStartedAt = Date.now();
    for (let chunkIndex = 0; chunkIndex < pageData.layerChunks.length; chunkIndex++) {
      const records = pageData.layerChunks[chunkIndex];
      send({
        type: "import-page-chunk",
        transferId,
        pageIndex,
        chunkIndex,
        records
      });
      // Release the UI-side copy right away: the plugin main thread is
      // building its own copy of these records while this loop runs, and
      // on 200k-record pages holding both simultaneously OOMs the tab.
      pageData.layerChunks[chunkIndex] = null;
      importPageRecordsDone = Math.min(importPageRecordsTotal, importPageRecordsDone + records.length);
      setStageProgress("pageSend", importPageRecordsDone, importPageRecordsTotal);
      if ((chunkIndex + 1) % IMPORT_YIELD_EVERY_CHUNKS === 0) await waitForUIRelease();
    }
    addClientTiming("ui.page.chunkPostMs", Date.now() - pageChunkPostStartedAt);
    if (importProgressMode === "prepare") beginImportRestoreProgress();
    const pageEndTimeoutMs = getImportPageEndTimeoutMs(pageData, assetTransfers);
    const pageRestoreWaitStartedAt = Date.now();
    await sendImportRequest({
      type: "import-page-end",
      transferId,
      pageIndex,
      pageName: pageData.page.name || pageData.page.id
    }, pageEndTimeoutMs, `页面还原超时：${pageData.page.name || pageData.page.id}`);
    addClientTiming("ui.page.restoreWaitMs", Date.now() - pageRestoreWaitStartedAt);
    postClientTimings(transferId);
    if (ui.onPageDone) ui.onPageDone(pageIndex + 1, selectedPages.length);
  }

  addClientTiming("ui.import.untilCompletePostMs", Date.now() - importStartedAt);
  send({ type: "import-session-complete", transferId, clientTimings: activeImportClientTimings });
}

function buildPageImportData(page) {
  const assetKeys = {};
  if (!page.pageFile) throw new Error(`页面缺少索引文件：${page.name || page.id}`);
  const pageBytes = getPackageEntry(page.pageFile);
  if (!pageBytes) throw new Error(`缺少页面索引文件：${page.pageFile}`);
  const pageIndex = JSON.parse(decodeUtf8(pageBytes));
  if (pageIndex.schema !== "mastergo2figma.page.v2" || pageIndex.version !== 2) {
    throw new Error(`页面索引格式不正确：${page.pageFile}`);
  }
  if (!Array.isArray(pageIndex.layerChunks)) throw new Error(`页面缺少图层分块索引：${page.pageFile}`);

  const zipIndex = page.zipIndex;
  const zipPackageRoot = page.zipPackageRoot;
  const prefix = `zip_${zipIndex}_`;

  pageIndex.id = `${prefix}${pageIndex.id}`;
  if (Array.isArray(pageIndex.rootNodeIds)) {
    pageIndex.rootNodeIds = pageIndex.rootNodeIds.map(rid => `${prefix}${rid}`);
  }

  // Records are parsed fresh from the zip bytes on every restore run, so
  // each record object has a single owner here and is prefixed in place —
  // the previous defensive deep clone (cloneJson) doubled memory and cost
  // a full stringify+parse of the whole page for nothing.
  const rawRecordsById = {};
  const sourceChunkRecords = [];
  for (let chunkIndex = 0; chunkIndex < pageIndex.layerChunks.length; chunkIndex++) {
    const chunkPath = pageIndex.layerChunks[chunkIndex];
    const fullChunkPath = `zip_${zipIndex}/${zipPackageRoot}${chunkPath}`;
    const bytes = getPackageEntry(fullChunkPath);
    if (!bytes) throw new Error(`缺少图层分块文件：${fullChunkPath}`);
    const chunk = JSON.parse(decodeUtf8(bytes));

    if (chunk.schema !== "mastergo2figma.layers.v2" || !Array.isArray(chunk.records)) {
      throw new Error(`图层分块格式不正确：${chunkPath}`);
    }
    sourceChunkRecords.push(chunk.records);
    for (const record of chunk.records) {
      if (record && record.id) rawRecordsById[record.id] = record;
    }
    advancePrepareProgress(chunk.records.length);
  }

  const reachableIds = collectReachableLayerIds(pageIndex.rootNodeIds, rawRecordsById, prefix);
  const reachableCount = reachableIds.length;
  const reachableSet = {};
  for (const id of reachableIds) reachableSet[id] = true;

  // Emit message chunks following the source layer-chunk grouping: the
  // export side already bounds each chunk to <=16 records / ~64 KiB, so no
  // per-record JSON.stringify size probing is needed. Only the winning
  // occurrence of a duplicated id (last one in rawRecordsById) is emitted,
  // matching the previous by-id dedup. Grouping/order of import-page-chunk
  // messages is not part of the contract — the plugin accumulates records
  // into a dict and restores from rootNodeIds/childIds.
  const layerChunks = [];
  let organizedCount = 0;
  let lastOrganizedCount = 0;
  for (const records of sourceChunkRecords) {
    const emitted = [];
    for (const record of records) {
      if (!record || !record.id) continue;
      if (!reachableSet[record.id] || rawRecordsById[record.id] !== record) continue;
      prepareRecordForImport(record, prefix, assetKeys);
      emitted.push(record);
      organizedCount++;
      if (organizedCount % 100 === 0 || organizedCount === reachableCount) {
        advancePrepareProgress(organizedCount - lastOrganizedCount);
        lastOrganizedCount = organizedCount;
      }
    }
    if (emitted.length > 0) layerChunks.push(emitted);
  }

  if (Array.isArray(pageIndex.layerChunks)) {
    pageIndex.layerChunks = pageIndex.layerChunks.map(chunkPath => `zip_${zipIndex}/${zipPackageRoot}${chunkPath}`);
  }

  return {
    page: pageIndex,
    layerChunks,
    // Captured while the chunk arrays still exist — the posting loop
    // nulls layerChunks slots to release memory, which silently zeroed
    // every later record-count read (the page-end timeout collapsed from
    // ~19min to the 120s floor on 29k-node pages and BIG timed out).
    recordCount: organizedCount,
    assetKeys
  };
}

function collectReachableLayerIds(rootNodeIds, recordsById, prefix) {
  const result = [];
  const seen = {};
  const stack = [];
  for (const prefixedRootId of rootNodeIds || []) {
    const rawRootId = stripPrefix(prefixedRootId, prefix);
    if (rawRootId) stack.push(rawRootId);
  }
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || seen[id] || !recordsById[id]) continue;
    seen[id] = true;
    result.push(id);
    const children = Array.isArray(recordsById[id].childIds) ? recordsById[id].childIds : [];
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push(children[index]);
    }
  }
  return result;
}

function stripPrefix(value, prefix) {
  return typeof value === "string" && value.indexOf(prefix) === 0 ? value.slice(prefix.length) : value;
}

function getRequiredAssetTransfers(sourceManifest, assetKeys, sentAssetPaths) {
  const assetMap = sourceManifest.assets || {};
  const byPath = {};
  for (const key in assetKeys) {
    const asset = assetMap[key];
    if (!asset || asset.missing || !asset.path || sentAssetPaths[asset.path]) continue;
    const bytes = getPackageEntry(asset.path);
    if (!bytes) continue;
    byPath[asset.path] = {
      path: asset.path,
      bytes,
      keys: []
    };
  }
  for (const key in assetMap) {
    const asset = assetMap[key];
    if (asset && asset.path && byPath[asset.path]) byPath[asset.path].keys.push(key);
  }
  const transfers = [];
  for (const path in byPath) {
    sentAssetPaths[path] = true;
    transfers.push(byPath[path]);
  }
  return transfers;
}

function getAssetTransferBytes(assetTransfers) {
  return assetTransfers.reduce((sum, asset) => sum + (asset.bytes ? asset.bytes.length : 0), 0);
}

function getLayerChunkRecordCount(layerChunks) {
  return (layerChunks || []).reduce((sum, records) => sum + (Array.isArray(records) ? records.length : 0), 0);
}

function getImportPageEndTimeoutMs(pageData, assetTransfers) {
  const recordCount = pageData.recordCount !== undefined
    ? pageData.recordCount
    : getLayerChunkRecordCount(pageData.layerChunks);
  const assetBytes = getAssetTransferBytes(assetTransfers);
  const scaledByNodes = recordCount * 35;
  const scaledByAssets = Math.ceil(assetBytes / (1024 * 1024)) * 5000;
  return Math.min(45 * 60 * 1000, Math.max(120000, 120000 + scaledByNodes + scaledByAssets));
}

async function streamImportAsset(transferId, asset) {
  const assetSendStartedAt = Date.now();
  await sendImportRequest({
    type: "import-asset-start",
    transferId,
    path: asset.path,
    keys: asset.keys,
    size: asset.bytes.length
  });
  setStageProgress("assets", importAssetBytesDone, importAssetBytesTotal);

  for (let offset = 0, chunkIndex = 0; offset < asset.bytes.length; offset += IMPORT_CHUNK_SIZE, chunkIndex++) {
    const bytes = asset.bytes.slice(offset, offset + IMPORT_CHUNK_SIZE);
    send({
      type: "import-asset-chunk",
      transferId,
      path: asset.path,
      chunkIndex,
      bytes
    });
    importAssetBytesDone = Math.min(importAssetBytesTotal, importAssetBytesDone + bytes.length);
    setStageProgress("assets", importAssetBytesDone, importAssetBytesTotal);
    if ((chunkIndex + 1) % IMPORT_YIELD_EVERY_CHUNKS === 0) await waitForUIRelease();
  }

  await sendImportRequest({
    type: "import-asset-end",
    transferId,
    path: asset.path
  }, 60000);
  addClientTiming("ui.asset.sendMs", Date.now() - assetSendStartedAt);
  addClientTimingBytes("ui.asset.bytes", asset.bytes.length);
  setStageProgress("assets", importAssetBytesDone, importAssetBytesTotal);
}

function sendImportRequest(message, timeoutMs, timeoutLabel) {
  return new Promise((resolve, reject) => {
    const requestId = `req_${++importRequestSeq}`;
    const timeout = setTimeout(() => {
      delete importAckResolvers[requestId];
      const timeoutSeconds = Math.round((timeoutMs || 30000) / 1000);
      reject(new Error(`${timeoutLabel || `导入消息超时：${message.type}`}（${timeoutSeconds}s），最后进度：${lastDisplayedPercent}%`));
    }, timeoutMs || 30000);
    importAckResolvers[requestId] = { resolve, reject, timeout };
    send({ ...message, requestId });
  });
}

function resolveImportAck(message) {
  const requestId = message.requestId;
  const resolver = requestId ? importAckResolvers[requestId] : null;
  if (!resolver) return false;
  clearTimeout(resolver.timeout);
  delete importAckResolvers[requestId];
  if (message.success) resolver.resolve(message);
  else resolver.reject(new Error(message.error || "导入消息失败"));
  return true;
}

function rejectAllImportAcks(error) {
  for (const requestId in importAckResolvers) {
    const resolver = importAckResolvers[requestId];
    clearTimeout(resolver.timeout);
    delete importAckResolvers[requestId];
    resolver.reject(error);
  }
}

function waitForUIRelease() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function findManifestPath(zipEntries) {
  if (zipEntries["manifest.json"]) return "manifest.json";
  return Object.keys(zipEntries).find(path => path.endsWith("/manifest.json")) || "";
}

function getPackageEntry(path) {
  return entries[path] || entries[`${packageRoot}${path}`] || null;
}

function decodeUtf8(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}

async function readZipEntries(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const eocdOffset = findEndOfCentralDirectory(view);
  if (eocdOffset < 0) throw new Error("不是有效的 zip 文件");

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const result = {};
  let offset = centralOffset;

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("zip 中央目录损坏");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decodeUtf8(bytes.slice(offset + 46, offset + 46 + nameLength));

    if (!name.endsWith("/")) {
      result[name] = await readZipFileEntry(bytes, view, localOffset, method, compressedSize);
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return result;
}

async function readZipFileEntry(bytes, view, localOffset, method, compressedSize) {
  if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("zip 本地文件头损坏");

  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const compressed = bytes.subarray(dataStart, dataStart + compressedSize);

  if (method === 0) return compressed;
  if (method === 8 && typeof DecompressionStream === "function") {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  throw new Error("暂不支持此 zip 压缩方式，请使用 SendToFigma 导出的 zip");
}

function findEndOfCentralDirectory(view) {
  for (let offset = view.byteLength - 22; offset >= 0; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}
