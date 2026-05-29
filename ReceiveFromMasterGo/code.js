"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
let documentFonts = [];
const restoredLayoutByNodeId = {};
let importInProgress = false;
let cachedLayerRules = null;
let layerRulesBySourceType = null;
let layerRulesLoadPromise = null;
let activeImportAssets = {};
let imageHashByAssetName = {};
let missingImageAssetNames = {};
let missingImageAssetCount = 0;
let placeholderImageHash = null;
let restoredNodeIdBySourceId = {};
let deferredConnectorRestores = [];
let deferredLayoutRestores = [];
let fontLoadPromises = {};
let availableFontKeys = {};
let fallbackConnectorCount = 0;
let booleanFallbackCount = 0;
let connectorFallbackLogged = false;
let activeRestoreStats = null;
let activeProgressState = null;
const INTERNAL_PROPS_PREFIX = "[PROPS]";
const SIBLING_PROPS_PREFIX = "[PROPS_SIBLING]";
const MISSING_FONT_NAME_PREFIX_PATTERN = /^\[Font Missing\]\[([^\]]+)\]\[([^\]]+)\]\s*/;
const LAYER_RULES_SCHEMA = "mastergo2figma.layer-conversion-rules.v1";
const VALID_RECEIVE_CREATE_TYPES = [
    "VECTOR", "ELLIPSE", "RECTANGLE", "STAR", "LINE", "POLYGON",
    "TEXT", "SECTION", "SLICE", "FRAME", "GROUP", "CONNECTOR", "BOOLEAN_OPERATION"
];
const RESTORE_PROGRESS_NODE_INTERVAL = 100;
const RESTORE_PROGRESS_TIME_INTERVAL_MS = 500;
const DEFAULT_LAYER_CONVERSION_CONFIG = {
    schema: LAYER_RULES_SCHEMA,
    version: 1,
    rules: {
        BOOLEAN_OPERATION: { sourceType: "BOOLEAN_OPERATION", restoreType: "BOOLEAN_OPERATION", sendStrategy: "booleanTree", receiveCreate: "BOOLEAN_OPERATION", isContainer: true, visualFrameSource: false },
        PEN: { sourceType: "PEN", restoreType: "VECTOR", sendStrategy: "penNetwork", receiveCreate: "VECTOR", isContainer: false, visualFrameSource: false },
        VECTOR: { sourceType: "VECTOR", restoreType: "VECTOR", sendStrategy: "penNetwork", receiveCreate: "VECTOR", isContainer: false, visualFrameSource: false },
        ELLIPSE: { sourceType: "ELLIPSE", restoreType: "ELLIPSE", sendStrategy: "ellipseArc", receiveCreate: "ELLIPSE", isContainer: false, visualFrameSource: false },
        RECTANGLE: { sourceType: "RECTANGLE", restoreType: "RECTANGLE", sendStrategy: "universalOnly", receiveCreate: "RECTANGLE", isContainer: false, visualFrameSource: false },
        STAR: { sourceType: "STAR", restoreType: "STAR", sendStrategy: "star", receiveCreate: "STAR", isContainer: false, visualFrameSource: false },
        LINE: { sourceType: "LINE", restoreType: "LINE", sendStrategy: "universalOnly", receiveCreate: "LINE", isContainer: false, visualFrameSource: false },
        POLYGON: { sourceType: "POLYGON", restoreType: "POLYGON", sendStrategy: "polygon", receiveCreate: "POLYGON", isContainer: false, visualFrameSource: false },
        TEXT: { sourceType: "TEXT", restoreType: "TEXT", sendStrategy: "text", receiveCreate: "TEXT", isContainer: false, visualFrameSource: false },
        FRAME: { sourceType: "FRAME", restoreType: "FRAME", sendStrategy: "frameLike", receiveCreate: "FRAME", isContainer: true, visualFrameSource: false },
        GROUP: { sourceType: "GROUP", restoreType: "GROUP", sendStrategy: "groupLike", receiveCreate: "GROUP", isContainer: true, visualFrameSource: false },
        SECTION: { sourceType: "SECTION", restoreType: "SECTION", sendStrategy: "frameLike", receiveCreate: "SECTION", isContainer: true, visualFrameSource: false },
        SLICE: { sourceType: "SLICE", restoreType: "SLICE", sendStrategy: "universalOnly", receiveCreate: "SLICE", isContainer: false, visualFrameSource: false },
        CONNECTOR: { sourceType: "CONNECTOR", restoreType: "CONNECTOR", sendStrategy: "connector", receiveCreate: "CONNECTOR", isContainer: false, visualFrameSource: false },
        COMPONENT: { sourceType: "COMPONENT", restoreType: "FRAME", sendStrategy: "frameLike", receiveCreate: "FRAME", isContainer: true, visualFrameSource: true },
        COMPONENT_SET: { sourceType: "COMPONENT_SET", restoreType: "FRAME", sendStrategy: "frameLike", receiveCreate: "FRAME", isContainer: true, visualFrameSource: true },
        INSTANCE: { sourceType: "INSTANCE", restoreType: "FRAME", sendStrategy: "frameLike", receiveCreate: "FRAME", isContainer: true, visualFrameSource: true }
    }
};
showImportUI();
function showImportUI() {
    startLayerRulesLoad();
    figma.showUI(__html__, { width: 400, height: 758 });
    figma.ui.onmessage = (message) => __awaiter(this, void 0, void 0, function* () {
        if (!message || typeof message !== "object")
            return;
        if (message.type === "ui-ready") {
            yield postInitUI();
            return;
        }
        if (message.type === "close") {
            figma.closePlugin();
            return;
        }
        if (message.type !== "start-import")
            return;
        if (importInProgress)
            return;
        importInProgress = true;
        try {
            yield ensureLayerRulesLoaded();
            if (message.payload) {
                yield restoreImportPayload(message.payload);
            }
            else {
                throw new Error("请先选择有效的 MasterGo2Figma zip");
            }
        }
        catch (error) {
            console.error("Import failed:", error);
            figma.ui.postMessage({
                type: "error",
                message: error instanceof Error ? error.message : "导入失败，请查看控制台"
            });
        }
        importInProgress = false;
    });
}
function postInitUI() {
    return __awaiter(this, void 0, void 0, function* () {
        yield ensureLayerRulesLoaded();
        figma.ui.postMessage({
            type: "init",
            rules: getLayerRuleStatus()
        });
    });
}
function startLayerRulesLoad() {
    if (!layerRulesLoadPromise)
        layerRulesLoadPromise = loadCachedLayerRules();
    return layerRulesLoadPromise;
}
function ensureLayerRulesLoaded() {
    return __awaiter(this, void 0, void 0, function* () {
        yield startLayerRulesLoad();
    });
}
function loadCachedLayerRules() {
    return __awaiter(this, void 0, void 0, function* () {
        cachedLayerRules = {
            config: DEFAULT_LAYER_CONVERSION_CONFIG,
            fileName: "内置转换规则",
            importedAt: ""
        };
        layerRulesBySourceType = createLayerRuleIndex(DEFAULT_LAYER_CONVERSION_CONFIG);
    });
}
function createLayerRuleIndex(config) {
    const result = {};
    for (const sourceType in config.rules)
        result[sourceType] = config.rules[sourceType];
    return result;
}
function getLayerRuleStatus() {
    if (!cachedLayerRules || !layerRulesBySourceType)
        return { valid: false };
    return {
        valid: true,
        fileName: cachedLayerRules.fileName,
        importedAt: cachedLayerRules.importedAt,
        ruleCount: Object.keys(layerRulesBySourceType).length
    };
}
function hasValidLayerRules() {
    return !!layerRulesBySourceType;
}
function getLayerRule(sourceType) {
    if (!sourceType || !layerRulesBySourceType)
        return null;
    return layerRulesBySourceType[sourceType] || null;
}
function getRuleRestoreType(sourceType) {
    const rule = getLayerRule(sourceType);
    return rule ? rule.restoreType : sourceType;
}
function isVisualFrameSourceType(sourceType) {
    const rule = getLayerRule(sourceType);
    return !!rule && rule.visualFrameSource;
}
function getReceiveCreateType(data) {
    const override = data && data.receiveCreateOverride;
    if (override === "SVG" && typeof data.svgMarkup === "string" && data.svgMarkup.trim())
        return "SVG";
    if (override && VALID_RECEIVE_CREATE_TYPES.indexOf(override) !== -1)
        return override;
    const sourceType = data.sourceType || data.type;
    const rule = getLayerRule(sourceType) || getLayerRule(data.restoreType) || getLayerRule(data.type);
    if (rule)
        return rule.receiveCreate;
    const restoreType = getRestoreType(data);
    if (restoreType === "PEN")
        return "VECTOR";
    return restoreType;
}
function restoreImportPayload(payload) {
    return __awaiter(this, void 0, void 0, function* () {
        yield ensureLayerRulesLoaded();
        if (!hasValidLayerRules())
            throw new Error("请先导入有效的图层转换规则 JSON");
        if (!payload || !payload.manifest || !payload.pages || !payload.layers) {
            throw new Error("导入数据不完整");
        }
        if (payload.manifest.schema !== "mastergo2figma.package.v2" || payload.manifest.version !== 2) {
            throw new Error("当前只支持 v2 导出包，请用新版 SendToFigma 重新导出。");
        }
        activeImportAssets = normalizeImportAssets(payload.assets || {});
        imageHashByAssetName = {};
        missingImageAssetNames = {};
        missingImageAssetCount = 0;
        restoredNodeIdBySourceId = {};
        deferredConnectorRestores = [];
        deferredLayoutRestores = [];
        fallbackConnectorCount = 0;
        booleanFallbackCount = 0;
        connectorFallbackLogged = false;
        let totalNodes = 0;
        for (const page of payload.pages)
            totalNodes += page.layerCount || 0;
        if (totalNodes === 0)
            throw new Error("所选页面没有可还原的图层");
        resetRestoreRuntimeStats(totalNodes, payload.pages.length);
        const previousCurrentPage = figma.currentPage;
        let restoredNodes = 0;
        const restoredPages = [];
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
                    restoredNodes += yield restoreImportedNode(rootId, restoredPage, payload.layers, restoredNodes, totalNodes);
                }
                applyDeferredLayoutRestores();
                cleanupImportedContainerShells(restoredPage);
                applyDeferredSingleChildAutoSpaceAlignmentFixes(restoredPage);
            }
        }
        catch (error) {
            figma.currentPage = previousCurrentPage;
            throw error;
        }
        applyDeferredConnectorRestores();
        yield maybeReportRestoreProgress(restoredNodes, totalNodes, "正在还原缺失字体...", true);
        const missingFontRestoreResult = yield restoreMissingFontTextLayers(restoredPages);
        yield maybeReportRestoreProgress(restoredNodes, totalNodes, "正在完成还原...", true);
        if (restoredPages.length > 0) {
            figma.currentPage = restoredPages[0];
            figma.viewport.scrollAndZoomIntoView(restoredPages[0].children);
        }
        figma.ui.postMessage({
            type: "complete",
            pageCount: restoredPages.length,
            layerCount: restoredNodes,
            missingImageAssetCount,
            fallbackConnectorCount,
            restoredMissingFontTextNodeCount: missingFontRestoreResult.restoredTextNodeCount,
            failedMissingFontTextNodeCount: missingFontRestoreResult.failedTextNodeCount
        });
        const completeDetails = [];
        if (missingImageAssetCount > 0)
            completeDetails.push(`Missing images: ${missingImageAssetCount}`);
        if (fallbackConnectorCount > 0)
            completeDetails.push(`Connectors restored as polylines: ${fallbackConnectorCount}`);
        if (missingFontRestoreResult.restoredTextNodeCount > 0)
            completeDetails.push(`Fonts restored: ${missingFontRestoreResult.restoredTextNodeCount}`);
        if (missingFontRestoreResult.failedTextNodeCount > 0)
            completeDetails.push(`Fonts still missing: ${missingFontRestoreResult.failedTextNodeCount}`);
        logRestorePerformanceSummary(restoredNodes, restoredPages.length);
        figma.notify(completeDetails.length > 0 ? `Restore complete. ${completeDetails.join("; ")}` : "Restore complete!");
    });
}
function resetRestoreRuntimeStats(totalNodes, pageCount) {
    activeRestoreStats = {
        startedAt: Date.now(),
        totalNodes,
        restoredNodes: 0,
        pageCount,
        textNodeCount: 0,
        fontListLoadCount: 0,
        fontLoadRequestCount: 0,
        fontLoadCacheHitCount: 0,
        fontLoadFailureCount: 0,
        deferredLayoutNodeCount: 0,
        deferredLayoutAppliedCount: 0,
        safeSetWriteCount: 0,
        safeSetSkipCount: 0,
        resizeWriteCount: 0,
        resizeSkipCount: 0
    };
    activeProgressState = {
        total: totalNodes,
        lastCurrent: 0,
        lastPostedAt: Date.now()
    };
}
function maybeReportRestoreProgress(current, total, label, force = false) {
    return __awaiter(this, void 0, void 0, function* () {
        const now = Date.now();
        const state = activeProgressState || {
            total,
            lastCurrent: 0,
            lastPostedAt: 0
        };
        const shouldPost = force ||
            current >= total ||
            current - state.lastCurrent >= RESTORE_PROGRESS_NODE_INTERVAL ||
            now - state.lastPostedAt >= RESTORE_PROGRESS_TIME_INTERVAL_MS;
        if (!shouldPost)
            return;
        figma.ui.postMessage({
            type: "progress",
            current,
            total,
            label
        });
        state.total = total;
        state.lastCurrent = current;
        state.lastPostedAt = now;
        activeProgressState = state;
        yield yieldToEventLoop();
    });
}
function noteBooleanFallback() {
    booleanFallbackCount++;
}
function logRestorePerformanceSummary(restoredNodes, pageCount) {
    if (!activeRestoreStats)
        return;
    activeRestoreStats.restoredNodes = restoredNodes;
    activeRestoreStats.pageCount = pageCount;
    const durationMs = Math.max(Date.now() - activeRestoreStats.startedAt, 1);
    const nodesPerSecond = Math.round((restoredNodes / durationMs) * 10000) / 10;
    console.log("[MasterGo2Figma] Restore performance", {
        durationMs,
        duration: formatDurationMs(durationMs),
        nodesPerSecond,
        totalNodes: activeRestoreStats.totalNodes,
        restoredNodes,
        pageCount,
        textNodeCount: activeRestoreStats.textNodeCount,
        fontListLoadCount: activeRestoreStats.fontListLoadCount,
        fontLoadRequestCount: activeRestoreStats.fontLoadRequestCount,
        fontLoadCacheHitCount: activeRestoreStats.fontLoadCacheHitCount,
        fontLoadFailureCount: activeRestoreStats.fontLoadFailureCount,
        deferredLayoutNodeCount: activeRestoreStats.deferredLayoutNodeCount,
        deferredLayoutAppliedCount: activeRestoreStats.deferredLayoutAppliedCount,
        safeSetWriteCount: activeRestoreStats.safeSetWriteCount,
        safeSetSkipCount: activeRestoreStats.safeSetSkipCount,
        resizeWriteCount: activeRestoreStats.resizeWriteCount,
        resizeSkipCount: activeRestoreStats.resizeSkipCount,
        booleanFallbackCount,
        fallbackConnectorCount
    });
}
function formatDurationMs(ms) {
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
}
function restoreImportedNode(nodeId, parent, layers, restoredBefore, totalNodes) {
    return __awaiter(this, void 0, void 0, function* () {
        const layerRecord = layers[nodeId];
        if (!layerRecord || !layerRecord.props) {
            console.warn("Missing layer record:", nodeId);
            return 0;
        }
        let nodeProps = applyManifestLayoutToProps(layerRecord.props, layerRecord);
        if (shouldRestoreBooleanOperationTree(nodeProps)) {
            return yield restoreBooleanOperationTree(nodeProps, parent, layerRecord, layers, restoredBefore, totalNodes);
        }
        if (shouldRestoreBooleanVectorAsFrame(nodeProps, layerRecord)) {
            noteBooleanFallback();
            nodeProps = createBooleanFrameFallbackProps(nodeProps);
        }
        nodeProps = prepareConnectorPolylineFallbackProps(nodeProps, parent);
        const newNode = yield createNodeFromData(nodeProps);
        if (!newNode)
            return 0;
        try {
            if (!appendRestoredNode(parent, newNode))
                return 0;
            yield applyProperties(newNode, nodeProps);
        }
        catch (error) {
            console.warn("Unable to restore node, removing partial node:", (nodeProps === null || nodeProps === void 0 ? void 0 : nodeProps.name) || layerRecord.name || nodeId, error);
            safeRemove(newNode);
            return 0;
        }
        let restoredCount = 1;
        const currentCount = restoredBefore + restoredCount;
        yield maybeReportRestoreProgress(currentCount, totalNodes, "正在还原：" + (nodeProps.name || layerRecord.name));
        const childIds = nodeProps.omitChildrenOnRestore ? [] : (layerRecord.childIds || []);
        for (const childId of childIds) {
            restoredCount += yield restoreImportedNode(childId, newNode, layers, restoredBefore + restoredCount, totalNodes);
        }
        return restoredCount;
    });
}
function applyManifestLayoutToProps(props, meta) {
    if (!props || !meta)
        return props;
    return props;
}
function shouldRestoreBooleanVectorAsFrame(data, layerRecord) {
    if (!data || data.sourceType !== "BOOLEAN_OPERATION")
        return false;
    if (data.receiveCreateOverride || data.svgFallback)
        return false;
    if (data.type !== "VECTOR" && data.restoreType !== "VECTOR")
        return false;
    if (!layerRecord.childIds || layerRecord.childIds.length === 0)
        return false;
    return !hasUsableVectorNetwork(data.vectorNetwork);
}
function shouldRestoreBooleanOperationTree(data) {
    if (!data)
        return false;
    return data.sourceType === "BOOLEAN_OPERATION" &&
        (data.type === "BOOLEAN_OPERATION" || data.restoreType === "BOOLEAN_OPERATION" || data.receiveCreateOverride === "BOOLEAN_OPERATION");
}
function restoreBooleanOperationTree(nodeProps, parent, layerRecord, layers, restoredBefore, totalNodes) {
    return __awaiter(this, void 0, void 0, function* () {
        const shell = figma.createFrame();
        const shellProps = createBooleanFrameFallbackProps(nodeProps);
        let appended = false;
        try {
            if (!appendRestoredNode(parent, shell))
                return 0;
            appended = true;
            yield applyProperties(shell, shellProps);
        }
        catch (error) {
            console.warn("Unable to create boolean restore shell:", (nodeProps === null || nodeProps === void 0 ? void 0 : nodeProps.name) || layerRecord.name, error);
            if (appended)
                safeRemove(shell);
            return yield restoreBooleanFallbackNode(nodeProps, parent, layerRecord, restoredBefore, totalNodes);
        }
        let restoredCount = 1;
        const currentCount = restoredBefore + restoredCount;
        yield maybeReportRestoreProgress(currentCount, totalNodes, "正在还原：" + (nodeProps.name || layerRecord.name));
        const childIds = nodeProps.omitChildrenOnRestore ? [] : (layerRecord.childIds || []);
        for (const childId of childIds) {
            restoredCount += yield restoreImportedNode(childId, shell, layers, restoredBefore + restoredCount, totalNodes);
        }
        const combined = yield combineBooleanShell(shell, nodeProps);
        if (!combined) {
            yield restoreBooleanFallbackFromShell(shell, nodeProps);
        }
        return restoredCount;
    });
}
function combineBooleanShell(shell, data) {
    return __awaiter(this, void 0, void 0, function* () {
        const parent = shell.parent;
        if (!parent || !("insertChild" in parent))
            return null;
        const children = [...shell.children];
        if (children.length < 2) {
            console.warn("Unable to restore boolean operation because it has fewer than two children:", (data === null || data === void 0 ? void 0 : data.name) || (data === null || data === void 0 ? void 0 : data.id) || "Untitled");
            return null;
        }
        const operation = normalizeBooleanOperation(data.booleanOperation);
        if (!operation) {
            console.warn("Unsupported boolean operation:", data === null || data === void 0 ? void 0 : data.booleanOperation, (data === null || data === void 0 ? void 0 : data.name) || (data === null || data === void 0 ? void 0 : data.id) || "Untitled");
            return null;
        }
        try {
            const combined = createBooleanOperationNode(operation, children, shell, 0);
            const parentIndex = parent.children.indexOf(shell);
            parent.insertChild(parentIndex >= 0 ? parentIndex : parent.children.length, combined);
            yield applyProperties(combined, data);
            safeRemove(shell);
            return combined;
        }
        catch (error) {
            console.warn("Unable to combine boolean operation, falling back:", (data === null || data === void 0 ? void 0 : data.name) || (data === null || data === void 0 ? void 0 : data.id) || "Untitled", error);
            return null;
        }
    });
}
function normalizeBooleanOperation(value) {
    if (value === "UNION" || value === "SUBTRACT" || value === "INTERSECT" || value === "EXCLUDE")
        return value;
    return null;
}
function createBooleanOperationNode(operation, children, parent, index) {
    if (operation === "UNION")
        return figma.union(children, parent, index);
    if (operation === "SUBTRACT")
        return figma.subtract(children, parent, index);
    if (operation === "INTERSECT")
        return figma.intersect(children, parent, index);
    return figma.exclude(children, parent, index);
}
function restoreBooleanFallbackFromShell(shell, data) {
    return __awaiter(this, void 0, void 0, function* () {
        const parent = shell.parent;
        if (!parent || !("insertChild" in parent))
            return;
        noteBooleanFallback();
        const svgNode = createSvgFallbackNode(data);
        if (svgNode) {
            const index = parent.children.indexOf(shell);
            try {
                parent.insertChild(index >= 0 ? index : parent.children.length, svgNode);
                yield applyProperties(svgNode, createSvgFallbackProps(data));
                safeRemove(shell);
                return;
            }
            catch (error) {
                console.warn("Unable to insert boolean SVG fallback:", (data === null || data === void 0 ? void 0 : data.name) || (data === null || data === void 0 ? void 0 : data.id) || "Untitled", error);
                safeRemove(svgNode);
            }
        }
        yield applyProperties(shell, createBooleanFrameFallbackProps(data));
    });
}
function restoreBooleanFallbackNode(data, parent, layerRecord, restoredBefore, totalNodes) {
    return __awaiter(this, void 0, void 0, function* () {
        noteBooleanFallback();
        const svgNode = createSvgFallbackNode(data);
        const fallbackNode = svgNode || figma.createFrame();
        const fallbackProps = svgNode ? createSvgFallbackProps(data) : createBooleanFrameFallbackProps(data);
        try {
            if (!appendRestoredNode(parent, fallbackNode))
                return 0;
            yield applyProperties(fallbackNode, fallbackProps);
        }
        catch (error) {
            console.warn("Unable to restore boolean fallback:", (data === null || data === void 0 ? void 0 : data.name) || layerRecord.name, error);
            safeRemove(fallbackNode);
            return 0;
        }
        const currentCount = restoredBefore + 1;
        yield maybeReportRestoreProgress(currentCount, totalNodes, "正在还原：" + (data.name || layerRecord.name));
        return 1;
    });
}
function createSvgFallbackNode(data) {
    if (typeof (data === null || data === void 0 ? void 0 : data.svgMarkup) !== "string" || !data.svgMarkup.trim())
        return null;
    try {
        return figma.createNodeFromSvg(data.svgMarkup);
    }
    catch (error) {
        console.warn("Unable to create boolean SVG fallback:", (data === null || data === void 0 ? void 0 : data.name) || (data === null || data === void 0 ? void 0 : data.id) || "Untitled", error);
        return null;
    }
}
function createSvgFallbackProps(data) {
    return Object.assign(Object.assign({}, data), { svgFallback: true, receiveCreateOverride: "SVG" });
}
function createBooleanFrameFallbackProps(data) {
    return Object.assign(Object.assign({}, data), { type: "FRAME", restoreType: "FRAME", receiveCreateOverride: "FRAME", booleanFallback: "frameContainer", clipsContent: false, geometry: clearGeometryPaint(data.geometry) });
}
function clearGeometryPaint(geometry) {
    if (!geometry || typeof geometry !== "object")
        return geometry;
    return Object.assign(Object.assign({}, geometry), { fills: [], strokes: [], strokeWeight: 0 });
}
function hasUsableVectorNetwork(vectorNetwork) {
    return !!(vectorNetwork &&
        Array.isArray(vectorNetwork.vertices) &&
        vectorNetwork.vertices.length > 0 &&
        Array.isArray(vectorNetwork.segments));
}
function prepareConnectorPolylineFallbackProps(data, parent) {
    if (!isConnectorRestoreData(data))
        return data;
    const props = Object.assign({}, data);
    props.connectorFallbackPolyline = true;
    if (!hasUsableVectorNetwork(props.vectorNetwork)) {
        props.vectorNetwork = createConnectorVectorNetworkFromData(props, parent);
    }
    return props;
}
function isConnectorRestoreData(data) {
    return !!data && (data.sourceType === "CONNECTOR" || data.type === "CONNECTOR" || data.restoreType === "CONNECTOR");
}
function appendRestoredNode(parent, node) {
    if ("appendChild" in parent) {
        parent.appendChild(node);
        return true;
    }
    console.warn("Unable to append restored node because parent cannot contain children:", node.name, parent.name);
    safeRemove(node);
    return false;
}
function createRestoredPageName(name) {
    return name || "Imported Page";
}
function yieldToEventLoop() {
    return new Promise(resolve => setTimeout(resolve, 0));
}
function resetInlineRestoreState() {
    restoredNodeIdBySourceId = {};
    deferredConnectorRestores = [];
}
function deferLayoutRestore(node, layout, isGroup) {
    if (!node || !layout || !isSceneNode(node))
        return;
    deferredLayoutRestores.push({ node, layout, isGroup });
    if (activeRestoreStats)
        activeRestoreStats.deferredLayoutNodeCount++;
}
function applyDeferredLayoutRestores() {
    if (deferredLayoutRestores.length === 0)
        return;
    const records = deferredLayoutRestores;
    deferredLayoutRestores = [];
    for (const record of records)
        applyDeferredNodeAutoLayout(record);
    for (const record of records)
        applyDeferredParentAutoLayout(record);
    for (const record of records)
        finalizeDeferredAutoLayout(record);
}
function applyDeferredNodeAutoLayout(record) {
    const { node, layout, isGroup } = record;
    if (isRemovedNode(node) || isGroup || !("layoutMode" in node))
        return;
    let applied = false;
    if (layout.layoutMode) {
        safeSet(node, "layoutMode", normalizeLayoutMode(layout.layoutMode));
        applied = true;
    }
    if (hasAutoLayout(node)) {
        if (layout.primaryAxisSizingMode) {
            safeSet(node, "primaryAxisSizingMode", normalizeAxisSizingMode(layout.primaryAxisSizingMode));
            applied = true;
        }
        if (layout.counterAxisSizingMode) {
            safeSet(node, "counterAxisSizingMode", normalizeAxisSizingMode(layout.counterAxisSizingMode));
            applied = true;
        }
        if (layout.itemSpacing !== undefined) {
            safeSet(node, "itemSpacing", layout.itemSpacing);
            applied = true;
        }
        if (layout.paddingLeft !== undefined) {
            safeSet(node, "paddingLeft", layout.paddingLeft);
            applied = true;
        }
        if (layout.paddingRight !== undefined) {
            safeSet(node, "paddingRight", layout.paddingRight);
            applied = true;
        }
        if (layout.paddingTop !== undefined) {
            safeSet(node, "paddingTop", layout.paddingTop);
            applied = true;
        }
        if (layout.paddingBottom !== undefined) {
            safeSet(node, "paddingBottom", layout.paddingBottom);
            applied = true;
        }
        if (layout.primaryAxisAlignItems) {
            safeSet(node, "primaryAxisAlignItems", normalizeAxisAlign(layout.primaryAxisAlignItems));
            applied = true;
        }
        if (layout.counterAxisAlignItems) {
            safeSet(node, "counterAxisAlignItems", normalizeAxisAlign(layout.counterAxisAlignItems));
            applied = true;
        }
        if (layout.counterAxisAlignContent) {
            safeSet(node, "counterAxisAlignContent", layout.counterAxisAlignContent);
            applied = true;
        }
        if (layout.itemReverseZIndex !== undefined) {
            safeSet(node, "itemReverseZIndex", layout.itemReverseZIndex);
            applied = true;
        }
        if (layout.strokesIncludedInLayout !== undefined) {
            safeSet(node, "strokesIncludedInLayout", layout.strokesIncludedInLayout);
            applied = true;
        }
    }
    if (applied && activeRestoreStats)
        activeRestoreStats.deferredLayoutAppliedCount++;
}
function applyDeferredParentAutoLayout(record) {
    const { node, layout } = record;
    if (isRemovedNode(node) || !hasAutoLayoutParent(node))
        return;
    let applied = false;
    if (layout.layoutPositioning) {
        safeSet(node, "layoutPositioning", layout.layoutPositioning);
        applied = true;
    }
    if (layout.layoutAlign) {
        safeSet(node, "layoutAlign", normalizeLayoutAlign(layout.layoutAlign));
        applied = true;
    }
    if (layout.layoutGrow !== undefined) {
        safeSet(node, "layoutGrow", layout.layoutGrow);
        applied = true;
    }
    if (layout.relativeTransform) {
        safeSet(node, "relativeTransform", layout.relativeTransform);
        applied = true;
    }
    if (layout.x !== undefined) {
        safeSet(node, "x", layout.x);
        applied = true;
    }
    if (layout.y !== undefined) {
        safeSet(node, "y", layout.y);
        applied = true;
    }
    if (applied && activeRestoreStats)
        activeRestoreStats.deferredLayoutAppliedCount++;
}
function finalizeDeferredAutoLayout(record) {
    const { node, layout, isGroup } = record;
    if (isRemovedNode(node) || isGroup || !hasAutoLayout(node))
        return;
    if (layout.width === undefined || layout.height === undefined || !shouldRestoreFixedSize(node, layout))
        return;
    safeResize(node, layout.width, layout.height);
    if (layout.relativeTransform)
        safeSet(node, "relativeTransform", layout.relativeTransform);
    if (layout.x !== undefined)
        safeSet(node, "x", layout.x);
    if (layout.y !== undefined)
        safeSet(node, "y", layout.y);
}
function isRemovedNode(node) {
    return !node || !!node.removed;
}
function cleanupImportedContainerShells(root) {
    if (!("children" in root))
        return;
    if (isSceneNode(root) && (root.type === "INSTANCE" || isInsideInstance(root)))
        return;
    const children = [...root.children];
    for (const child of children) {
        cleanupImportedContainerShells(child);
    }
    if (!isSceneNode(root) || !isShellContainer(root))
        return;
    const shellChildren = [...root.children];
    for (const child of shellChildren) {
        if (child.type === "RECTANGLE" && child.name === root.name) {
            clearMaskFlag(child);
            safeRemove(child);
            return;
        }
    }
}
function isShellContainer(node) {
    return node.type === "FRAME" ||
        node.type === "GROUP" ||
        node.type === "SECTION" ||
        node.type === "COMPONENT" ||
        node.type === "INSTANCE" ||
        node.type === "COMPONENT_SET";
}
function clearMaskFlag(node) {
    const nodeAny = node;
    if (!("isMask" in nodeAny))
        return;
    try {
        nodeAny.isMask = false;
    }
    catch (e) {
        console.warn("Unable to clear mask before removing imported rectangle:", node.name, e);
    }
}
function safeRemove(node) {
    if (node.removed)
        return;
    try {
        node.remove();
    }
    catch (e) {
        console.warn("Unable to remove node:", node.name, e);
    }
}
function isInsideInstance(node) {
    let parent = node.parent;
    while (parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT") {
        if (parent.type === "INSTANCE")
            return true;
        parent = parent.parent;
    }
    return false;
}
function isNearlyZero(value) {
    return Math.abs(value) < 0.01;
}
function isNearlyEqual(a, b) {
    return Math.abs(a - b) < 0.01;
}
function isSceneNode(node) {
    return node.type !== "DOCUMENT" && node.type !== "PAGE";
}
function getRestoreType(data) {
    const sourceType = data.sourceType || data.type;
    if (data.restoreType)
        return data.restoreType;
    const rule = getLayerRule(sourceType) || getLayerRule(data.type);
    if (rule)
        return rule.restoreType;
    return data.type;
}
function createNodeFromData(data) {
    return __awaiter(this, void 0, void 0, function* () {
        let node = null;
        const type = getReceiveCreateType(data);
        try {
            switch (type) {
                case "SVG":
                    if (typeof data.svgMarkup === "string" && data.svgMarkup.trim()) {
                        node = figma.createNodeFromSvg(data.svgMarkup);
                    }
                    else {
                        node = figma.createFrame();
                    }
                    break;
                case "PEN":
                case "VECTOR":
                    const vector = figma.createVector();
                    node = vector;
                    if (data.vectorNetwork)
                        applyVectorNetwork(vector, data.vectorNetwork, data);
                    break;
                case "ELLIPSE":
                    const ellipse = figma.createEllipse();
                    node = ellipse;
                    if (data.arcData)
                        safeSet(ellipse, "arcData", data.arcData);
                    break;
                case "RECTANGLE":
                    node = figma.createRectangle();
                    break;
                case "STAR":
                    const star = figma.createStar();
                    node = star;
                    safeSet(star, "pointCount", data.pointCount || 5);
                    safeSet(star, "innerRadius", data.innerRadius || 0.38);
                    break;
                case "LINE":
                    node = figma.createLine();
                    break;
                case "POLYGON":
                    const polygon = figma.createPolygon();
                    node = polygon;
                    safeSet(polygon, "pointCount", data.pointCount || 3);
                    break;
                case "TEXT":
                    node = figma.createText();
                    break;
                case "SECTION":
                    node = figma.createSection();
                    break;
                case "SLICE":
                    node = figma.createSlice();
                    break;
                case "CONNECTOR":
                    const connectorVector = figma.createVector();
                    node = connectorVector;
                    if (!data.connectorFallbackPolyline)
                        data.connectorFallbackPolyline = true;
                    if (!hasUsableVectorNetwork(data.vectorNetwork))
                        data.vectorNetwork = createConnectorVectorNetworkFromData(data, null);
                    if (data.vectorNetwork)
                        applyVectorNetwork(connectorVector, data.vectorNetwork, data);
                    fallbackConnectorCount++;
                    if (!connectorFallbackLogged) {
                        connectorFallbackLogged = true;
                        console.warn("CONNECTOR restored as VECTOR polyline because createConnector is unavailable/disabled");
                    }
                    break;
                case "BOOLEAN_OPERATION":
                    node = figma.createFrame();
                    break;
                case "FRAME":
                    node = figma.createFrame();
                    break;
                case "GROUP":
                    node = figma.createFrame();
                    node.name = "GROUP_PLACEHOLDER";
                    break;
                default:
                    console.warn("Unsupported type:", type);
                    break;
            }
        }
        catch (error) {
            console.warn("Unable to create node, removing partial node:", (data === null || data === void 0 ? void 0 : data.name) || (data === null || data === void 0 ? void 0 : data.id) || type, error);
            if (node)
                safeRemove(node);
            return null;
        }
        return node;
    });
}
function applyProperties(node, data) {
    var _a, _b, _c, _d;
    return __awaiter(this, void 0, void 0, function* () {
        if (!node || !data)
            return;
        safeSet(node, "name", data.name);
        recordRestoredNode(data, node);
        if (data.scence) {
            safeSet(node, "visible", (_a = data.scence.visible) !== null && _a !== void 0 ? _a : true);
            safeSet(node, "locked", (_b = data.scence.locked) !== null && _b !== void 0 ? _b : false);
        }
        if (data.blend) {
            safeSet(node, "opacity", (_c = data.blend.opacity) !== null && _c !== void 0 ? _c : 1);
            safeSet(node, "isMask", (_d = data.blend.isMask) !== null && _d !== void 0 ? _d : false);
            safeSet(node, "blendMode", data.blend.blendMode || "NORMAL");
            if (data.blend.effects)
                safeSet(node, "effects", normalizeEffectsForNode(node, data.blend.effects));
        }
        const isGroup = node.type === "GROUP";
        if (!isGroup && data.corner && node.type !== "LINE" && node.type !== "TEXT") {
            if (data.corner.cornerRadius === -1) {
                if ("topLeftRadius" in node) {
                    safeSet(node, "topLeftRadius", data.corner.topLeftRadius || 0);
                    safeSet(node, "topRightRadius", data.corner.topRightRadius || 0);
                    safeSet(node, "bottomLeftRadius", data.corner.bottomLeftRadius || 0);
                    safeSet(node, "bottomRightRadius", data.corner.bottomRightRadius || 0);
                }
            }
            else {
                safeSet(node, "cornerRadius", data.corner.cornerRadius || 0);
            }
            safeSet(node, "cornerSmoothing", data.corner.cornerSmoothing || 0);
        }
        if (!isGroup && data.geometry && !data.svgFallback) {
            if (data.geometry.fills)
                safeSetFills(node, normalizeImageFills(data.geometry.fills));
            if (data.geometry.strokes)
                safeSet(node, "strokes", data.geometry.strokes);
            if (data.geometry.strokeWeight !== undefined)
                safeSet(node, "strokeWeight", data.geometry.strokeWeight);
            if (data.geometry.strokeAlign)
                safeSet(node, "strokeAlign", data.geometry.strokeAlign);
            if (data.geometry.strokeJoin)
                safeSet(node, "strokeJoin", data.geometry.strokeJoin);
            if (data.geometry.dashPattern !== undefined)
                safeSet(node, "dashPattern", data.geometry.dashPattern);
            if (data.geometry.strokeCap && !data.connectorFallbackPolyline)
                safeSet(node, "strokeCap", data.geometry.strokeCap);
            if (data.geometry.strokeTopWeight !== undefined)
                safeSet(node, "strokeTopWeight", data.geometry.strokeTopWeight);
            if (data.geometry.strokeBottomWeight !== undefined)
                safeSet(node, "strokeBottomWeight", data.geometry.strokeBottomWeight);
            if (data.geometry.strokeLeftWeight !== undefined)
                safeSet(node, "strokeLeftWeight", data.geometry.strokeLeftWeight);
            if (data.geometry.strokeRightWeight !== undefined)
                safeSet(node, "strokeRightWeight", data.geometry.strokeRightWeight);
        }
        if (data.constraints)
            safeSet(node, "constraints", normalizeConstraints(data.constraints));
        if (data.exportSettings)
            safeSet(node, "exportSettings", data.exportSettings);
        if (data.layout) {
            const layout = normalizeLayoutForParent(node, data.layout);
            restoredLayoutByNodeId[node.id] = layout;
            if (layout.relativeTransform)
                safeSet(node, "relativeTransform", layout.relativeTransform);
            if (layout.x !== undefined)
                safeSet(node, "x", layout.x);
            if (layout.y !== undefined)
                safeSet(node, "y", layout.y);
            if (layout.rotation !== undefined)
                safeSet(node, "rotation", layout.rotation);
            if (layout.width !== undefined && layout.height !== undefined) {
                if (isGroup) {
                    // Group resize is different, but for now we trust relativeTransform
                }
                else {
                    safeResize(node, layout.width, layout.height);
                }
            }
            if (layout.constrainProportions !== undefined) {
                applyAspectRatioLock(node, layout.constrainProportions);
            }
            deferLayoutRestore(node, layout, isGroup);
        }
        if (data.clipsContent !== undefined)
            safeSet(node, "clipsContent", data.clipsContent);
        if (node.type === "TEXT" && data.characters !== undefined) {
            yield applyTextProperties(node, data);
        }
        if (node.type === "CONNECTOR") {
            applyConnectorProperties(node, data, true);
        }
    });
}
function recordRestoredNode(data, node) {
    const sourceId = data && typeof data.id === "string" ? data.id : "";
    if (sourceId && node && typeof node.id === "string")
        restoredNodeIdBySourceId[sourceId] = node.id;
}
function applyConnectorProperties(node, data, deferUnresolved) {
    var _a, _b;
    safeSet(node, "connectorLineType", data.connectorLineType || "ELBOWED");
    safeSet(node, "cornerRadius", (_a = data.connectorCornerRadius) !== null && _a !== void 0 ? _a : (_b = data.corner) === null || _b === void 0 ? void 0 : _b.cornerRadius);
    if (data.connectorStartStrokeCap) {
        safeSet(node, "connectorStartStrokeCap", normalizeConnectorStrokeCap(data.connectorStartStrokeCap));
    }
    if (data.connectorEndStrokeCap) {
        safeSet(node, "connectorEndStrokeCap", normalizeConnectorStrokeCap(data.connectorEndStrokeCap));
    }
    const start = normalizeConnectorEndpointForFigma(data.connectorStart, !deferUnresolved);
    const end = normalizeConnectorEndpointForFigma(data.connectorEnd, !deferUnresolved);
    if (start)
        safeSet(node, "connectorStart", start);
    if (end)
        safeSet(node, "connectorEnd", end);
    if (deferUnresolved && (hasUnresolvedConnectorEndpoint(data.connectorStart) || hasUnresolvedConnectorEndpoint(data.connectorEnd))) {
        deferredConnectorRestores.push({ node, data });
    }
}
function applyDeferredConnectorRestores() {
    if (deferredConnectorRestores.length === 0)
        return;
    const deferred = deferredConnectorRestores;
    deferredConnectorRestores = [];
    for (const item of deferred) {
        if (!item.node || item.node.removed)
            continue;
        applyConnectorProperties(item.node, item.data, false);
    }
}
function normalizeConnectorEndpointForFigma(endpoint, allowExistingFallback) {
    if (!endpoint || typeof endpoint !== "object")
        return null;
    const endpointNodeId = resolveConnectorEndpointNodeId(endpoint.endpointNodeId, allowExistingFallback);
    const position = normalizeConnectorPosition(endpoint.position);
    if (endpointNodeId) {
        const magnet = normalizeConnectorMagnet(endpoint.magnet);
        if (magnet)
            return { endpointNodeId, magnet };
        if (position)
            return { endpointNodeId, position };
        return { endpointNodeId, magnet: "AUTO" };
    }
    if (position)
        return { position };
    return null;
}
function normalizeConnectorPosition(position) {
    if (!position || typeof position !== "object")
        return null;
    return {
        x: Number(position.x) || 0,
        y: Number(position.y) || 0
    };
}
function createConnectorVectorNetworkFromData(data, parent) {
    const start = getConnectorLocalPoint(data, parent, true);
    const end = getConnectorLocalPoint(data, parent, false);
    const points = createConnectorRoutePoints(start, end, data.connectorStart, data.connectorEnd, data.connectorLineType || "ELBOWED");
    const vertices = points.map((point, index) => {
        var _a, _b, _c;
        const vertex = { x: point.x, y: point.y };
        if (index === 0)
            vertex.strokeCap = normalizeVectorStrokeCap(data.connectorStartStrokeCap || "NONE");
        if (index === points.length - 1)
            vertex.strokeCap = normalizeVectorStrokeCap(data.connectorEndStrokeCap || "NONE");
        if (index > 0 && index < points.length - 1) {
            const radius = getConnectorCornerRadius(points, index, (_c = (_a = data.connectorCornerRadius) !== null && _a !== void 0 ? _a : (_b = data.corner) === null || _b === void 0 ? void 0 : _b.cornerRadius) !== null && _c !== void 0 ? _c : 0);
            if (radius > 0)
                vertex.cornerRadius = radius;
        }
        return vertex;
    });
    const segments = [];
    for (let index = 0; index < points.length - 1; index++) {
        segments.push({ start: index, end: index + 1, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } });
    }
    return { vertices, segments, regions: [] };
}
function getConnectorLocalPoint(data, parent, isStart) {
    const localKey = isStart ? "connectorStartLocal" : "connectorEndLocal";
    const localPoint = normalizeConnectorPosition(data[localKey]);
    if (localPoint)
        return localPoint;
    const endpoint = isStart ? data.connectorStart : data.connectorEnd;
    const absolutePoint = normalizeConnectorPosition(endpoint && endpoint.position);
    if (absolutePoint && parent && data.layout) {
        const parentOrigin = getParentAbsoluteOrigin(parent);
        return {
            x: absolutePoint.x - parentOrigin.x - (Number(data.layout.x) || 0),
            y: absolutePoint.y - parentOrigin.y - (Number(data.layout.y) || 0)
        };
    }
    const layout = data.layout || {};
    return isStart
        ? { x: 0, y: 0 }
        : { x: Number(layout.width) || 0, y: Number(layout.height) || 0 };
}
function getParentAbsoluteOrigin(parent) {
    if (!parent || parent.type === "PAGE")
        return { x: 0, y: 0 };
    const transform = parent.absoluteTransform;
    if (transform && transform[0] && transform[1]) {
        return {
            x: Number(transform[0][2]) || 0,
            y: Number(transform[1][2]) || 0
        };
    }
    return {
        x: Number(parent.x) || 0,
        y: Number(parent.y) || 0
    };
}
function createConnectorRoutePoints(start, end, startEndpoint, endEndpoint, lineType) {
    const startPoint = normalizeConnectorPoint(start);
    const endPoint = normalizeConnectorPoint(end);
    if (lineType !== "ELBOWED" || isSameConnectorAxis(startPoint, endPoint))
        return dedupeConnectorPoints([startPoint, endPoint]);
    const horizontalFirst = shouldConnectorRouteStartHorizontal(startPoint, endPoint, startEndpoint, endEndpoint);
    const middlePoint = horizontalFirst
        ? { x: endPoint.x, y: startPoint.y }
        : { x: startPoint.x, y: endPoint.y };
    return dedupeConnectorPoints([startPoint, middlePoint, endPoint]);
}
function normalizeConnectorPoint(point) {
    return {
        x: Number(point && point.x) || 0,
        y: Number(point && point.y) || 0
    };
}
function isSameConnectorAxis(start, end) {
    return Math.abs(start.x - end.x) < 0.01 || Math.abs(start.y - end.y) < 0.01;
}
function shouldConnectorRouteStartHorizontal(start, end, startEndpoint, endEndpoint) {
    const startMagnet = startEndpoint && startEndpoint.magnet;
    if (startMagnet === "LEFT" || startMagnet === "RIGHT")
        return true;
    if (startMagnet === "TOP" || startMagnet === "BOTTOM")
        return false;
    const endMagnet = endEndpoint && endEndpoint.magnet;
    if (endMagnet === "TOP" || endMagnet === "BOTTOM")
        return true;
    if (endMagnet === "LEFT" || endMagnet === "RIGHT")
        return false;
    return Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
}
function dedupeConnectorPoints(points) {
    const result = [];
    for (const point of points) {
        const previous = result[result.length - 1];
        if (!previous || Math.abs(previous.x - point.x) >= 0.01 || Math.abs(previous.y - point.y) >= 0.01) {
            result.push(point);
        }
    }
    return result.length > 1 ? result : [points[0], points[points.length - 1]];
}
function getConnectorCornerRadius(points, index, requestedRadius) {
    const radius = Number(requestedRadius) || 0;
    if (radius <= 0)
        return 0;
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    const previousLength = Math.abs(current.x - previous.x) + Math.abs(current.y - previous.y);
    const nextLength = Math.abs(next.x - current.x) + Math.abs(next.y - current.y);
    return Math.min(radius, previousLength / 2, nextLength / 2);
}
function normalizeConnectorMagnet(value) {
    if (value === "TOP" || value === "LEFT" || value === "BOTTOM" || value === "RIGHT" || value === "NONE" || value === "AUTO") {
        return value;
    }
    return null;
}
function resolveConnectorEndpointNodeId(sourceId, allowExistingFallback) {
    if (typeof sourceId !== "string" || !sourceId)
        return null;
    if (restoredNodeIdBySourceId[sourceId])
        return restoredNodeIdBySourceId[sourceId];
    if (!allowExistingFallback)
        return null;
    try {
        const existing = figma.getNodeById(sourceId);
        if (existing && isSceneNode(existing))
            return existing.id;
    }
    catch (error) { }
    return null;
}
function hasUnresolvedConnectorEndpoint(endpoint) {
    return !!(endpoint && endpoint.endpointNodeId && !resolveConnectorEndpointNodeId(endpoint.endpointNodeId, false));
}
function normalizeConnectorStrokeCap(value) {
    if (value === "ARROW_EQUILATERAL" ||
        value === "ARROW_LINES" ||
        value === "TRIANGLE_FILLED" ||
        value === "DIAMOND_FILLED" ||
        value === "CIRCLE_FILLED" ||
        value === "NONE") {
        return value;
    }
    if (value === "LINE_ARROW" || value === "LINE")
        return "ARROW_LINES";
    if (value === "TRIANGLE_ARROW")
        return "ARROW_EQUILATERAL";
    if (value === "DIAMOND")
        return "DIAMOND_FILLED";
    if (value === "ROUND_ARROW" || value === "RING")
        return "CIRCLE_FILLED";
    return "NONE";
}
function normalizeImportAssets(assets) {
    const result = {};
    if (!assets || typeof assets !== "object")
        return result;
    for (const fileName in assets) {
        const bytes = normalizeBytes(assets[fileName]);
        if (bytes)
            result[fileName] = bytes;
    }
    return result;
}
function normalizeBytes(value) {
    if (!value)
        return null;
    if (value instanceof Uint8Array)
        return value;
    if (Array.isArray(value))
        return new Uint8Array(value);
    if (typeof value.length === "number")
        return new Uint8Array(value);
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
function normalizeImageFills(fills) {
    if (!Array.isArray(fills))
        return fills;
    return fills.map(fill => {
        if (!fill || fill.type !== "IMAGE")
            return fill;
        const imageHash = getImageHashForFill(fill);
        const result = {
            type: "IMAGE",
            scaleMode: fill.scaleMode || "FILL",
            imageHash
        };
        if (fill.visible !== undefined)
            result.visible = fill.visible;
        if (fill.opacity !== undefined)
            result.opacity = fill.opacity;
        if (fill.blendMode)
            result.blendMode = fill.blendMode;
        const filters = normalizeImageFilters(fill.filters);
        if (filters)
            result.filters = filters;
        if (fill.rotation !== undefined)
            result.rotation = fill.rotation;
        if (fill.imageTransform)
            result.imageTransform = fill.imageTransform;
        if (fill.scalingFactor !== undefined)
            result.scalingFactor = fill.scalingFactor;
        return result;
    });
}
function normalizeImageFilters(filters) {
    if (!filters || typeof filters !== "object")
        return null;
    const result = {};
    const allowed = ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"];
    for (const key of allowed) {
        if (typeof filters[key] === "number")
            result[key] = filters[key];
    }
    return Object.keys(result).length > 0 ? result : null;
}
function getImageHashForFill(fill) {
    const assetName = typeof fill.imageRef === "string" ? fill.imageRef : "";
    if (assetName && !fill.missingAsset) {
        const existingHash = imageHashByAssetName[assetName];
        if (existingHash)
            return existingHash;
        const bytes = activeImportAssets[assetName];
        if (bytes) {
            try {
                const image = figma.createImage(bytes);
                imageHashByAssetName[assetName] = image.hash;
                return image.hash;
            }
            catch (error) {
                console.warn("Unable to create Figma image from asset:", assetName, error);
            }
        }
    }
    recordMissingImageAsset(assetName || "missing-image.png");
    return getPlaceholderImageHash();
}
function recordMissingImageAsset(assetName) {
    if (missingImageAssetNames[assetName])
        return;
    missingImageAssetNames[assetName] = true;
    missingImageAssetCount++;
}
function getPlaceholderImageHash() {
    if (placeholderImageHash)
        return placeholderImageHash;
    const image = figma.createImage(new Uint8Array([
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
        0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
        0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0,
        5, 0, 1, 13, 10, 42, 180, 0, 0, 0, 0, 73, 69, 78, 68,
        174, 66, 96, 130
    ]));
    placeholderImageHash = image.hash;
    return image.hash;
}
function normalizeConstraints(value) {
    if (!value || typeof value !== "object")
        return value;
    const horizontal = normalizeConstraintType(value.horizontal);
    const vertical = normalizeConstraintType(value.vertical);
    if (!horizontal || !vertical)
        return undefined;
    return { horizontal, vertical };
}
function normalizeConstraintType(value) {
    if (value === "START" || value === "MIN")
        return "MIN";
    if (value === "END" || value === "MAX")
        return "MAX";
    if (value === "STARTANDEND" || value === "STRETCH")
        return "STRETCH";
    if (value === "CENTER" || value === "SCALE")
        return value;
    return undefined;
}
function normalizeLayoutMode(value) {
    if (value === "ROW")
        return "HORIZONTAL";
    if (value === "COLUMN")
        return "VERTICAL";
    return value;
}
function normalizeLayoutForParent(node, layout) {
    const offset = getGroupChildCanvasOffset(node, layout);
    if (!offset)
        return layout;
    const normalized = copyLayout(layout);
    normalized.x = (layout.x || 0) - offset.x;
    normalized.y = (layout.y || 0) - offset.y;
    if (layout.relativeTransform) {
        normalized.relativeTransform = cloneTransform(layout.relativeTransform);
        normalized.relativeTransform[0][2] -= offset.x;
        normalized.relativeTransform[1][2] -= offset.y;
    }
    return normalized;
}
function getGroupChildCanvasOffset(node, layout) {
    const parent = node.parent;
    if (!parent || parent.type !== "GROUP" || !layout)
        return null;
    if (layout.x === undefined || layout.y === undefined)
        return null;
    const ancestor = findNearestPositionedAncestor(parent);
    if (!ancestor)
        return null;
    const ancestorTransform = ancestor.absoluteTransform || ancestor.relativeTransform;
    if (!ancestorTransform)
        return null;
    const offset = { x: ancestorTransform[0][2] || 0, y: ancestorTransform[1][2] || 0 };
    if (isNearlyZero(offset.x) && isNearlyZero(offset.y))
        return null;
    const normalizedX = layout.x - offset.x;
    const normalizedY = layout.y - offset.y;
    if (!isGroupChildOffsetImprovement(parent, layout.x, layout.y, normalizedX, normalizedY))
        return null;
    return offset;
}
function findNearestPositionedAncestor(group) {
    let ancestor = group.parent;
    while (ancestor && ancestor.type !== "PAGE" && ancestor.type !== "DOCUMENT") {
        if (ancestor.type !== "GROUP")
            return ancestor;
        ancestor = ancestor.parent;
    }
    return null;
}
function isGroupChildOffsetImprovement(parent, x, y, normalizedX, normalizedY) {
    const restoredLayout = restoredLayoutByNodeId[parent.id] || {};
    const width = Math.max(restoredLayout.width || parent.width || 0, 1);
    const height = Math.max(restoredLayout.height || parent.height || 0, 1);
    const currentScore = groupChildBoundsDistance(x, y, width, height);
    const normalizedScore = groupChildBoundsDistance(normalizedX, normalizedY, width, height);
    return normalizedScore < currentScore && currentScore > 0;
}
function groupChildBoundsDistance(x, y, width, height) {
    return axisBoundsDistance(x, width) + axisBoundsDistance(y, height);
}
function axisBoundsDistance(value, size) {
    if (value < -size)
        return -size - value;
    if (value > size * 2)
        return value - size * 2;
    return 0;
}
function copyLayout(layout) {
    const copy = {};
    for (const key in layout)
        copy[key] = layout[key];
    return copy;
}
function cloneTransform(transform) {
    return [
        [transform[0][0], transform[0][1], transform[0][2]],
        [transform[1][0], transform[1][1], transform[1][2]]
    ];
}
function normalizeAxisAlign(value) {
    if (value === "START" || value === "FLEX_START")
        return "MIN";
    if (value === "END" || value === "FLEX_END")
        return "MAX";
    if (value === "SPACING_BETWEEN")
        return "SPACE_BETWEEN";
    return value;
}
function normalizeAxisSizingMode(value) {
    if (value === "HUG")
        return "AUTO";
    if (value === "FILL")
        return "FIXED";
    return value;
}
function normalizeLayoutAlign(value) {
    if (value === "STRETCH" || value === "INHERIT")
        return value;
    return normalizeAxisAlign(value);
}
function applySingleChildAutoSpaceAlignmentFix(node, layout) {
    if (!isAutoSpaceAlongPrimaryAxis(layout))
        return;
    if (getRestorableChildCount(node) !== 1)
        return;
    // IMPORTANT: MasterGo and Figma handle "auto" spacing differently when an
    // auto-layout container has exactly one child. MasterGo keeps that child at
    // the start of the primary axis (left in horizontal layout, top in vertical
    // layout), while Figma centers it for SPACE_BETWEEN. Force MIN here so the
    // restored layout preserves MasterGo's visual result.
    safeSet(node, "primaryAxisAlignItems", "MIN");
}
function applyDeferredSingleChildAutoSpaceAlignmentFixes(root) {
    if (!("children" in root))
        return;
    const children = [...root.children];
    for (const child of children) {
        applyDeferredSingleChildAutoSpaceAlignmentFixes(child);
    }
    if (!isSceneNode(root))
        return;
    const layout = restoredLayoutByNodeId[root.id];
    if (!layout || !hasAutoLayout(root))
        return;
    applySingleChildAutoSpaceAlignmentFix(root, layout);
}
function isAutoSpaceAlongPrimaryAxis(layout) {
    return normalizeAxisAlign(layout.primaryAxisAlignItems) === "SPACE_BETWEEN" ||
        normalizeAxisAlign(layout.mainAxisAlignItems) === "SPACE_BETWEEN";
}
function getRestorableChildCount(node) {
    if (!("children" in node))
        return 0;
    return [...node.children].filter((child) => {
        return !child.name.startsWith(INTERNAL_PROPS_PREFIX) && !child.name.startsWith(SIBLING_PROPS_PREFIX);
    }).length;
}
function hasAutoLayout(node) {
    return "layoutMode" in node && node.layoutMode !== "NONE";
}
function hasAutoLayoutParent(node) {
    const parent = node.parent;
    return !!parent && "layoutMode" in parent && parent.layoutMode !== "NONE";
}
function shouldRestoreFixedSize(node, layout) {
    if (!hasAutoLayout(node))
        return true;
    const primarySizing = normalizeAxisSizingMode(layout.primaryAxisSizingMode || node.primaryAxisSizingMode);
    const counterSizing = normalizeAxisSizingMode(layout.counterAxisSizingMode || node.counterAxisSizingMode);
    return primarySizing === "FIXED" || counterSizing === "FIXED";
}
function applyAspectRatioLock(node, shouldLock) {
    if (typeof node.lockAspectRatio === "function" && typeof node.unlockAspectRatio === "function") {
        try {
            if (shouldLock) {
                node.lockAspectRatio();
            }
            else if (node.targetAspectRatio) {
                node.unlockAspectRatio();
            }
        }
        catch (e) { }
        return;
    }
}
function applyVectorNetwork(node, vectorNetwork, data) {
    const normalized = normalizeVectorNetworkForFigma(vectorNetwork);
    try {
        node.vectorNetwork = normalized;
        return;
    }
    catch (error) {
        console.warn("Unable to set vectorNetwork, retrying without vertex stroke caps/corner radii:", (data === null || data === void 0 ? void 0 : data.name) || (data === null || data === void 0 ? void 0 : data.id) || "Untitled", error);
    }
    try {
        node.vectorNetwork = stripVectorNetworkVertexExtras(normalized);
    }
    catch (fallbackError) {
        console.warn("Unable to set fallback vectorNetwork:", (data === null || data === void 0 ? void 0 : data.name) || (data === null || data === void 0 ? void 0 : data.id) || "Untitled", fallbackError);
    }
}
function normalizeVectorNetworkForFigma(vectorNetwork) {
    if (!vectorNetwork || typeof vectorNetwork !== "object")
        return vectorNetwork;
    const result = {};
    for (const key in vectorNetwork)
        result[key] = vectorNetwork[key];
    if (Array.isArray(vectorNetwork.vertices)) {
        result.vertices = vectorNetwork.vertices.map((vertex) => {
            if (!vertex || typeof vertex !== "object")
                return vertex;
            const next = {};
            for (const key in vertex)
                next[key] = vertex[key];
            if (next.strokeCap !== undefined)
                next.strokeCap = normalizeVectorStrokeCap(next.strokeCap);
            return next;
        });
    }
    if (Array.isArray(vectorNetwork.segments)) {
        result.segments = vectorNetwork.segments.map((segment) => {
            if (!segment || typeof segment !== "object")
                return segment;
            const next = {};
            for (const key in segment)
                next[key] = segment[key];
            return next;
        });
    }
    if (Array.isArray(vectorNetwork.regions)) {
        result.regions = vectorNetwork.regions.map((region) => {
            if (!region || typeof region !== "object")
                return region;
            const next = {};
            for (const key in region)
                next[key] = region[key];
            next.windingRule = normalizeVectorWindingRule(next.windingRule);
            if (Array.isArray(region.loops)) {
                next.loops = region.loops.map((loop) => {
                    if (!Array.isArray(loop))
                        return loop;
                    return loop
                        .map((value) => Number(value))
                        .filter((value) => Number.isFinite(value));
                });
            }
            return next;
        });
    }
    return result;
}
function normalizeVectorWindingRule(value) {
    if (value === "Evenodd" || value === "EVENODD")
        return "EVENODD";
    if (value === "Nonzero" || value === "NONZERO")
        return "NONZERO";
    return "NONZERO";
}
function stripVectorNetworkVertexExtras(vectorNetwork) {
    if (!vectorNetwork || typeof vectorNetwork !== "object" || !Array.isArray(vectorNetwork.vertices))
        return vectorNetwork;
    const result = {};
    for (const key in vectorNetwork)
        result[key] = vectorNetwork[key];
    result.vertices = vectorNetwork.vertices.map((vertex) => {
        if (!vertex || typeof vertex !== "object")
            return vertex;
        const next = {};
        for (const key in vertex) {
            if (key !== "strokeCap" && key !== "cornerRadius")
                next[key] = vertex[key];
        }
        return next;
    });
    return result;
}
function normalizeVectorStrokeCap(value) {
    if (value === "NONE" ||
        value === "ROUND" ||
        value === "SQUARE" ||
        value === "ARROW_LINES" ||
        value === "ARROW_EQUILATERAL" ||
        value === "DIAMOND_FILLED" ||
        value === "TRIANGLE_FILLED" ||
        value === "CIRCLE_FILLED") {
        return value;
    }
    if (value === "LINE_ARROW" || value === "LINE")
        return "ARROW_LINES";
    if (value === "TRIANGLE_ARROW")
        return "ARROW_EQUILATERAL";
    if (value === "DIAMOND")
        return "DIAMOND_FILLED";
    if (value === "ROUND_ARROW" || value === "RING")
        return "CIRCLE_FILLED";
    return "NONE";
}
function normalizeEffectsForNode(node, effects) {
    if (!Array.isArray(effects))
        return effects;
    if (supportsEffectSpread(node))
        return effects;
    return effects.map(effect => {
        if (!effect || (effect.type !== "DROP_SHADOW" && effect.type !== "INNER_SHADOW") || effect.spread === undefined) {
            return effect;
        }
        const copy = {};
        for (const key in effect) {
            if (key !== "spread")
                copy[key] = effect[key];
        }
        return copy;
    });
}
function supportsEffectSpread(node) {
    return node.type === "FRAME" ||
        node.type === "COMPONENT" ||
        node.type === "COMPONENT_SET" ||
        node.type === "INSTANCE" ||
        node.type === "RECTANGLE";
}
function safeSet(node, property, value) {
    if (value === undefined || !(property in node))
        return;
    try {
        if (isPrimitiveValue(value) && valuesAreEqual(node[property], value)) {
            if (activeRestoreStats)
                activeRestoreStats.safeSetSkipCount++;
            return;
        }
        node[property] = value;
        if (activeRestoreStats)
            activeRestoreStats.safeSetWriteCount++;
    }
    catch (e) { }
}
function isPrimitiveValue(value) {
    return value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean";
}
function valuesAreEqual(current, next) {
    return current === next ||
        (typeof current === "number" && typeof next === "number" && Number.isNaN(current) && Number.isNaN(next));
}
function safeSetFills(node, fills) {
    if (!("fills" in node))
        return;
    try {
        node.fills = fills;
    }
    catch (error) {
        console.warn("Unable to set fills:", node.name, error, fills);
        const fallbackFills = stripImageFillExtras(fills);
        try {
            node.fills = fallbackFills;
        }
        catch (fallbackError) {
            console.warn("Unable to set fallback fills:", node.name, fallbackError, fallbackFills);
        }
    }
}
function stripImageFillExtras(fills) {
    if (!Array.isArray(fills))
        return fills;
    return fills.map(fill => {
        if (!fill || fill.type !== "IMAGE")
            return fill;
        return {
            type: "IMAGE",
            scaleMode: fill.scaleMode || "FILL",
            imageHash: fill.imageHash,
            visible: fill.visible,
            opacity: fill.opacity,
            blendMode: fill.blendMode
        };
    });
}
function safeResize(node, width, height) {
    try {
        if (isNearlyEqual(Number(node.width), width) && isNearlyEqual(Number(node.height), height)) {
            if (activeRestoreStats)
                activeRestoreStats.resizeSkipCount++;
            return;
        }
        if (typeof node.resize === "function") {
            node.resize(width, height);
            if (activeRestoreStats)
                activeRestoreStats.resizeWriteCount++;
        }
        else if (typeof node.resizeWithoutConstraints === "function") {
            node.resizeWithoutConstraints(width, height);
            if (activeRestoreStats)
                activeRestoreStats.resizeWriteCount++;
        }
    }
    catch (e) { }
}
function applyTextProperties(node, data) {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function* () {
        if (activeRestoreStats)
            activeRestoreStats.textNodeCount++;
        yield ensureAvailableFontsLoaded();
        const family = ((_a = data.fontName) === null || _a === void 0 ? void 0 : _a.family) || "Inter";
        const style = ((_b = data.fontName) === null || _b === void 0 ? void 0 : _b.style) || "Regular";
        const requestedFontName = { family, style };
        const resolvedFontName = resolveAvailableFontName(requestedFontName);
        const isFontExist = !!resolvedFontName;
        yield loadFontCached({ family: "Inter", style: "Regular" });
        if (resolvedFontName)
            yield loadFontCached(resolvedFontName);
        else
            node.name = "[Font Missing][" + family + "][" + style + "] " + node.name;
        node.textAlignHorizontal = data.textAlignHorizontal || "LEFT";
        node.textAlignVertical = data.textAlignVertical || "TOP";
        node.textAutoResize = data.textAutoResize || "NONE";
        node.paragraphIndent = data.paragraphIndent || 0;
        node.paragraphSpacing = data.paragraphSpacing || 0;
        node.autoRename = data.autoRename || false;
        node.fontSize = data.fontSize || 12;
        node.fontName = resolvedFontName || { family: "Inter", style: "Regular" };
        node.characters = data.characters || "";
        if (data.textCase)
            node.textCase = data.textCase;
        if (data.textDecoration)
            node.textDecoration = data.textDecoration;
        if (data.letterSpacing !== undefined)
            node.letterSpacing = data.letterSpacing;
        if (data.lineHeight !== undefined)
            node.lineHeight = data.lineHeight;
    });
}
function restoreMissingFontTextLayers(pages) {
    return __awaiter(this, void 0, void 0, function* () {
        const result = {
            scannedTextNodeCount: 0,
            candidateTextNodeCount: 0,
            restoredTextNodeCount: 0,
            failedTextNodeCount: 0,
            loadedFontCount: 0,
            failedFontCount: 0
        };
        const targets = [];
        yield ensureAvailableFontsLoaded();
        for (const page of pages) {
            const textNodes = page.findAll(node => node.type === "TEXT");
            result.scannedTextNodeCount += textNodes.length;
            for (const node of textNodes) {
                const parsed = parseMissingFontTextLayerName(node.name);
                if (!parsed)
                    continue;
                const requestedFontName = { family: parsed.family, style: parsed.style };
                const resolvedFontName = resolveAvailableFontName(requestedFontName);
                targets.push({
                    node,
                    requestedFontName,
                    resolvedFontName,
                    restoredName: parsed.restoredName,
                    requestedFontKey: getFontKey(parsed.family, parsed.style),
                    resolvedFontKey: resolvedFontName ? getFontKey(resolvedFontName.family, resolvedFontName.style) : ""
                });
            }
        }
        result.candidateTextNodeCount = targets.length;
        if (targets.length === 0)
            return result;
        logMissingFontRestoreTargets(targets);
        const fontLoadState = new Map();
        for (const target of targets) {
            if (!target.resolvedFontName) {
                result.failedTextNodeCount++;
                continue;
            }
            if (!fontLoadState.has(target.resolvedFontKey)) {
                try {
                    yield loadFontCached(target.resolvedFontName);
                    fontLoadState.set(target.resolvedFontKey, true);
                    result.loadedFontCount++;
                }
                catch (error) {
                    fontLoadState.set(target.resolvedFontKey, false);
                    result.failedFontCount++;
                    console.warn("Unable to restore missing font:", {
                        requested: target.requestedFontName,
                        resolved: target.resolvedFontName
                    }, error);
                }
            }
            if (!fontLoadState.get(target.resolvedFontKey)) {
                result.failedTextNodeCount++;
                continue;
            }
            try {
                target.node.fontName = target.resolvedFontName;
                target.node.name = target.restoredName;
                result.restoredTextNodeCount++;
            }
            catch (error) {
                result.failedTextNodeCount++;
                console.warn("Unable to apply restored font:", target.node.name, {
                    requested: target.requestedFontName,
                    resolved: target.resolvedFontName
                }, error);
            }
        }
        console.log("[MasterGo2Figma] Missing font restore", result);
        return result;
    });
}
function parseMissingFontTextLayerName(name) {
    const match = MISSING_FONT_NAME_PREFIX_PATTERN.exec(name);
    if (!match)
        return null;
    return {
        family: match[1],
        style: match[2],
        restoredName: name.slice(match[0].length)
    };
}
function resolveAvailableFontName(requested) {
    if (availableFontKeys[getFontKey(requested.family, requested.style)])
        return requested;
    let bestMatch = null;
    for (const font of documentFonts) {
        const fontName = font.fontName;
        const familyScore = getFontFamilyMatchScore(requested.family, fontName.family);
        if (familyScore <= 0)
            continue;
        const styleScore = getFontStyleMatchScore(requested.style, fontName.style);
        if (styleScore <= 0)
            continue;
        const score = familyScore + styleScore;
        if (!bestMatch || score > bestMatch.score) {
            bestMatch = { fontName, score };
        }
    }
    return bestMatch ? bestMatch.fontName : null;
}
function getFontFamilyMatchScore(requestedFamily, availableFamily) {
    const requested = normalizeFontFamilyForMatch(requestedFamily);
    const available = normalizeFontFamilyForMatch(availableFamily);
    if (!requested || !available)
        return 0;
    if (requested === available)
        return 100;
    if (available.indexOf(requested) === 0 || requested.indexOf(available) === 0)
        return 80;
    return 0;
}
function getFontStyleMatchScore(requestedStyle, availableStyle) {
    const requested = normalizeFontStyleForMatch(requestedStyle);
    const available = normalizeFontStyleForMatch(availableStyle);
    if (!requested || !available)
        return 0;
    if (requested === available)
        return 50;
    return 0;
}
function normalizeFontFamilyForMatch(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[\s_-]+/g, "")
        .replace(/[^a-z0-9]/g, "");
}
function normalizeFontStyleForMatch(value) {
    const normalized = String(value || "")
        .toLowerCase()
        .replace(/[\s_-]+/g, "")
        .replace(/[^a-z0-9]/g, "");
    const aliases = {
        normal: "regular",
        book: "regular",
        roman: "regular",
        regular: "regular",
        400: "regular",
        medium: "medium",
        500: "medium",
        semibold: "semibold",
        demibold: "semibold",
        600: "semibold",
        bold: "bold",
        700: "bold",
        heavy: "heavy",
        black: "black",
        900: "black",
        light: "light",
        300: "light",
        extralight: "extralight",
        ultralight: "extralight",
        200: "extralight",
        thin: "thin",
        100: "thin"
    };
    return aliases[normalized] || normalized;
}
function logMissingFontRestoreTargets(targets) {
    const requestedToResolved = {};
    for (const target of targets) {
        if (!requestedToResolved[target.requestedFontKey]) {
            requestedToResolved[target.requestedFontKey] = {
                requested: target.requestedFontName,
                resolved: target.resolvedFontName,
                count: 0
            };
        }
        requestedToResolved[target.requestedFontKey].count++;
    }
    const resolutions = Object.keys(requestedToResolved).map(key => requestedToResolved[key]);
    console.log("[MasterGo2Figma] Missing font restore targets", resolutions);
    for (const item of resolutions) {
        if (item.resolved)
            continue;
        console.warn("[MasterGo2Figma] No available font match for missing font", {
            requested: item.requested,
            nearbyAvailableFonts: getNearbyAvailableFontsForLog(item.requested)
        });
    }
}
function getNearbyAvailableFontsForLog(requested) {
    const requestedFamily = normalizeFontFamilyForMatch(requested.family);
    const nearby = [];
    for (const font of documentFonts) {
        const family = normalizeFontFamilyForMatch(font.fontName.family);
        if (family.indexOf(requestedFamily) !== -1 ||
            requestedFamily.indexOf(family) !== -1 ||
            familiesShareWords(requested.family, font.fontName.family)) {
            nearby.push(font.fontName);
        }
        if (nearby.length >= 20)
            break;
    }
    return nearby;
}
function familiesShareWords(left, right) {
    const leftWords = splitFontFamilyWords(left);
    const rightWords = splitFontFamilyWords(right);
    let sharedCount = 0;
    for (const word of leftWords) {
        if (rightWords.indexOf(word) !== -1)
            sharedCount++;
    }
    return sharedCount >= Math.min(2, leftWords.length, rightWords.length);
}
function splitFontFamilyWords(value) {
    return String(value || "")
        .toLowerCase()
        .split(/[\s_-]+/)
        .filter(Boolean);
}
function ensureAvailableFontsLoaded() {
    return __awaiter(this, void 0, void 0, function* () {
        if (documentFonts.length === 0) {
            if (activeRestoreStats)
                activeRestoreStats.fontListLoadCount++;
            documentFonts = yield figma.listAvailableFontsAsync();
            rebuildAvailableFontIndex();
            return;
        }
        if (Object.keys(availableFontKeys).length === 0) {
            rebuildAvailableFontIndex();
        }
    });
}
function rebuildAvailableFontIndex() {
    availableFontKeys = {};
    for (const font of documentFonts) {
        availableFontKeys[getFontKey(font.fontName.family, font.fontName.style)] = true;
    }
}
function getFontKey(family, style) {
    return `${family}\n${style}`;
}
function loadFontCached(fontName) {
    return __awaiter(this, void 0, void 0, function* () {
        const key = getFontKey(fontName.family, fontName.style);
        const existing = fontLoadPromises[key];
        if (existing) {
            if (activeRestoreStats)
                activeRestoreStats.fontLoadCacheHitCount++;
            yield existing;
            return;
        }
        if (activeRestoreStats)
            activeRestoreStats.fontLoadRequestCount++;
        const promise = figma.loadFontAsync(fontName).catch(error => {
            delete fontLoadPromises[key];
            if (activeRestoreStats)
                activeRestoreStats.fontLoadFailureCount++;
            throw error;
        });
        fontLoadPromises[key] = promise;
        yield promise;
    });
}
