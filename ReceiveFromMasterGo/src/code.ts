import { ImportPayload, ImportLayerRecord, ImportManifest, ImportPageIndex } from "../../shared/types";
import { state } from "./state";
import {
  ensureLayerRulesLoaded, hasValidLayerRules, getLayerRuleStatus
} from "./layerRules";
import { restoreMissingFontTextLayers } from "./appliers/text";
import {
  applyDeferredConnectorRestores,
  createConnectorVectorNetworkFromData
} from "./appliers/connector";
import {
  applyDeferredLayoutRestores,
  applyDeferredSingleChildAutoSpaceAlignmentFixes
} from "./deferredLayout";
import {
  cleanupImportedContainerShells, createNodeFromData,
  appendRestoredNode, safeRemove, hasUsableVectorNetwork
} from "./nodeCreator";
import { applyProperties } from "./propertyApplier";
import {
  shouldRestoreBooleanOperationTree,
  shouldRestoreBooleanVectorAsFrame,
  restoreBooleanOperationTree,
  createBooleanFrameFallbackProps,
  shouldRestoreGroupNode,
  restoreGroupNode,
  shouldRestoreComponentSetNode,
  restoreComponentSetNode
} from "./appliers/container";
import { yieldToEventLoop } from "../../shared/utils";

const RESTORE_PROGRESS_NODE_INTERVAL = 100;
const RESTORE_PROGRESS_TIME_INTERVAL_MS = 500;
const PAGE_POSTPROCESS_STAGE_COUNT = 3;

type ImportSession = {
  transferId: string;
  manifest: ImportManifest;
  totalPages: number;
  totalNodes: number;
  restoredNodes: number;
  postProcessedNodes: number;
  restoredPages: PageNode[];
  previousCurrentPage: PageNode;
};

type PendingAsset = {
  path: string;
  keys: string[];
  size: number;
  chunks: Uint8Array[];
};

type PendingPage = {
  pageIndex: number;
  page: ImportPageIndex;
  layers: { [id: string]: ImportLayerRecord };
  recordCount: number;
};

let activeImportSession: ImportSession | null = null;
const pendingImportAssets: { [path: string]: PendingAsset } = {};
const pendingImportPages: { [pageIndex: string]: PendingPage } = {};

showImportUI();

function showImportUI() {
  ensureLayerRulesLoaded();
  figma.showUI(__html__, { width: 400, height: 630 });
  figma.ui.onmessage = async (message) => {
    if (!message || typeof message !== "object") return;

    if (message.type === "ui-ready") {
      await postInitUI();
      return;
    }

    if (message.type === "close") {
      figma.closePlugin();
      return;
    }

    if (message.type === "resize") {
      const width = typeof message.width === "number" ? message.width : 400;
      const height = typeof message.height === "number" ? message.height : 504;
      figma.ui.resize(width, height);
      return;
    }

    if (message.type === "import-session-start") {
      await handleImportRequest(message, () => startImportSession(message));
      return;
    }

    if (message.type === "import-asset-start") {
      await handleImportRequest(message, () => startImportAsset(message));
      return;
    }

    if (message.type === "import-asset-chunk") {
      appendImportAssetChunk(message);
      return;
    }

    if (message.type === "import-asset-end") {
      await handleImportRequest(message, () => finishImportAsset(message));
      return;
    }

    if (message.type === "import-page-start") {
      await handleImportRequest(message, () => startImportPage(message));
      return;
    }

    if (message.type === "import-page-chunk") {
      appendImportPageChunk(message);
      return;
    }

    if (message.type === "import-page-end") {
      await handleImportRequest(message, () => finishImportPage(message));
      return;
    }

    if (message.type === "import-page") {
      await handleImportRequest(message, () => restoreImportSessionPage(message));
      return;
    }

    if (message.type === "import-session-complete") {
      await completeImportSession(message);
      return;
    }

    if (message.type !== "start-import") return;
    if (state.importInProgress) return;

    state.importInProgress = true;
    try {
      await ensureLayerRulesLoaded();
      if (message.payload) {
        await restoreImportPayload(message.payload as ImportPayload);
      } else {
        throw new Error("请先选择有效的 MasterGo2Figma zip");
      }
    } catch (error) {
      console.error("Import failed:", error);
      figma.ui.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : "导入失败，请查看控制台"
      });
    }
    state.importInProgress = false;
  };
}

