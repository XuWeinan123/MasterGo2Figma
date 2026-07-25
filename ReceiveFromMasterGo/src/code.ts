import { ImportLayerRecord, ImportManifest, ImportPageIndex, MissingFontTextRestoreResult } from "../../shared/types";
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
import { loadFontCached, refreshAvailableFonts } from "./fontLoader";
import {
  cleanupImportedContainerShells, createNodeFromData,
  appendRestoredNode, safeRemove, hasUsableVectorNetwork
} from "./nodeCreator";
import { applyProperties } from "./propertyApplier";
import { safeSetFills, safeSetStrokes } from "./appliers/universal";
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
  timings: { [phase: string]: number };
  timingCounts: { [phase: string]: number };
  clientTimings: any;
  // record id → restored node, for component/instance re-linking (native .mg
  // imports carry mainComponentId on instance records)
  restoredNodeById: { [id: string]: SceneNode };
  // Instance records whose component wasn't restored yet when they were
  // reached (use-before-definition INSIDE one page root — the root-level topo
  // sort can't reorder those). They restore as frame shells first and get
  // swapped for real instances after the page finishes.
  deferredInstanceRelinks: { id: string; node: SceneNode }[];
  // library style ref (prefixed .mg style record id) → created Figma style id
  // (native .mg imports ship a styles.json payload; records reference styles
  // via fillStyleRef/strokeStyleRef/effectStyleRef/textStyleRef)
  figmaStyleIdByRef: { [ref: string]: string };
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
  error?: string;
};

let activeImportSession: ImportSession | null = null;
const pendingImportAssets: { [path: string]: PendingAsset } = {};
const pendingImportPages: { [pageIndex: string]: PendingPage } = {};

showImportUI();

function showImportUI() {
  ensureLayerRulesLoaded();
  figma.showUI(__html__, { width: 400, height: 620 });
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

    if (message.type === "import-styles") {
      await handleImportRequest(message, () => importSessionStyles(message));
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

    if (message.type === "import-session-complete") {
      await completeImportSession(message);
      return;
    }

    if (message.type === "refresh-fonts") {
      await refreshMissingFontsInDocument();
      return;
    }

    if (message.type === "import-client-timing") {
      recordClientTiming(message);
      return;
    }

    if (message.type === "start-import") {
      figma.ui.postMessage({
        type: "error",
        message: "当前测试版只支持 session/chunk 流式导入"
      });
      return;
    }
  };
}

async function refreshMissingFontsInDocument() {
  try {
    await ensureLayerRulesLoaded();
    if (!hasValidLayerRules()) throw new Error("请先导入有效的图层转换规则 JSON");

    await refreshAvailableFonts();
    const pages = figma.root.children.filter(node => node.type === "PAGE") as PageNode[];
    const missingFontRestoreResult = await restoreMissingFontTextLayers(pages);
    logMissingFontRefreshDiagnostics(missingFontRestoreResult);
    figma.ui.postMessage({
      type: "refresh-fonts-complete",
      scannedTextNodeCount: missingFontRestoreResult.scannedTextNodeCount,
      candidateTextNodeCount: missingFontRestoreResult.candidateTextNodeCount,
      manuallyResolvedTextNodeCount: missingFontRestoreResult.manuallyResolvedTextNodeCount,
      restoredTextNodeCount: missingFontRestoreResult.restoredTextNodeCount,
      failedTextNodeCount: missingFontRestoreResult.failedTextNodeCount,
      missingFonts: missingFontRestoreResult.missingFonts
    });
    const details: string[] = [];
    if (missingFontRestoreResult.manuallyResolvedTextNodeCount) {
      details.push(`${missingFontRestoreResult.manuallyResolvedTextNodeCount} manually resolved`);
    }
    if (missingFontRestoreResult.restoredTextNodeCount) {
      details.push(`${missingFontRestoreResult.restoredTextNodeCount} restored`);
    }
    if (missingFontRestoreResult.failedTextNodeCount) {
      details.push(`${missingFontRestoreResult.failedTextNodeCount} still missing`);
    }
    figma.notify(details.length > 0 ? `Font refresh complete. ${details.join("; ")}` : "Font refresh complete.");
  } catch (error) {
    console.error("Refresh fonts failed:", error);
    figma.ui.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "刷新字体失败，请查看控制台"
    });
  }
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
      await rollbackImportSession(activeImportSession);
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
    previousCurrentPage: figma.currentPage,
    timings: {},
    timingCounts: {},
    clientTimings: message.clientTimings || null,
    restoredNodeById: {},
    deferredInstanceRelinks: [],
    figmaStyleIdByRef: {}
  };

  figma.ui.postMessage({
    type: "progress",
    transferId: activeImportSession.transferId,
    stage: "restore",
    current: 0,
    total: totalNodes
  });
}

