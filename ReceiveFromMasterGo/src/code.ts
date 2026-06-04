import { ImportPayload, ImportLayerRecord } from "../../shared/types";
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
  restoreGroupNode
} from "./appliers/container";
import { yieldToEventLoop } from "../../shared/utils";

const RESTORE_PROGRESS_NODE_INTERVAL = 100;
const RESTORE_PROGRESS_TIME_INTERVAL_MS = 500;

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
    current,
    total,
    label
  });
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

      applyDeferredLayoutRestores();
      cleanupImportedContainerShells(restoredPage);
      applyDeferredSingleChildAutoSpaceAlignmentFixes(restoredPage);
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
  if (shouldRestoreBooleanOperationTree(nodeProps)) {
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

  if (shouldRestoreBooleanVectorAsFrame(nodeProps, layerRecord)) {
    nodeProps = createBooleanFrameFallbackProps(nodeProps);
  }
  nodeProps = prepareConnectorPolylineFallbackProps(nodeProps, parent);
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
  for (const childId of childIds) {
    restoredCount += await restoreImportedNode(childId, newNode, layers, restoredBefore + restoredCount, totalNodes);
  }

  return restoredCount;
}