async function handleImportRequest(message: any, action: () => Promise<void> | void) {
  try {
    await action();
    figma.ui.postMessage({
      type: "import-ack",
      requestId: message.requestId,
      transferId: message.transferId,
      success: true
    });
  } catch (error) {
    console.error("Import request failed:", error);
    if (typeof message.type === "string" && message.type.indexOf("import-") === 0) {
      state.importInProgress = false;
      activeImportSession = null;
      clearPendingImportAssets();
      clearPendingImportPages();
    }
    figma.ui.postMessage({
      type: "import-ack",
      requestId: message.requestId,
      transferId: message.transferId,
      success: false,
      error: error instanceof Error ? error.message : "导入失败，请查看控制台"
    });
  }
}

async function startImportSession(message: any) {
  if (state.importInProgress) throw new Error("已有导入任务正在运行");
  await ensureLayerRulesLoaded();
  if (!hasValidLayerRules()) throw new Error("请先导入有效的图层转换规则 JSON");

  const manifest = message.manifest as ImportManifest;
  if (!manifest || manifest.schema !== "mastergo2figma.package.v2" || manifest.version !== 2) {
    throw new Error("当前只支持 v2 导出包，请用新版 SendToFigma 重新导出。");
  }

  const totalNodes = Number(message.totalNodes || manifest.stats?.layerCount || 0);
  const totalPages = Number(message.totalPages || manifest.pages?.length || 0);
  if (totalNodes <= 0 || totalPages <= 0) throw new Error("所选页面没有可还原的图层");

  state.importInProgress = true;
  state.reset();
  state.resetRestoreRuntimeStats(totalNodes, totalPages);
  clearPendingImportAssets();
  clearPendingImportPages();
  activeImportSession = {
    transferId: String(message.transferId || ""),
    manifest,
    totalPages,
    totalNodes,
    restoredNodes: 0,
    postProcessedNodes: 0,
    restoredPages: [],
    previousCurrentPage: figma.currentPage
  };

  figma.ui.postMessage({
    type: "progress",
    transferId: activeImportSession.transferId,
    stage: "restore",
    current: 0,
    total: totalNodes,
    label: "正在接收导入数据..."
  });
}

function startImportAsset(message: any) {
  const session = requireImportSession(message.transferId);
  const path = String(message.path || "");
  if (!path) throw new Error("图片资源缺少路径");
  pendingImportAssets[path] = {
    path,
    keys: Array.isArray(message.keys) ? message.keys.filter((key: any) => typeof key === "string") : [],
    size: Number(message.size || 0),
    chunks: []
  };
  void session;
}

function appendImportAssetChunk(message: any) {
  if (!activeImportSession || activeImportSession.transferId !== message.transferId) return;
  const path = String(message.path || "");
  const pending = pendingImportAssets[path];
  if (!pending) return;
  const bytes = normalizeBytes(message.bytes);
  if (bytes) pending.chunks.push(bytes);
}

function finishImportAsset(message: any) {
  requireImportSession(message.transferId);
  const path = String(message.path || "");
  const pending = pendingImportAssets[path];
  if (!pending) throw new Error(`图片资源传输不存在：${path}`);

  const bytes = concatBytes(pending.chunks, pending.size);
  try {
    const image = figma.createImage(bytes);
    for (const key of pending.keys) state.imageHashByAssetName[key] = image.hash;
    if (pending.keys.length === 0) state.imageHashByAssetName[path] = image.hash;
  } catch (error) {
    console.warn("Unable to create Figma image from streamed asset:", path, error);
    for (const key of pending.keys.length > 0 ? pending.keys : [path]) recordStreamedMissingImage(key);
  }

  delete pendingImportAssets[path];
}