// Recreate the .mg package's library styles as local Figma styles. Values
// were materialized inline by the converter, so a failed style creation only
// loses the BINDING, never the visual. Effect blendMode arrives normalized to
// PASS_THROUGH (layer semantics) — Figma effects only accept NORMAL there.
async function importSessionStyles(message: any): Promise<void> {
  const session = requireImportSession(message.transferId);
  const styles = Array.isArray(message.styles) ? message.styles : [];
  let created = 0;
  for (const style of styles) {
    if (!style || typeof style.id !== "string" || !style.name) continue;
    try {
      if (style.styleType === "PAINT" && Array.isArray(style.paints) && style.paints.length > 0) {
        const paintStyle = figma.createPaintStyle();
        paintStyle.name = String(style.name);
        try {
          paintStyle.paints = sanitizeStylePaints(style.paints);
        } catch (error) {
          paintStyle.remove();
          throw error;
        }
        session.figmaStyleIdByRef[style.id] = paintStyle.id;
      } else if (style.styleType === "EFFECT" && Array.isArray(style.effects) && style.effects.length > 0) {
        const effectStyle = figma.createEffectStyle();
        effectStyle.name = String(style.name);
        try {
          effectStyle.effects = style.effects.map((effect: any) => {
            const clone = { ...effect };
            if (clone.blendMode === "PASS_THROUGH") clone.blendMode = "NORMAL";
            return clone;
          });
        } catch (error) {
          effectStyle.remove();
          throw error;
        }
        session.figmaStyleIdByRef[style.id] = effectStyle.id;
      } else if (style.styleType === "TEXT" && style.fontName) {
        const fontName = { family: String(style.fontName.family || "Inter"), style: String(style.fontName.style || "Regular") };
        await loadFontCached(fontName);
        const textStyle = figma.createTextStyle();
        textStyle.name = String(style.name);
        try {
          textStyle.fontName = fontName;
          if (typeof style.fontSize === "number" && style.fontSize > 0) textStyle.fontSize = style.fontSize;
          if (style.lineHeight && style.lineHeight.unit === "PIXELS" && typeof style.lineHeight.value === "number") {
            textStyle.lineHeight = { unit: "PIXELS", value: style.lineHeight.value };
          } else {
            textStyle.lineHeight = { unit: "AUTO" };
          }
          if (style.letterSpacing && typeof style.letterSpacing.value === "number") {
            textStyle.letterSpacing = {
              unit: style.letterSpacing.unit === "PIXELS" ? "PIXELS" : "PERCENT",
              value: style.letterSpacing.value
            };
          }
          if (style.textCase && style.textCase !== "ORIGINAL") textStyle.textCase = style.textCase;
          if (style.textDecoration && style.textDecoration !== "NONE") textStyle.textDecoration = style.textDecoration;
        } catch (error) {
          textStyle.remove();
          throw error;
        }
        session.figmaStyleIdByRef[style.id] = textStyle.id;
      } else {
        continue;
      }
      created++;
    } catch (error) {
      console.warn("[mg-style] 样式创建失败(跳过):", style && style.name, error);
    }
  }
  console.info("[mg-style] created", created, "/", styles.length, "library styles");
}

// Solid/gradient paints from styles.json map 1:1 onto Figma Paint minus the
// exporter-only fields; anything unrecognized is dropped (a style with zero
// valid paints is skipped by the caller's try/catch via the setter throwing).
function sanitizeStylePaints(paints: any[]): Paint[] {
  const out: Paint[] = [];
  for (const paint of paints) {
    if (!paint || typeof paint !== "object") continue;
    const visible = paint.visible !== false;
    const opacity = typeof paint.opacity === "number" ? paint.opacity : 1;
    if (paint.type === "SOLID" && paint.color) {
      out.push({ type: "SOLID", visible, opacity, color: { r: paint.color.r || 0, g: paint.color.g || 0, b: paint.color.b || 0 } });
      continue;
    }
    if (typeof paint.type === "string" && paint.type.indexOf("GRADIENT_") === 0 && Array.isArray(paint.gradientStops)) {
      out.push({
        type: paint.type,
        visible,
        opacity,
        gradientTransform: Array.isArray(paint.gradientTransform) ? paint.gradientTransform : [[1, 0, 0], [0, 1, 0]],
        gradientStops: paint.gradientStops.map((stop: any) => ({
          position: stop.position || 0,
          color: { r: stop.color?.r || 0, g: stop.color?.g || 0, b: stop.color?.b || 0, a: stop.color?.a === undefined ? 1 : stop.color.a }
        }))
      } as Paint);
      continue;
    }
  }
  return out;
}