function startImportPage(message: any) {
  requireImportSession(message.transferId);
  const pageIndex = Number(message.pageIndex || 0);
  const importPage = message.page as ImportPageIndex;
  if (!importPage || !Array.isArray(importPage.rootNodeIds)) throw new Error("页面导入数据不完整");
  pendingImportPages[String(pageIndex)] = {
    pageIndex,
    page: importPage,
    layers: {},
    recordCount: 0
  };
}

function appendImportPageChunk(message: any) {
  if (!activeImportSession || activeImportSession.transferId !== message.transferId) return;
  const pageIndex = String(Number(message.pageIndex || 0));
  const pending = pendingImportPages[pageIndex];
  if (!pending || !Array.isArray(message.records)) return;
  for (const record of message.records as ImportLayerRecord[]) {
    if (record && record.id) {
      pending.layers[record.id] = record;
      pending.recordCount++;
    }
  }
}

async function finishImportPage(message: any) {
  requireImportSession(message.transferId);
  const pageIndex = Number(message.pageIndex || 0);
  const pendingKey = String(pageIndex);
  const pending = pendingImportPages[pendingKey];
  if (!pending) throw new Error(`页面传输不存在：${pendingKey}`);
  try {
    await restoreImportPageData(pending.page, pending.layers, pageIndex);
  } finally {
    delete pendingImportPages[pendingKey];
  }
}

async function restoreImportSessionPage(message: any) {
  requireImportSession(message.transferId);
  const importPage = message.page as ImportPageIndex;
  const layers = message.layers as { [id: string]: ImportLayerRecord };
  if (!importPage || !Array.isArray(importPage.rootNodeIds) || !layers || typeof layers !== "object") {
    throw new Error("页面导入数据不完整");
  }
  await restoreImportPageData(importPage, layers, Number(message.pageIndex || 0));
}

async function restoreImportPageData(importPage: ImportPageIndex, layers: { [id: string]: ImportLayerRecord }, pageIndex = 0) {
  if (!activeImportSession) throw new Error("导入会话不存在或已重置");
  const session = activeImportSession;
  const pageName = createRestoredPageName(importPage.name);
  const pageNodeCount = countLayerRecords(layers);
  const postprocessStart = session.postProcessedNodes;
  logImportStage("page-start", "开始还原页面", { pageIndex, pageName, restoredNodes: session.restoredNodes, pageNodeCount });
  figma.ui.postMessage({
    type: "progress",
    transferId: session.transferId,
    stage: "restore",
    pageIndex,
    current: session.restoredNodes,
    total: session.totalNodes,
    label: "正在创建页面：" + pageName
  });

  const restoredPage = figma.createPage();
  restoredPage.name = pageName;
  session.restoredPages.push(restoredPage);
  figma.currentPage = restoredPage;

  for (let rootIndex = 0; rootIndex < importPage.rootNodeIds.length; rootIndex++) {
    const rootId = importPage.rootNodeIds[rootIndex];
    session.restoredNodes += await restoreImportedNode(rootId, restoredPage, layers, session.restoredNodes, session.totalNodes);
  }

  await reportPagePostprocessProgress(session, pageIndex, pageName, postprocessStart, pageNodeCount, 0, 0, 1, "正在应用自动布局...");
  await applyDeferredLayoutRestores((done, total, label) => {
    return reportPagePostprocessProgress(session, pageIndex, pageName, postprocessStart, pageNodeCount, 0, done, total, label);
  });
  await cleanupImportedContainerShells(restoredPage, (done, total, label) => {
    return reportPagePostprocessProgress(session, pageIndex, pageName, postprocessStart, pageNodeCount, 1, done, total, label);
  });
  await applyDeferredSingleChildAutoSpaceAlignmentFixes(restoredPage, (done, total, label) => {
    return reportPagePostprocessProgress(session, pageIndex, pageName, postprocessStart, pageNodeCount, 2, done, total, label);
  });
  session.postProcessedNodes = Math.min(session.totalNodes, postprocessStart + pageNodeCount);
  await reportPagePostprocessProgress(session, pageIndex, pageName, postprocessStart, pageNodeCount, PAGE_POSTPROCESS_STAGE_COUNT - 1, 1, 1, "页面完成：" + pageName);
  logImportStage("page-complete", "页面还原完成", { pageIndex, pageName, restoredNodes: session.restoredNodes, postProcessedNodes: session.postProcessedNodes });
  await yieldToEventLoop();
}