// Re-bind restored nodes to the recreated library styles. Runs AFTER
// applyProperties: the raw values are already applied, so binding only
// attaches the style reference (mutating a bound property later would detach
// it — nothing in the pipeline mutates these afterwards except deferred
// layout, which touches geometry only).
async function applyImportedStyleBindings(node: SceneNode, layerRecord: ImportLayerRecord): Promise<void> {
  const session = activeImportSession;
  if (!session) return;
  const map = session.figmaStyleIdByRef;
  const fillRef = (layerRecord as any).fillStyleRef;
  const strokeRef = (layerRecord as any).strokeStyleRef;
  const effectRef = (layerRecord as any).effectStyleRef;
  const textRef = (layerRecord as any).textStyleRef;
  if (!fillRef && !strokeRef && !effectRef && !textRef) return;
  try {
    if (fillRef && map[fillRef] && "setFillStyleIdAsync" in node) await (node as any).setFillStyleIdAsync(map[fillRef]);
  } catch (error) { /* binding is cosmetic — values already applied */ }
  try {
    if (strokeRef && map[strokeRef] && "setStrokeStyleIdAsync" in node) await (node as any).setStrokeStyleIdAsync(map[strokeRef]);
  } catch (error) { /* ignore */ }
  try {
    if (effectRef && map[effectRef] && "setEffectStyleIdAsync" in node) await (node as any).setEffectStyleIdAsync(map[effectRef]);
  } catch (error) { /* ignore */ }
  try {
    if (textRef && map[textRef] && node.type === "TEXT" && "setTextStyleIdAsync" in node) {
      await (node as any).setTextStyleIdAsync(map[textRef]);
    }
  } catch (error) { /* ignore */ }
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
  const session = requireImportSession(message.transferId);
  const path = String(message.path || "");
  const pending = pendingImportAssets[path];
  if (!pending) throw new Error(`图片资源传输不存在：${path}`);

  const concatStartedAt = Date.now();
  const bytes = concatBytes(pending.chunks, pending.size);
  addImportTiming(session, "asset.concatBytesMs", Date.now() - concatStartedAt);
  try {
    const imageStartedAt = Date.now();
    const image = figma.createImage(bytes);
    addImportTiming(session, "asset.createImageMs", Date.now() - imageStartedAt);
    addImportTimingCount(session, "asset.createImageCount", 1);
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
    recordCount: 0,
    error: undefined
  };
}

function appendImportPageChunk(message: any) {
  if (!activeImportSession || activeImportSession.transferId !== message.transferId) return;
  const startedAt = Date.now();
  const pageIndex = String(Number(message.pageIndex || 0));
  const pending = pendingImportPages[pageIndex];
  if (!pending || !Array.isArray(message.records)) return;
  for (const record of message.records as ImportLayerRecord[]) {
    if (record && record.id) {
      if (pending.layers[record.id]) {
        pending.error = `页面分块包含重复图层：${record.id}`;
        continue;
      }
      pending.layers[record.id] = record;
      pending.recordCount++;
    }
  }
  addImportTiming(activeImportSession, "page.receiveChunkMs", Date.now() - startedAt);
  addImportTimingCount(activeImportSession, "page.receiveChunkCount", 1);
}

async function finishImportPage(message: any) {
  const session = requireImportSession(message.transferId);
  const pageIndex = Number(message.pageIndex || 0);
  const pendingKey = String(pageIndex);
  const pending = pendingImportPages[pendingKey];
  if (!pending) throw new Error(`页面传输不存在：${pendingKey}`);
  try {
    if (pending.error) throw new Error(pending.error);
    const expectedCount = Number(pending.page.layerCount || 0);
    if (expectedCount > 0 && Object.keys(pending.layers).length !== expectedCount) {
      throw new Error(`页面图层数量不一致：expected=${expectedCount}, actual=${Object.keys(pending.layers).length}`);
    }
    addImportTimingCount(session, "page.receivedRecordCount", pending.recordCount);
    await restoreImportPageData(pending.page, pending.layers, pageIndex);
  } finally {
    delete pendingImportPages[pendingKey];
  }
}

async function restoreImportPageData(importPage: ImportPageIndex, layers: { [id: string]: ImportLayerRecord }, pageIndex = 0) {
  if (!activeImportSession) throw new Error("导入会话不存在或已重置");
  const session = activeImportSession;
  const pageName = createRestoredPageName(importPage.name);
  const pageNodeCount = countLayerRecords(layers);
  if (importPage.layerCount !== undefined && pageNodeCount !== Number(importPage.layerCount)) {
    throw new Error(`页面记录数量不一致：expected=${importPage.layerCount}, actual=${pageNodeCount}`);
  }
  const postprocessStart = session.postProcessedNodes;
  figma.ui.postMessage({
    type: "progress",
    transferId: session.transferId,
    stage: "restore",
    pageIndex,
    current: session.restoredNodes,
    total: session.totalNodes
  });

  const pageCreateStartedAt = Date.now();
  const restoredPage = figma.createPage();
  restoredPage.name = pageName;
  if (importPage.background) {
    const bg = importPage.background;
    try {
      restoredPage.backgrounds = [{ type: "SOLID", color: { r: bg.r, g: bg.g, b: bg.b }, opacity: bg.a }];
    } catch (error) {
      // keep the default canvas color if the runtime rejects the paint
    }
  }
  session.restoredPages.push(restoredPage);
  await figma.setCurrentPageAsync(restoredPage);
  addImportTiming(session, "restore.createPageMs", Date.now() - pageCreateStartedAt);

  const nodeRestoreStartedAt = Date.now();
  let restoredOnPage = 0;
  // Restore component/component-set roots FIRST so instances elsewhere on the
  // page can re-link to them (native .mg imports carry mainComponentId), then
  // put the page children back into the package's root order.
  const rootIds = importPage.rootNodeIds;
  const isComponentRoot = (id: string) => {
    const record = layers[id];
    const type = record && record.props ? record.props.type : null;
    return type === "COMPONENT" || type === "COMPONENT_SET";
  };
  // Components before instances is not enough: components NEST instances of
  // other components (Tesla: "map" instantiates "en route"). Order roots
  // topologically by mainComponentId dependencies — restoring a dependent
  // first makes createInstance miss and bakes a frame-shell fallback into
  // the component, which every instance of it then clones. Cycles (or deps
  // already satisfied on earlier pages) keep the base order.
  const rootOfRecord: { [id: string]: string } = {};
  for (const rootId of rootIds) {
    const stack = [rootId];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (rootOfRecord[cur] !== undefined) continue;
      rootOfRecord[cur] = rootId;
      const rec = layers[cur];
      for (const cid of (rec && rec.childIds) || []) stack.push(cid);
    }
  }
  const dependsOn: { [rootId: string]: { [dep: string]: true } } = {};
  for (const rootId of rootIds) dependsOn[rootId] = {};
  for (const id in rootOfRecord) {
    const rec = layers[id];
    const target = rec ? rec.mainComponentId : undefined;
    if (!target) continue;
    const fromRoot = rootOfRecord[id];
    const toRoot = rootOfRecord[target];
    if (toRoot !== undefined && toRoot !== fromRoot && dependsOn[fromRoot]) dependsOn[fromRoot][toRoot] = true;
  }
  const baseOrder = [...rootIds.filter(isComponentRoot), ...rootIds.filter(id => !isComponentRoot(id))];
  const restoreOrder: string[] = [];
  const rootVisitState: { [id: string]: number } = {};
  const visitRoot = (rootId: string) => {
    if (rootVisitState[rootId]) return;
    rootVisitState[rootId] = 1;
    for (const dep in dependsOn[rootId]) visitRoot(dep);
    restoreOrder.push(rootId);
  };
  for (const rootId of baseOrder) visitRoot(rootId);
  const restoredRootNodes: { [id: string]: SceneNode } = {};
  for (const rootId of restoreOrder) {
    const childCountBefore = restoredPage.children.length;
    const restored = await restoreImportedNode(rootId, restoredPage, layers, session.restoredNodes, session.totalNodes);
    if (restoredPage.children.length > childCountBefore) {
      restoredRootNodes[rootId] = restoredPage.children[childCountBefore];
    }
    restoredOnPage += restored;
    session.restoredNodes += restored;
  }
  if (restoreOrder.length !== rootIds.length || restoreOrder.some((id, i) => id !== rootIds[i])) {
    try {
      for (let rootIndex = 0; rootIndex < rootIds.length; rootIndex++) {
        const node = restoredRootNodes[rootIds[rootIndex]];
        if (node && !node.removed && node.parent === restoredPage && restoredPage.children[rootIndex] !== node) {
          restoredPage.insertChild(rootIndex, node);
        }
      }
    } catch (error) {
      console.warn("Unable to reorder page roots after component-first restore:", error);
    }
  }
  if (restoredOnPage !== pageNodeCount) throw new Error(`页面还原数量不一致：expected=${pageNodeCount}, actual=${restoredOnPage}`);
  addImportTiming(session, "restore.nodesMs", Date.now() - nodeRestoreStartedAt);
  addImportTimingCount(session, "restore.pageCount", 1);
  // Same-root use-before-definition: every component on the page exists now,
  // so shells that fell back can be swapped for real instances. Runs BEFORE
  // applyDeferredLayoutRestores so layout registrations from the swap are
  // consumed by the pass below.
  const relinkStartedAt = Date.now();
  await retryDeferredInstanceRelinks(layers);
  addImportTiming(session, "restore.deferredRelinkMs", Date.now() - relinkStartedAt);

  await reportPagePostprocessProgress(session, pageIndex, postprocessStart, pageNodeCount, 0, 0, 1);
  const layoutStartedAt = Date.now();
  await applyDeferredLayoutRestores((done, total) => {
    return reportPagePostprocessProgress(session, pageIndex, postprocessStart, pageNodeCount, 0, done, total);
  });
  addImportTiming(session, "postprocess.deferredLayoutMs", Date.now() - layoutStartedAt);
  const cleanupStartedAt = Date.now();
  await cleanupImportedContainerShells(restoredPage, (done, total) => {
    return reportPagePostprocessProgress(session, pageIndex, postprocessStart, pageNodeCount, 1, done, total);
  });
  addImportTiming(session, "postprocess.cleanupShellsMs", Date.now() - cleanupStartedAt);
  const autoSpaceStartedAt = Date.now();
  await applyDeferredSingleChildAutoSpaceAlignmentFixes((done, total) => {
    return reportPagePostprocessProgress(session, pageIndex, postprocessStart, pageNodeCount, 2, done, total);
  });
  addImportTiming(session, "postprocess.singleChildAutoSpaceMs", Date.now() - autoSpaceStartedAt);
  session.postProcessedNodes = Math.min(session.totalNodes, postprocessStart + pageNodeCount);
  await reportPagePostprocessProgress(session, pageIndex, postprocessStart, pageNodeCount, PAGE_POSTPROCESS_STAGE_COUNT - 1, 1, 1);
  // Both maps are strictly page-scoped: every reader (group-offset
  // normalization, vector layout-box checks, deferred layout passes,
  // component-set finalize, SPACE_BETWEEN fixes) runs within this page's
  // restore/postprocess, and Figma node ids never repeat across pages. The
  // session-finalize steps (connectors/fonts) only use restoredNodeIdBySourceId.
  // Releasing them per page keeps multi-page imports from pinning every
  // page's parsed layout objects until the session ends.
  state.restoredLayoutByNodeId = {};
  state.nativeGroupOffsetByNodeId = {};
  await yieldToEventLoop();
}