function countLayerRecords(layers: { [id: string]: ImportLayerRecord }): number {
  return layers && typeof layers === "object" ? Object.keys(layers).length : 0;
}

async function reportPagePostprocessProgress(
  session: ImportSession,
  pageIndex: number,
  pageName: string,
  pagePostprocessStart: number,
  pageNodeCount: number,
  stageIndex: number,
  done: number,
  total: number,
  label: string
) {
  const stageRatio = total > 0 ? Math.max(0, Math.min(1, done / total)) : 1;
  const completedRatio = Math.max(0, Math.min(1, (stageIndex + stageRatio) / PAGE_POSTPROCESS_STAGE_COUNT));
  const postprocessCurrent = Math.min(session.totalNodes, pagePostprocessStart + pageNodeCount * completedRatio);
  figma.ui.postMessage({
    type: "progress",
    transferId: session.transferId,
    stage: "postprocess",
    pageIndex,
    current: session.restoredNodes,
    total: session.totalNodes,
    postprocessCurrent,
    postprocessTotal: session.totalNodes,
    label
  });
  logImportStage("postprocess", label, {
    pageIndex,
    pageName,
    done,
    total,
    postprocessCurrent,
    postprocessTotal: session.totalNodes,
    restoredNodes: session.restoredNodes
  });
}

function logImportStage(stage: string, label: string, detail: { [key: string]: any } = {}) {
  const session = activeImportSession;
  console.log("[MasterGo2Figma] Import progress", {
    transferId: session ? session.transferId : "",
    stage,
    label,
    elapsedMs: state.activeRestoreStats ? Date.now() - state.activeRestoreStats.startedAt : 0,
    ...detail
  });
}

async function completeImportSession(message: any) {
  const session = requireImportSession(message.transferId);
  try {
    postFinalizeProgress(session, 0, 4, "正在恢复连接线...");
    applyDeferredConnectorRestores();
    postFinalizeProgress(session, 1, 4, "正在还原缺失字体...");
    const missingFontRestoreResult = await restoreMissingFontTextLayers(session.restoredPages);
    postFinalizeProgress(session, 2, 4, "正在完成还原...");

    if (session.restoredPages.length > 0) {
      figma.currentPage = session.restoredPages[0];
      figma.viewport.scrollAndZoomIntoView(session.restoredPages[0].children as SceneNode[]);
    }
    postFinalizeProgress(session, 4, 4, "正在完成还原...");

    figma.ui.postMessage({
      type: "complete",
      transferId: session.transferId,
      pageCount: session.restoredPages.length,
      layerCount: session.restoredNodes,
      missingImageAssetCount: state.missingImageAssetCount,
      fallbackConnectorCount: state.fallbackConnectorCount,
      restoredMissingFontTextNodeCount: missingFontRestoreResult.restoredTextNodeCount,
      failedMissingFontTextNodeCount: missingFontRestoreResult.failedTextNodeCount
    });

    state.logRestorePerformanceSummary(session.restoredNodes, session.restoredPages.length);
    figma.notify("Restore complete!");
  } catch (error) {
    figma.currentPage = session.previousCurrentPage;
    console.error("Import failed:", error);
    figma.ui.postMessage({
      type: "error",
      transferId: session.transferId,
      message: error instanceof Error ? error.message : "导入失败，请查看控制台"
    });
  } finally {
    state.importInProgress = false;
    activeImportSession = null;
    clearPendingImportAssets();
    clearPendingImportPages();
  }
}