function countLayerRecords(layers: { [id: string]: ImportLayerRecord }): number {
  return layers && typeof layers === "object" ? Object.keys(layers).length : 0;
}

async function reportPagePostprocessProgress(
  session: ImportSession,
  pageIndex: number,
  pagePostprocessStart: number,
  pageNodeCount: number,
  stageIndex: number,
  done: number,
  total: number
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
    postprocessTotal: session.totalNodes
  });
}

async function completeImportSession(message: any) {
  const session = requireImportSession(message.transferId);
  if (message.clientTimings) session.clientTimings = message.clientTimings;
  try {
    if (session.restoredPages.length !== session.totalPages) {
      throw new Error(`会话页面数量不一致：expected=${session.totalPages}, actual=${session.restoredPages.length}`);
    }
    if (session.restoredNodes !== session.totalNodes) {
      throw new Error(`会话图层数量不一致：expected=${session.totalNodes}, actual=${session.restoredNodes}`);
    }
    postFinalizeProgress(session, 0, 4);
    const connectorStartedAt = Date.now();
    await applyDeferredConnectorRestores();
    addImportTiming(session, "finalize.connectorsMs", Date.now() - connectorStartedAt);
    postFinalizeProgress(session, 1, 4);
    const missingFontStartedAt = Date.now();
    const missingFontRestoreResult = await restoreMissingFontTextLayers(session.restoredPages);
    addImportTiming(session, "finalize.missingFontsMs", Date.now() - missingFontStartedAt);
    postFinalizeProgress(session, 2, 4);

    const viewportStartedAt = Date.now();
    if (session.restoredPages.length > 0) {
      await figma.setCurrentPageAsync(session.restoredPages[0]);
      figma.viewport.scrollAndZoomIntoView(session.restoredPages[0].children as SceneNode[]);
    }
    addImportTiming(session, "finalize.viewportMs", Date.now() - viewportStartedAt);
    postFinalizeProgress(session, 4, 4);

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

    logMissingImportDiagnostics(missingFontRestoreResult);
    state.logRestorePerformanceSummary(session.restoredNodes, session.restoredPages.length);
    logImportPerformanceSummary(session, missingFontRestoreResult);
    figma.notify("Restore complete!");
  } catch (error) {
    await rollbackImportSession(session);
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

function postFinalizeProgress(session: ImportSession, current: number, total: number) {
  figma.ui.postMessage({
    type: "progress",
    transferId: session.transferId,
    stage: "finalize",
    current,
    total,
    finalizeCurrent: current,
    finalizeTotal: total
  });
}

function addImportTiming(session: ImportSession | null, phase: string, ms: number) {
  if (!session || !Number.isFinite(ms)) return;
  session.timings[phase] = (session.timings[phase] || 0) + Math.max(0, Math.round(ms));
  session.timingCounts[phase] = (session.timingCounts[phase] || 0) + 1;
}

function addImportTimingCount(session: ImportSession | null, phase: string, count: number) {
  if (!session || !Number.isFinite(count)) return;
  session.timingCounts[phase] = (session.timingCounts[phase] || 0) + Math.max(0, Math.round(count));
}

function recordClientTiming(message: any) {
  if (!activeImportSession || activeImportSession.transferId !== message.transferId) return;
  activeImportSession.clientTimings = message.clientTimings || activeImportSession.clientTimings;
}

function logImportPerformanceSummary(session: ImportSession, missingFontRestoreResult: any) {
  const durationMs = Math.max(Date.now() - (state.activeRestoreStats?.startedAt || Date.now()), 1);
  const nodesPerSecond = Math.round((session.restoredNodes / durationMs) * 10000) / 10;
  const summary = {
    transferId: session.transferId,
    durationMs,
    nodesPerSecond,
    totalNodes: session.totalNodes,
    restoredNodes: session.restoredNodes,
    pageCount: session.restoredPages.length,
    timingsMs: session.timings,
    timingCounts: session.timingCounts,
    clientTimings: session.clientTimings,
    restoreStats: state.activeRestoreStats,
    missingFonts: missingFontRestoreResult,
    missingImageAssetCount: state.missingImageAssetCount,
    fallbackConnectorCount: state.fallbackConnectorCount,
    booleanFallbackCount: state.booleanFallbackCount
  };
  console.log("[MasterGo2Figma] Import performance detail", summary);
  console.log("[MasterGo2Figma] Import performance detail JSON " + JSON.stringify(summary));
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

async function rollbackImportSession(session: ImportSession | null): Promise<void> {
  if (!session) return;
  for (const page of session.restoredPages) {
    try {
      if (!page.removed) page.remove();
    } catch (error) {
      console.warn("Unable to roll back imported page:", page.name, error);
    }
  }
  try {
    if (session.previousCurrentPage && !session.previousCurrentPage.removed) {
      await figma.setCurrentPageAsync(session.previousCurrentPage);
    }
  } catch (_) {
    // Viewport restoration is best effort in the desktop plugin runtime.
  }
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

async function maybeReportRestoreProgress(current: number, total: number, force = false) {
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
    total
  });
  progState.total = total;
  progState.lastCurrent = current;
  progState.lastPostedAt = now;
  state.activeProgressState = progState;
  await yieldToEventLoop();
}

function logMissingImportDiagnostics(missingFontRestoreResult: MissingFontTextRestoreResult) {
  logMissingFontRefreshDiagnostics(missingFontRestoreResult);

  const missingImageNames = Object.keys(state.missingImageAssetNames).sort();
  if (missingImageNames.length > 0) {
    console.warn("[MasterGo2Figma] 缺失图片资源（去重）", missingImageNames);
  }

  if (state.missingImageAssetDetails.length > 0) {
    console.warn("[MasterGo2Figma] 缺失图片影响图层", state.missingImageAssetDetails.map(detail => ({
      assetName: detail.assetName,
      layerName: detail.nodeName,
      layerPath: detail.layerPath,
      nodeId: detail.nodeId,
      nodeType: detail.nodeType,
      paintTarget: detail.paintTarget,
      x: detail.x,
      y: detail.y,
      width: detail.width,
      height: detail.height
    })));
  } else if (missingImageNames.length > 0) {
    console.warn("[MasterGo2Figma] 缺失图片影响图层未能定位；资源可能在传输阶段创建失败。");
  }
}

function logMissingFontRefreshDiagnostics(missingFontRestoreResult: MissingFontTextRestoreResult) {
  if (missingFontRestoreResult.missingFonts.length > 0) {
    console.warn("[MasterGo2Figma] 缺失字体（去重）", missingFontRestoreResult.missingFonts.map(font => ({
      family: font.family,
      style: font.style,
      textNodeCount: font.count
    })));
    return;
  }
  console.info("[MasterGo2Figma] 缺失字体（去重）", []);
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
    throw new Error(`缺少图层记录：${nodeId}`);
  }

  // Native .mg imports mark instance records with the component's record id.
  // When that component was already restored in this session, recreate a REAL
  // InstanceNode (component.createInstance) instead of a frame shell; any
  // failure falls through to the ordinary restore path below.
  if (layerRecord.mainComponentId) {
    const instanceRestored = await tryRestoreAsInstance(layerRecord, parent, layers, restoredBefore, totalNodes);
    if (instanceRestored > 0) return instanceRestored;
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

  const createStartedAt = Date.now();
  const newNode = await createNodeFromData(nodeProps);
  addImportTiming(activeImportSession, "restore.createNodeMs", Date.now() - createStartedAt);
  if (!newNode) throw new Error(`无法创建图层：${nodeProps?.name || layerRecord.name || nodeId}`);

  try {
    const appendStartedAt = Date.now();
    if (!appendRestoredNode(parent, newNode)) throw new Error(`无法挂载图层：${nodeProps?.name || layerRecord.name || nodeId}`);
    addImportTiming(activeImportSession, "restore.appendNodeMs", Date.now() - appendStartedAt);
    const applyStartedAt = Date.now();
    await applyProperties(newNode as any, nodeProps);
    addImportTiming(activeImportSession, "restore.applyPropertiesMs", Date.now() - applyStartedAt);
  } catch (error) {
    console.warn("Unable to restore node, removing partial node:", nodeProps?.name || layerRecord.name || nodeId, error);
    safeRemove(newNode);
    throw error;
  }
  if (activeImportSession) {
    activeImportSession.restoredNodeById[nodeId] = newNode;
    // Reaching here with a mainComponentId means tryRestoreAsInstance fell
    // back (component not restored yet — same-root use-before-definition).
    // Remember the shell; retryDeferredInstanceRelinks swaps it after the
    // page finishes. Parents register before their children restore, so the
    // relink pass sees outer shells first and inner ones become no-ops.
    if (layerRecord.mainComponentId) {
      activeImportSession.deferredInstanceRelinks.push({ id: nodeId, node: newNode });
    }
  }
  await applyImportedStyleBindings(newNode, layerRecord);

  let restoredCount = 1;
  const currentCount = restoredBefore + restoredCount;
  const progressStartedAt = Date.now();
  await maybeReportRestoreProgress(currentCount, totalNodes);
  addImportTiming(activeImportSession, "restore.progressMs", Date.now() - progressStartedAt);

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

// Recreate an instance record as a REAL InstanceNode when its component was
// already restored in this session. Children come from the component; the
// import records' per-child state is applied as instance OVERRIDES by
// positional matching (record childIds order == component child order — both
// derive from the same sort codes). Returns the number of records this node
// accounts for (itself + all skipped descendant records), or 0 to fall back
// to the ordinary frame-shell restore.
async function tryRestoreAsInstance(
  layerRecord: ImportLayerRecord,
  parent: PageNode | SceneNode,
  layers: { [id: string]: ImportLayerRecord },
  restoredBefore: number,
  totalNodes: number
): Promise<number> {
  const session = activeImportSession;
  if (!session || !layerRecord.mainComponentId) return 0;
  const componentNode = session.restoredNodeById[layerRecord.mainComponentId];
  if (!componentNode || componentNode.removed || componentNode.type !== "COMPONENT") {
    console.warn(
      "[mg-instance] frame fallback:", layerRecord.id, layerRecord.props?.name || layerRecord.name,
      "→ component", layerRecord.mainComponentId,
      !componentNode ? "未还原(不在 restoredNodeById)" : componentNode.removed ? "已被移除" : `类型=${componentNode.type}`
    );
    return 0;
  }
  let instance: InstanceNode | null = null;
  try {
    instance = (componentNode as ComponentNode).createInstance();
    if (!appendRestoredNode(parent, instance)) throw new Error("无法挂载实例");
  } catch (error) {
    console.warn("[mg-instance] createInstance 失败,回退 Frame 壳:", layerRecord.id, layerRecord.props?.name || layerRecord.name, error);
    if (instance) safeRemove(instance);
    return 0;
  }
  // From here on the InstanceNode exists and is parented — keep it even if
  // property/override application partially fails (the component-instance
  // relationship is the point; a partially styled instance beats a frame shell).
  await applyInstanceRecordState(instance, layerRecord, layers);
  session.restoredNodeById[layerRecord.id] = instance;
  console.info("[mg-instance] restored:", layerRecord.id, layerRecord.props?.name || layerRecord.name, "→ instance of", layerRecord.mainComponentId);
  const accounted = 1 + countRecordDescendants(layerRecord, layers);
  await maybeReportRestoreProgress(restoredBefore + accounted, totalNodes);
  return accounted;
}

// Shared instance state application: MasterGo's uniform instance scale cannot
// be expressed through child geometry (instance children are locked to the
// component) — replay it with rescale() BEFORE the exact root resize in
// applyProperties, then apply per-child overrides positionally.
async function applyInstanceRecordState(
  instance: InstanceNode,
  layerRecord: ImportLayerRecord,
  layers: { [id: string]: ImportLayerRecord }
): Promise<void> {
  let rescaled = false;
  if (typeof layerRecord.instanceScale === "number" && isFinite(layerRecord.instanceScale) &&
      layerRecord.instanceScale > 0 && Math.abs(layerRecord.instanceScale - 1) > 1e-6) {
    try {
      instance.rescale(layerRecord.instanceScale);
      rescaled = true;
    } catch (error) {
      console.warn("[mg-instance] rescale 失败(继续):", layerRecord.id, layerRecord.instanceScale, error);
    }
  }
  try {
    const nodeProps = applyManifestLayoutToProps(layerRecord.props, layerRecord);
    await applyProperties(instance as any, nodeProps);
  } catch (error) {
    console.warn("[mg-instance] applyProperties 部分失败(实例保留):", layerRecord.id, error);
  }
  try {
    await applyInstanceChildOverrides(instance, layerRecord, layers, rescaled);
  } catch (error) {
    console.warn("[mg-instance] 子覆盖应用失败(实例保留):", layerRecord.id, error);
  }
}

// After a page finishes restoring, swap frame-shell fallbacks for real
// instances — their components definitely exist by now regardless of where
// they sat in the child order. Entries whose shell was already discarded
// (an outer shell got swapped first) are skipped.
async function retryDeferredInstanceRelinks(layers: { [id: string]: ImportLayerRecord }): Promise<void> {
  const session = activeImportSession;
  if (!session || session.deferredInstanceRelinks.length === 0) return;
  const pending = session.deferredInstanceRelinks;
  session.deferredInstanceRelinks = [];
  let swapped = 0;
  for (const entry of pending) {
    const layerRecord = layers[entry.id];
    const shell = entry.node;
    if (!layerRecord || !layerRecord.mainComponentId || !shell || shell.removed) continue;
    const componentNode = session.restoredNodeById[layerRecord.mainComponentId];
    if (!componentNode || componentNode.removed || componentNode.type !== "COMPONENT") continue;
    const parent = shell.parent;
    if (!parent || !("insertChild" in parent)) continue;
    let instance: InstanceNode | null = null;
    try {
      const index = parent.children.indexOf(shell);
      instance = (componentNode as ComponentNode).createInstance();
      parent.insertChild(index >= 0 ? index : parent.children.length, instance);
    } catch (error) {
      console.warn("[mg-instance] 延迟重链失败(保留 Frame 壳):", layerRecord.id, error);
      if (instance) safeRemove(instance);
      continue;
    }
    await applyInstanceRecordState(instance, layerRecord, layers);
    session.restoredNodeById[layerRecord.id] = instance;
    safeRemove(shell);
    swapped++;
  }
  if (swapped > 0) console.info("[mg-instance] deferred relinks swapped:", swapped, "/", pending.length);
}

function countRecordDescendants(record: ImportLayerRecord, layers: { [id: string]: ImportLayerRecord }): number {
  let count = 0;
  const seen: { [id: string]: true } = {};
  const stack = [...(record.childIds || [])];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen[id]) continue;
    seen[id] = true;
    const child = layers[id];
    if (!child) continue;
    count++;
    for (const grandChild of child.childIds || []) stack.push(grandChild);
  }
  return count;
}

// Positional override application: walk the instance's real children next to
// the record tree; on any structural drift (count mismatch) skip that subtree
// — the component state is still a faithful base. Only override-safe
// properties are touched, each guarded individually.
async function applyInstanceChildOverrides(
  instance: InstanceNode,
  record: ImportLayerRecord,
  layers: { [id: string]: ImportLayerRecord },
  rescaled: boolean
): Promise<void> {
  const pairs: Array<{ node: SceneNode; rec: ImportLayerRecord }> = [];
  const collect = (node: SceneNode, rec: ImportLayerRecord) => {
    if (!("children" in node)) return;
    const childIds = rec.childIds || [];
    const children = (node as ChildrenMixin & SceneNode).children;
    if (childIds.length !== children.length) return;
    for (let i = 0; i < childIds.length; i++) {
      const childRec = layers[childIds[i]];
      if (!childRec || !childRec.props) continue;
      pairs.push({ node: children[i], rec: childRec });
      collect(children[i], childRec);
    }
  };
  collect(instance, record);
  for (const { node, rec } of pairs) {
    const props = rec.props;
    try {
      if (props.scence && props.scence.visible === false && node.visible !== false) node.visible = false;
      else if (props.scence && props.scence.visible === true && node.visible === false) node.visible = true;
    } catch (error) { /* not overridable */ }
    try {
      const opacity = props.blend ? props.blend.opacity : undefined;
      if (typeof opacity === "number" && "opacity" in node && Math.abs((node as any).opacity - opacity) > 0.001) {
        (node as any).opacity = opacity;
      }
    } catch (error) { /* not overridable */ }
    if (node.type === "TEXT") {
      const textNode = node as TextNode;
      let charsOverridden = false;
      if (typeof props.characters === "string" && props.characters.length > 0) {
        try {
          if (textNode.characters !== props.characters && textNode.fontName !== figma.mixed) {
            await loadFontCached(textNode.fontName as FontName);
            textNode.characters = props.characters;
            charsOverridden = true;
          }
        } catch (error) { /* font unavailable or locked — keep component text */ }
      }
      // In a rescaled instance Figma re-hugs auto-resize text around the scaled
      // font with its own anchor rules (box lands 1px above the scaled spot
      // whenever fract(scaled lineHeight) > 0.5), and instance children cannot
      // be repositioned. textAutoResize IS overridable: pinning it to NONE
      // restores the exact scaled box, which is also MasterGo's glyph truth —
      // MasterGo's own instance hug is center-preserving, so glyphs sit at the
      // pure-scale position and only the integer-rounded bounding box differs
      // (< 0.5px). Texts whose characters were overridden keep hugging so the
      // box wraps the new content.
      if (rescaled && !charsOverridden &&
          (textNode.textAutoResize === "WIDTH_AND_HEIGHT" || textNode.textAutoResize === "HEIGHT")) {
        try {
          const len = textNode.characters.length;
          if (len > 0) {
            for (const font of textNode.getRangeAllFontNames(0, len)) await loadFontCached(font);
          }
          textNode.textAutoResize = "NONE";
        } catch (error) { /* fonts missing — keep hug behavior */ }
      }
    }
    // Paint overrides (e.g. a recolored key): apply record fills/strokes only
    // when they differ from the component-inherited paints, so untouched
    // children keep a clean (non-overridden) state. IMAGE paints need the
    // asset pipeline and are skipped here.
    const geometry = props.geometry;
    if (geometry) {
      try {
        if (Array.isArray(geometry.fills) && "fills" in node) {
          const want = comparablePaintKey(geometry.fills);
          const have = comparablePaintKey((node as any).fills);
          if (want !== null && want !== have) safeSetFills(node as any, geometry.fills);
        }
      } catch (error) { /* not overridable */ }
      try {
        if (Array.isArray(geometry.strokes) && "strokes" in node) {
          const want = comparablePaintKey(geometry.strokes);
          const have = comparablePaintKey((node as any).strokes);
          if (want !== null && want !== have) safeSetStrokes(node as any, geometry.strokes);
        }
      } catch (error) { /* not overridable */ }
    }
  }
}

// Canonical key for a paint list, tolerant of float noise; null = not
// comparable here (image paints, unknown shapes) — those keep component state.
function comparablePaintKey(paints: any): string | null {
  if (!Array.isArray(paints)) return null;
  const round = (v: any) => Math.round(((typeof v === "number" ? v : 0)) * 1000) / 1000;
  const out: any[] = [];
  for (const paint of paints) {
    if (!paint || typeof paint !== "object") return null;
    const visible = paint.visible === undefined
      ? (paint.isVisible === undefined ? true : !!paint.isVisible)
      : !!paint.visible;
    if (paint.type === "SOLID") {
      const c = paint.color || {};
      out.push(["S", round(c.r), round(c.g), round(c.b), round(paint.opacity === undefined ? 1 : paint.opacity), visible ? 1 : 0]);
      continue;
    }
    if (typeof paint.type === "string" && paint.type.indexOf("GRADIENT_") === 0) {
      const stops = (paint.gradientStops || []).map((s: any) => [
        round(s.position),
        round(s.color && s.color.r), round(s.color && s.color.g),
        round(s.color && s.color.b), round(s.color && s.color.a)
      ]);
      out.push(["G", paint.type, stops, visible ? 1 : 0]);
      continue;
    }
    return null;
  }
  return JSON.stringify(out);
}