function postFinalizeProgress(session: ImportSession, current: number, total: number, label: string) {
  figma.ui.postMessage({
    type: "progress",
    transferId: session.transferId,
    stage: "finalize",
    current,
    total,
    finalizeCurrent: current,
    finalizeTotal: total,
    label
  });
  logImportStage("finalize", label, { current, total, restoredNodes: session.restoredNodes });
}

function requireImportSession(transferId: string): ImportSession {
  if (!activeImportSession || activeImportSession.transferId !== transferId) {
    throw new Error("导入会话不存在或已重置");
  }
  return activeImportSession;
}

function concatBytes(chunks: Uint8Array[], expectedSize: number): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (expectedSize > 0 && size !== expectedSize) {
    throw new Error(`图片资源传输不完整：expected=${expectedSize}, actual=${size}`);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function clearPendingImportAssets() {
  for (const path in pendingImportAssets) delete pendingImportAssets[path];
}

function clearPendingImportPages() {
  for (const pageIndex in pendingImportPages) delete pendingImportPages[pageIndex];
}

function recordStreamedMissingImage(assetName: string) {
  if (state.missingImageAssetNames[assetName]) return;
  state.missingImageAssetNames[assetName] = true;
  state.missingImageAssetCount++;
}

async function postInitUI() {
  await ensureLayerRulesLoaded();
  figma.ui.postMessage({
    type: "init",
    rules: getLayerRuleStatus()
  });
}

function normalizeImportAssets(assets: { [fileName: string]: Uint8Array }): { [fileName: string]: Uint8Array } {
  const result: { [fileName: string]: Uint8Array } = {};
  if (!assets || typeof assets !== "object") return result;

  for (const fileName in assets) {
    const bytes = normalizeBytes(assets[fileName]);
    if (bytes) result[fileName] = bytes;
  }
  return result;
}

function normalizeBytes(value: any): Uint8Array | null {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return new Uint8Array(value);
  if (typeof value.length === "number") return new Uint8Array(value);
  if (typeof value === "object") {
    const keys = Object.keys(value).filter(key => /^\d+$/.test(key));
    if (keys.length > 0) {
      const bytes = new Uint8Array(keys.length);
      keys.sort((a, b) => Number(a) - Number(b));
      for (let index = 0; index < keys.length; index++) {
        bytes[index] = Number(value[keys[index]]) || 0;
      }
      return bytes;
    }
  }
  return null;
}

function createRestoredPageName(name: string): string {
  return name || "Imported Page";
}

async function maybeReportRestoreProgress(current: number, total: number, label: string, force = false) {
  const now = Date.now();
  const progState = state.activeProgressState || {
    total,
    lastCurrent: 0,
    lastPostedAt: 0
  };
  const shouldPost = force ||
    current >= total ||
    current - progState.lastCurrent >= RESTORE_PROGRESS_NODE_INTERVAL ||
    now - progState.lastPostedAt >= RESTORE_PROGRESS_TIME_INTERVAL_MS;

  if (!shouldPost) return;

  figma.ui.postMessage({
    type: "progress",
    transferId: activeImportSession ? activeImportSession.transferId : undefined,
    stage: "restore",
    current,
    total,
    label
  });
  logImportStage("restore", label, { current, total });
  progState.total = total;
  progState.lastCurrent = current;
  progState.lastPostedAt = now;
  state.activeProgressState = progState;
  await yieldToEventLoop();
}

async function restoreImportPayload(payload: ImportPayload) {
  await ensureLayerRulesLoaded();
  if (!hasValidLayerRules()) throw new Error("请先导入有效的图层转换规则 JSON");

  if (!payload || !payload.manifest || !payload.pages || !payload.layers) {
    throw new Error("导入数据不完整");
  }
  if (payload.manifest.schema !== "mastergo2figma.package.v2" || payload.manifest.version !== 2) {
    throw new Error("当前只支持 v2 导出包，请用新版 SendToFigma 重新导出。");
  }

  state.reset();
  state.activeImportAssets = normalizeImportAssets(payload.assets || {});

  let totalNodes = 0;
  for (const page of payload.pages) totalNodes += page.layerCount || 0;
  if (totalNodes === 0) throw new Error("所选页面没有可还原的图层");

  state.resetRestoreRuntimeStats(totalNodes, payload.pages.length);

  const previousCurrentPage = figma.currentPage;
  let restoredNodes = 0;
  const restoredPages: PageNode[] = [];

  try {
    figma.ui.postMessage({
      type: "progress",
      stage: "restore",
      current: 0,
      total: totalNodes,
      label: "正在创建 Figma 页面..."
    });

    for (let pageIndex = 0; pageIndex < payload.pages.length; pageIndex++) {
      const importPage = payload.pages[pageIndex];
      const restoredPage = figma.createPage();
      restoredPage.name = createRestoredPageName(importPage.name);
      restoredPages.push(restoredPage);
      figma.currentPage = restoredPage;

      for (let rootIndex = 0; rootIndex < importPage.rootNodeIds.length; rootIndex++) {
        const rootId = importPage.rootNodeIds[rootIndex];
        restoredNodes += await restoreImportedNode(rootId, restoredPage, payload.layers, restoredNodes, totalNodes);
      }

      await applyDeferredLayoutRestores();
      await cleanupImportedContainerShells(restoredPage);
      await applyDeferredSingleChildAutoSpaceAlignmentFixes(restoredPage);
    }
  } catch (error) {
    figma.currentPage = previousCurrentPage;
    throw error;
  }

  applyDeferredConnectorRestores();
  await maybeReportRestoreProgress(restoredNodes, totalNodes, "正在还原缺失字体...", true);
  const missingFontRestoreResult = await restoreMissingFontTextLayers(restoredPages);
  await maybeReportRestoreProgress(restoredNodes, totalNodes, "正在完成还原...", true);

  if (restoredPages.length > 0) {
    figma.currentPage = restoredPages[0];
    figma.viewport.scrollAndZoomIntoView(restoredPages[0].children as SceneNode[]);
  }

  figma.ui.postMessage({
    type: "complete",
    pageCount: restoredPages.length,
    layerCount: restoredNodes,
    missingImageAssetCount: state.missingImageAssetCount,
    fallbackConnectorCount: state.fallbackConnectorCount,
    restoredMissingFontTextNodeCount: missingFontRestoreResult.restoredTextNodeCount,
    failedMissingFontTextNodeCount: missingFontRestoreResult.failedTextNodeCount
  });

  const completeDetails: string[] = [];
  if (state.missingImageAssetCount > 0) {
    completeDetails.push(`Missing images: ${state.missingImageAssetCount}`);
  }
  if (state.fallbackConnectorCount > 0) {
    completeDetails.push(`Connectors restored as polylines: ${state.fallbackConnectorCount}`);
  }
  if (missingFontRestoreResult.restoredTextNodeCount > 0) {
    completeDetails.push(`Fonts restored: ${missingFontRestoreResult.restoredTextNodeCount}`);
  }
  if (missingFontRestoreResult.failedTextNodeCount > 0) {
    completeDetails.push(`Fonts still missing: ${missingFontRestoreResult.failedTextNodeCount}`);
  }
  state.logRestorePerformanceSummary(restoredNodes, restoredPages.length);
  figma.notify(completeDetails.length > 0 ? `Restore complete. ${completeDetails.join("; ")}` : "Restore complete!");
}

function applyManifestLayoutToProps(props: any, _meta: ImportLayerRecord): any {
  return props;
}

function isConnectorRestoreData(data: any): boolean {
  return !!data && (data.sourceType === "CONNECTOR" || data.type === "CONNECTOR" || data.restoreType === "CONNECTOR");
}

function prepareConnectorPolylineFallbackProps(data: any, parent: PageNode | SceneNode): any {
  if (!isConnectorRestoreData(data)) return data;

  const props = { ...data };
  props.connectorFallbackPolyline = true;
  if (!hasUsableVectorNetwork(props.vectorNetwork)) {
    props.vectorNetwork = createConnectorVectorNetworkFromData(props, parent);
  }
  return props;
}

function shouldPreserveVectorLayoutBoxForAutoLayout(data: any, parent: PageNode | SceneNode): boolean {
  if (!data || !data.vectorNetwork) return false;
  const sourceType = data.sourceType || data.type;
  if (sourceType !== "PEN" && sourceType !== "VECTOR") return false;
  if (!parent || !("id" in parent)) return false;
  const restoredParentLayout = state.restoredLayoutByNodeId[(parent as SceneNode).id];
  const parentLayoutMode = restoredParentLayout && restoredParentLayout.layoutMode;
  if (parentLayoutMode && parentLayoutMode !== "NONE") return true;
  return "layoutMode" in parent && (parent as any).layoutMode !== "NONE";
}

function markVectorAutoLayoutBox(data: any): any {
  return {
    ...data,
    vectorAutoLayoutBox: true
  };
}

async function restoreImportedNode(
  nodeId: string,
  parent: PageNode | SceneNode,
  layers: { [id: string]: ImportLayerRecord },
  restoredBefore: number,
  totalNodes: number
): Promise<number> {
  const layerRecord = layers[nodeId];
  if (!layerRecord || !layerRecord.props) {
    console.warn("Missing layer record:", nodeId);
    return 0;
  }

  let nodeProps = applyManifestLayoutToProps(layerRecord.props, layerRecord);
  if (shouldRestoreBooleanOperationTree(nodeProps, layerRecord)) {
    return await restoreBooleanOperationTree(
      nodeProps,
      parent,
      layerRecord,
      layers,
      restoredBefore,
      totalNodes,
      restoreImportedNode,
      applyProperties,
      maybeReportRestoreProgress
    );
  }

  if (shouldRestoreGroupNode(nodeProps)) {
    return await restoreGroupNode(
      nodeProps,
      parent,
      layerRecord,
      layers,
      restoredBefore,
      totalNodes,
      restoreImportedNode,
      applyProperties,
      maybeReportRestoreProgress
    );
  }

  if (shouldRestoreComponentSetNode(nodeProps)) {
    return await restoreComponentSetNode(
      nodeProps,
      parent,
      layerRecord,
      layers,
      restoredBefore,
      totalNodes,
      restoreImportedNode,
      applyProperties,
      maybeReportRestoreProgress
    );
  }

  if (shouldRestoreBooleanVectorAsFrame(nodeProps, layerRecord)) {
    nodeProps = createBooleanFrameFallbackProps(nodeProps);
  }
  nodeProps = prepareConnectorPolylineFallbackProps(nodeProps, parent);
  if (shouldPreserveVectorLayoutBoxForAutoLayout(nodeProps, parent)) {
    nodeProps = markVectorAutoLayoutBox(nodeProps);
  }

  const newNode = await createNodeFromData(nodeProps);
  if (!newNode) return 0;

  try {
    if (!appendRestoredNode(parent, newNode)) return 0;
    await applyProperties(newNode as any, nodeProps);
  } catch (error) {
    console.warn("Unable to restore node, removing partial node:", nodeProps?.name || layerRecord.name || nodeId, error);
    safeRemove(newNode);
    return 0;
  }

  let restoredCount = 1;
  const currentCount = restoredBefore + restoredCount;
  await maybeReportRestoreProgress(currentCount, totalNodes, "正在还原：" + (nodeProps.name || layerRecord.name));

  const childIds = nodeProps.omitChildrenOnRestore ? [] : (layerRecord.childIds || []);
  if (canContainRestoredChildren(newNode)) {
    for (const childId of childIds) {
      restoredCount += await restoreImportedNode(childId, newNode, layers, restoredBefore + restoredCount, totalNodes);
    }
  }

  return restoredCount;
}

function canContainRestoredChildren(node: SceneNode): boolean {
  return !!node && "appendChild" in node;
}
