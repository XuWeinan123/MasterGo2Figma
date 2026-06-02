/// <reference types="@mastergo/plugin-typings" />

let totalNodes = 0;
let processedNodes = 0;
let loadingNotify: NotificationHandler | null = null;
let lastNotifyAt = 0;
let exportInProgress = false;

const DEBUG_LOGGING_PAGE_INDEX_START = 9999; // Keep verbose DFS logging disabled unless explicitly lowered for diagnostics.
let isVerboseLoggingActive = false;

function logDebug(message: string, ...args: any[]) {
    if (isVerboseLoggingActive) {
        console.log(`[MasterGo2Figma] [DEBUG] ${message}`, ...args);
    }
}

const INTERNAL_PROPS_PREFIX = "[PROPS]";
const SIBLING_PROPS_PREFIX = "[PROPS_SIBLING]";
const LAYER_RULES_SCHEMA = "mastergo2figma.layer-conversion-rules.v1";
const EXPORT_QUEUE_CACHE_KEY = "mastergo2figma.export-queue.v1";

const COMMAND_ALL_PAGES = "all-pages";
const COMMAND_SELECTED = "selected";
const COMMAND_CURRENT_PAGE = "current-page";
const COMMAND_PARTIAL_PAGES = "partial-pages";
const TRANSFER_MODE_DIRECT_ZIP = "direct-zip";
const TRANSFER_MODE_LOCAL_JSON_STREAM = "local-json-stream";
const EXPORT_TARGET_ZIP = "zip";
const EXPORT_TARGET_LOCAL_RELAY = "local-relay";
const ENABLE_IMAGE_EXPORT = true;
const ENABLE_SPLIT_EXPORT = true;
const EXPORT_TRANSFER_CHUNK_SIZE = 64 * 1024;
const EXPORT_TEXT_CHUNK_CHAR_LIMIT = 4 * 1024;
const EXPORT_TRANSFER_YIELD_EVERY_CHUNKS = 32;
const SEND_TEXT_CHUNKS_AS_BYTES = true;
const LAYER_CHUNK_MAX_RECORDS = 16;
const LAYER_CHUNK_MAX_BYTES = 64 * 1024;
const LAYER_CHUNK_LOG_BYTES = 48 * 1024;
const EXPORT_PROGRESS_EVERY_LAYERS = 100;
const EXPORT_PROGRESS_TIME_INTERVAL_MS = 200;
const EXPORT_SCAN_YIELD_EVERY_NODES = 500;
const STRINGIFY_PROBE_VERTEX_THRESHOLD = 1000;
const STRINGIFY_PROBE_CHILD_THRESHOLD = 300;
const STRINGIFY_RECORD_WARN_BYTES = 48 * 1024;
const SVG_FALLBACK_MAX_DOCUMENT_NODES = 5000;
const SVG_FALLBACK_MAX_NODES = 48;
const SVG_FALLBACK_MAX_DIMENSION = 256;
const SVG_FALLBACK_MAX_AREA = 64 * 1024;
const SVG_FALLBACK_MAX_BYTES = 64 * 1024;
const PAGE_SEGMENT_TARGET_LAYERS = 8000;
const MAX_PAGES_PER_BATCH = 1;

type ExportScope = "selected" | "current-page" | "partial-pages" | "all-pages";
type ExportTransferMode = "direct-zip" | "local-json-stream";
type ExportTransferTarget = "zip" | "local-relay";

type ExportOptions = {
    scope: ExportScope;
    pageIds: string[];
    transferMode: ExportTransferMode;
    relayUrl?: string;
    autoContinue?: boolean;
    sessionId?: string;
    batchIndex?: number;
    batchTotal?: number;
};

type PendingExportQueue = {
    pageIds: string[];
    createdAt: string;
    updatedAt: string;
};

type PreparedExportRun = {
    options: ExportOptions;
    remainingPageIds: string[];
    limitedToSinglePage: boolean;
};

type ExportFile = {
    path: string;
    content?: string;
    contentParts?: string[];
    bytes?: Uint8Array;
};

type ExportTransferFileKind = "content" | "bytes";

type SendStrategy = "text" | "penNetwork" | "flattenBoolean" | "booleanTree" | "frameLike" | "groupLike" | "ellipseArc" | "star" | "polygon" | "connector" | "universalOnly";

type ReceiveCreateType = "VECTOR" | "ELLIPSE" | "RECTANGLE" | "STAR" | "LINE" | "POLYGON" | "TEXT" | "SECTION" | "SLICE" | "FRAME" | "GROUP" | "CONNECTOR" | "BOOLEAN_OPERATION";

type LayerConversionRule = {
    sourceType: string;
    restoreType: string;
    sendStrategy: SendStrategy;
    receiveCreate: ReceiveCreateType;
    isContainer: boolean;
    visualFrameSource: boolean;
};

type LayerConversionConfig = {
    schema: typeof LAYER_RULES_SCHEMA;
    version: number;
    rules: { [sourceType: string]: LayerConversionRule };
};

type CachedLayerConversionRules = {
    config: LayerConversionConfig;
    fileName: string;
    importedAt: string;
};

const DEFAULT_LAYER_CONVERSION_CONFIG: LayerConversionConfig = {
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

type ExportManifestPage = {
    id: string;
    name: string;
    folder: string;
    pageFile: string;
    layerCount: number;
};

type ExportManifestAsset = {
    key: string;
    fileName: string;
    path: string;
    missing?: boolean;
};

type ExportManifest = {
    schema: "mastergo2figma.package.v2";
    version: 2;
    source: "mastergo";
    documentId: number;
    exportedAt: string;
    scope: ExportScope;
    pages: ExportManifestPage[];
    assets: { [key: string]: ExportManifestAsset };
    stats: {
        pageCount: number;
        layerCount: number;
        imageAssetCount: number;
        missingImageAssetCount: number;
    };
};

type ExportPageIndex = {
    schema: "mastergo2figma.page.v2";
    version: 2;
    id: string;
    name: string;
    folder: string;
    rootNodeIds: string[];
    layerChunks: string[];
    layerCount: number;
};

type LayerChunkAccumulator = {
    pageId: string;
    pageFolder: string;
    chunkIndex: number;
    recordJsons: string[];
    bytes: number;
    writtenNodeIds: { [id: string]: true };
};

type ExportTransferState = {
    transferId: string;
    filename: string;
    fileIndex: number;
    postedChunks: number;
    streamedBytes: number;
    target: ExportTransferTarget;
    relayUrl?: string;
};

type ExportTransferAck = {
    transferId: string;
    success: boolean;
    filename?: string;
    error?: string;
    pendingCount?: number;
};

type ExportTransferAckResolver = {
    resolve: (ack: ExportTransferAck) => void;
    reject: (error: Error) => void;
    timeoutId: number;
};

type ExportFileAck = {
    transferId: string;
    index: number;
    success: boolean;
    path?: string;
    error?: string;
    pendingCount?: number;
};

type ExportFileAckResolver = {
    resolve: (ack: ExportFileAck) => void;
    reject: (error: Error) => void;
    timeoutId: number;
    path: string;
};

type ExportPerformanceStats = {
    startedAt: number;
    scope: ExportScope;
    transferMode: ExportTransferMode;
    sessionId: string;
    autoContinue: boolean;
    batchIndex: number;
    batchTotal: number;
    pageCount: number;
    rootCount: number;
    totalNodes: number;
    processedNodes: number;
    scanMs: number;
    exportMs: number;
    assetMs: number;
    manifestMs: number;
    ackMs: number;
    files: number;
    chunks: number;
    bytes: number;
    layerChunkFiles: number;
    layerRecords: number;
    splitPackages: number;
    imageAssets: number;
    missingImageAssets: number;
    progressPosts: number;
    progressYields: number;
};

type ExportProgressState = {
    lastCurrent: number;
    lastPostedAt: number;
};

type PageExportTarget = {
    page: PageNode;
    nodes?: SceneNode[];
};

type NodeComplexitySnapshot = {
    id: string;
    name: string;
    type: string;
    sourceType?: string;
    restoreType?: string;
    width?: number;
    height?: number;
    childCount?: number;
    rawChildCount?: number;
    textLength?: number;
    fillCount?: number;
    strokeCount?: number;
    effectCount?: number;
    vectorNetwork?: {
        vertices?: number;
        segments?: number;
        regions?: number;
        loops?: number;
    };
};

type ExportDebugState = {
    phase: string;
    page?: string;
    node?: string;
    nodeComplexity?: NodeComplexitySnapshot;
    parentId?: string | null;
    nodeIndex?: number;
    file?: string;
    transferId?: string;
    fileIndex?: number;
    chunkIndex?: number;
    fileSize?: number;
    streamedBytes?: number;
    processedNodes?: number;
    totalNodes?: number;
};

let cachedLayerRules: CachedLayerConversionRules | null = {
    config: DEFAULT_LAYER_CONVERSION_CONFIG,
    fileName: "内置转换规则",
    importedAt: ""
};
let layerRulesBySourceType: { [sourceType: string]: LayerConversionRule } | null = createLayerRuleIndex(DEFAULT_LAYER_CONVERSION_CONFIG);
let layerRulesLoadPromise: Promise<void> | null = null;
let activeImageAssetContext: ImageAssetContext | null = null;
let exportTransferAckResolvers: { [transferId: string]: ExportTransferAckResolver } = {};
let exportFileAckResolvers: { [key: string]: ExportFileAckResolver } = {};
let exportDebugState: ExportDebugState = { phase: "idle" };
let activeExportStats: ExportPerformanceStats | null = null;
let activeExportProgress: ExportProgressState | null = null;

type ImageAssetRecord = {
    key: string;
    sourceRef: string;
    index: number;
    fileName: string;
    path: string;
    bytes: Uint8Array | null;
    missing: boolean;
};

type ImageAssetContext = {
    bySourceRef: { [sourceRef: string]: ImageAssetRecord };
    assets: ImageAssetRecord[];
    missingImageAssetCount: number;
};

try {
    showPluginUI();
} catch (error) {
    console.error("Unable to open SendToFigma plugin UI:", error);
    try {
        mg.notify("插件界面打开失败，请查看控制台", {
            position: "bottom",
            timeout: 3000,
            type: "error"
        });
    } catch (_) {
        // Ignore notify failures while the host is already failing to open.
    }
}

function showPluginUI() {
    mg.ui.onmessage = async (rawMessage) => {
        const message = unwrapUIMessage(rawMessage);
        if (!message || typeof message !== "object") return;

        if (message.type === "ui-ready") {
            await safePostInitUI();
            return;
        }

        if (message.type === "close") {
            mg.closePlugin();
            return;
        }

        if (message.type === "export-transfer-finished") {
            resolveExportTransferAck(message);
            return;
        }

        if (message.type === "export-file-finished") {
            resolveExportFileAck(message);
            return;
        }

        if (message.type === "test-main-fetch-relay") {
            await testMainRelayFetch(typeof message.relayUrl === "string" ? message.relayUrl : "");
            return;
        }

        if (message.type !== "start-export") return;
        if (exportInProgress) return;

        const options: ExportOptions = {
            scope: normalizeScope(message.scope),
            pageIds: Array.isArray(message.pageIds) ? message.pageIds : [],
            transferMode: normalizeTransferMode(message.transferMode),
            relayUrl: typeof message.relayUrl === "string" ? message.relayUrl : undefined,
            autoContinue: message.autoContinue === true,
            sessionId: typeof message.sessionId === "string" ? message.sessionId : undefined,
            batchIndex: typeof message.batchIndex === "number" ? message.batchIndex : undefined,
            batchTotal: typeof message.batchTotal === "number" ? message.batchTotal : undefined
        };

        exportInProgress = true;
        try {
            const prepared = await prepareExportRun(options);
            logDiagnostic("log", "[MasterGo2Figma] Export queue plan", createPreparedExportLog(options, prepared));
            await savePendingExportQueueForRecovery(prepared);
            logDiagnostic("log", "[MasterGo2Figma] Export batch start", createPreparedExportLog(options, prepared));
            const success = await runWithUI(prepared.options);
            if (success) {
                logDiagnostic("log", "[MasterGo2Figma] Export batch complete", createPreparedExportLog(options, prepared));
                await updatePendingExportQueue(prepared);
            } else if (prepared.remainingPageIds.length > 0) {
                logDiagnostic("warn", "[MasterGo2Figma] Export queue not advanced because current run failed", {
                    sessionId: prepared.options.sessionId,
                    batchIndex: prepared.options.batchIndex,
                    batchTotal: prepared.options.batchTotal,
                    remainingPageCount: prepared.remainingPageIds.length,
                    remainingPages: summarizePageIds(prepared.remainingPageIds.slice(0, 5)),
                    debugState: exportDebugState
                });
            }
        } catch (error) {
            logDiagnostic("error", "[MasterGo2Figma] Export run failed before completion", {
                error: describeError(error),
                debugState: exportDebugState
            });
            postUI({
                type: "error",
                message: error instanceof Error ? error.message : "导出失败，请查看控制台"
            });
        } finally {
            exportInProgress = false;
        }
    };

    openPluginUI();
    startLayerRulesLoad();
}

function openPluginUI() {
    try {
        mg.showUI(__html__, { width: 400, height: 1000 });
    } catch (error) {
        console.warn("Unable to open preferred SendToFigma UI size, retrying with compact size:", error);
        mg.showUI(__html__, { width: 400, height: 1000 });
    }
}

function unwrapUIMessage(rawMessage: any) {
    if (rawMessage && rawMessage.pluginMessage) return rawMessage.pluginMessage;
    return rawMessage;
}

async function testMainRelayFetch(rawRelayUrl: string) {
    const relayUrl = normalizeRelayUrl(rawRelayUrl);
    postUI({
        type: "main-relay-test-result",
        ok: false,
        relayUrl,
        fetchAvailable: false,
        elapsedMs: 0,
        error: "MasterGo 插件主线程沙盒中没有内置 fetch API，请通过 UI 线程进行请求。"
    });
}

function normalizeRelayUrl(value: string) {
    const text = String(value || "").trim() || "http://127.0.0.1:8765";
    return text.replace(/\/+$/, "");
}

async function postInitUI() {
    await ensureLayerRulesLoaded();
    postUI({
        type: "init",
        command: normalizeScope(mg.command),
        selectionCount: mg.document.currentPage.selection.length,
        pageCount: mg.document.children.length,
        currentPageName: mg.document.currentPage.name,
        currentPageId: mg.document.currentPage.id,
        pages: getDocumentPageSummaries(),
        exportQueue: await getPendingExportQueueStatus(),
        rules: getLayerRuleStatus()
    });
}

async function safePostInitUI() {
    try {
        await postInitUI();
    } catch (error) {
        console.warn("Unable to initialize SendToFigma UI:", error);
        try {
            postUI({
                type: "error",
                message: error instanceof Error ? error.message : "插件初始化失败"
            });
        } catch (_) {
            // UI may not be ready yet.
        }
    }
}



function startLayerRulesLoad() {
    if (!layerRulesLoadPromise) layerRulesLoadPromise = Promise.resolve();
    return layerRulesLoadPromise;
}

async function ensureLayerRulesLoaded() {
    await startLayerRulesLoad();
}

async function loadCachedLayerRules() {
    cachedLayerRules = {
        config: DEFAULT_LAYER_CONVERSION_CONFIG,
        fileName: "内置转换规则",
        importedAt: ""
    };
    layerRulesBySourceType = createLayerRuleIndex(DEFAULT_LAYER_CONVERSION_CONFIG);
}

function createLayerRuleIndex(config: LayerConversionConfig) {
    const result: { [sourceType: string]: LayerConversionRule } = {};
    for (const sourceType in config.rules) result[sourceType] = config.rules[sourceType];
    return result;
}

function getLayerRuleStatus() {
    if (!cachedLayerRules || !layerRulesBySourceType) return { valid: false };
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

function getLayerRule(sourceType: string | undefined | null) {
    if (!sourceType || !layerRulesBySourceType) return null;
    return layerRulesBySourceType[sourceType] || null;
}

function getRuleRestoreType(sourceType: string) {
    const rule = getLayerRule(sourceType);
    return rule ? rule.restoreType : sourceType;
}

function isConfiguredContainerType(sourceType: string) {
    const rule = getLayerRule(sourceType);
    return !!rule && rule.isContainer;
}

function normalizeScope(scope: string): ExportScope {
    if (scope === COMMAND_ALL_PAGES) return "all-pages";
    if (scope === COMMAND_SELECTED) return "selected";
    if (scope === COMMAND_PARTIAL_PAGES) return "partial-pages";
    return "current-page";
}

function normalizeTransferMode(mode: string): ExportTransferMode {
    return mode === TRANSFER_MODE_LOCAL_JSON_STREAM ? "local-json-stream" : "direct-zip";
}

async function runWithUI(options: ExportOptions): Promise<boolean> {
    try {
        await ensureLayerRulesLoaded();
        if (options.transferMode === "local-json-stream") {
            if (!options.relayUrl) throw new Error("请填写本地流传输服务地址");
            postProgressUI({ type: "progress", phase: "start", current: 0, total: 0, label: "正在准备流传输 JSON..." });
            const manifest = await streamJsonExportPackage(options);
            cacheLatestExportSummary(manifest);
            return true;
        }

        postProgressUI({ type: "progress", phase: "start", current: 0, total: 0, label: "正在准备生成 zip..." });
        const manifest = await streamJsonExportPackage(options);
        cacheLatestExportSummary(manifest);
        return true;
    } catch (error) {
        logDiagnostic("error", "[MasterGo2Figma] Export failed", {
            error: describeError(error),
            debugState: exportDebugState
        });
        postUI({
            type: "error",
            message: error instanceof Error ? error.message : "导出失败，请查看控制台"
        });
        return false;
    }
}

function createPreparedExportLog(requested: ExportOptions, prepared: PreparedExportRun) {
    return {
        sessionId: requested.sessionId || "",
        autoContinue: requested.autoContinue === true,
        batchIndex: requested.batchIndex || 0,
        batchTotal: requested.batchTotal || 0,
        scope: requested.scope,
        transferMode: requested.transferMode,
        requestedPageCount: requested.pageIds.length,
        requestedPages: summarizePageIds(requested.pageIds.slice(0, 5)),
        runPageCount: prepared.options.pageIds.length,
        runPages: summarizePageIds(prepared.options.pageIds),
        remainingPageCount: prepared.remainingPageIds.length,
        remainingPages: summarizePageIds(prepared.remainingPageIds.slice(0, 5)),
        limitedToSinglePage: prepared.limitedToSinglePage,
        maxPagesPerBatch: MAX_PAGES_PER_BATCH
    };
}

function summarizePageIds(pageIds: string[]) {
    if (!Array.isArray(pageIds) || pageIds.length === 0) return [];
    const pageById: { [id: string]: string } = {};
    for (const page of mg.document.children) {
        pageById[page.id] = safeRead(() => page.name, "Untitled");
    }
    return pageIds.map(id => ({
        id,
        name: pageById[id] || ""
    }));
}

async function prepareExportRun(options: ExportOptions): Promise<PreparedExportRun> {
    if (options.scope !== "partial-pages") {
        return { options, remainingPageIds: [], limitedToSinglePage: false };
    }

    const pageIds = filterExistingPageIds(options.pageIds);
    if (pageIds.length === 0) return { options: { ...options, pageIds }, remainingPageIds: [], limitedToSinglePage: false };

    if (pageIds.length > MAX_PAGES_PER_BATCH) {
        return {
            options: { ...options, pageIds: pageIds.slice(0, MAX_PAGES_PER_BATCH) },
            remainingPageIds: pageIds.slice(MAX_PAGES_PER_BATCH),
            limitedToSinglePage: true
        };
    }

    const pendingQueue = await readPendingExportQueue();
    const isQueuedNextPage = !!(pendingQueue && pendingQueue.pageIds[0] === pageIds[0]);
    return {
        options: { ...options, pageIds },
        remainingPageIds: isQueuedNextPage && pendingQueue ? pendingQueue.pageIds.slice(1) : [],
        limitedToSinglePage: false
    };
}

async function savePendingExportQueueForRecovery(prepared: PreparedExportRun) {
    if (prepared.options.scope !== "partial-pages") {
        await clearPendingExportQueue();
        return;
    }

    const recoveryPageIds = filterExistingPageIds([
        ...prepared.options.pageIds,
        ...prepared.remainingPageIds
    ]);
    if (recoveryPageIds.length === 0) {
        await clearPendingExportQueue();
        return;
    }

    const now = new Date().toISOString();
    const existing = await readPendingExportQueue();
    const queue: PendingExportQueue = {
        pageIds: recoveryPageIds,
        createdAt: existing && existing.createdAt ? existing.createdAt : now,
        updatedAt: now
    };
    await mg.clientStorage.setAsync(EXPORT_QUEUE_CACHE_KEY, queue);
    logDiagnostic("log", "[MasterGo2Figma] Export recovery queue saved", {
        sessionId: prepared.options.sessionId || "",
        batchIndex: prepared.options.batchIndex || 0,
        runningPages: summarizePageIds(prepared.options.pageIds),
        recoveryPageCount: recoveryPageIds.length,
        nextPage: summarizePageIds(recoveryPageIds.slice(0, 1))[0] || null
    });
}

async function updatePendingExportQueue(prepared: PreparedExportRun) {
    if (prepared.options.scope !== "partial-pages") {
        await clearPendingExportQueue();
        return;
    }

    const remainingPageIds = filterExistingPageIds(prepared.remainingPageIds);
    if (remainingPageIds.length === 0) {
        await clearPendingExportQueue();
        postUI({ type: "export-queue-cleared" });
        if (prepared.options.scope === "partial-pages") {
            logDiagnostic("log", "[MasterGo2Figma] Export queue complete", {
                sessionId: prepared.options.sessionId || "",
                autoContinue: prepared.options.autoContinue === true,
                exportedPages: summarizePageIds(prepared.options.pageIds),
                remainingPageCount: 0
            });
        }
        return;
    }

    const now = new Date().toISOString();
    const existing = await readPendingExportQueue();
    const queue: PendingExportQueue = {
        pageIds: remainingPageIds,
        createdAt: existing && existing.createdAt ? existing.createdAt : now,
        updatedAt: now
    };
    await mg.clientStorage.setAsync(EXPORT_QUEUE_CACHE_KEY, queue);
    const status = createExportQueueStatus(queue);
    logDiagnostic("log", "[MasterGo2Figma] Export queue saved", {
        sessionId: prepared.options.sessionId || "",
        autoContinue: prepared.options.autoContinue === true,
        exportedPages: summarizePageIds(prepared.options.pageIds),
        remainingPageCount: remainingPageIds.length,
        nextPage: summarizePageIds(remainingPageIds.slice(0, 1))[0] || null
    });
    postUI({ type: "export-queue-updated", exportQueue: status });
    if (!prepared.options.autoContinue) {
        mg.notify(`已导出当前页面，还剩 ${remainingPageIds.length} 个页面，可点击开始继续。`, {
            position: "bottom",
            timeout: 5000,
            type: "highlight"
        });
    }
}

async function clearPendingExportQueue() {
    try {
        await mg.clientStorage.deleteAsync(EXPORT_QUEUE_CACHE_KEY);
    } catch (error) {
        console.warn("Unable to clear export queue:", error);
    }
}

async function readPendingExportQueue(): Promise<PendingExportQueue | null> {
    try {
        const cached = await mg.clientStorage.getAsync(EXPORT_QUEUE_CACHE_KEY);
        if (!cached || !Array.isArray(cached.pageIds)) return null;
        const pageIds = filterExistingPageIds(cached.pageIds);
        if (pageIds.length === 0) {
            await clearPendingExportQueue();
            return null;
        }
        return {
            pageIds,
            createdAt: String(cached.createdAt || cached.updatedAt || ""),
            updatedAt: String(cached.updatedAt || "")
        };
    } catch (error) {
        console.warn("Unable to read export queue:", error);
        return null;
    }
}

async function getPendingExportQueueStatus() {
    const queue = await readPendingExportQueue();
    return queue ? createExportQueueStatus(queue) : null;
}

function createExportQueueStatus(queue: PendingExportQueue) {
    const nextPageId = queue.pageIds[0] || "";
    return {
        pageIds: queue.pageIds,
        remainingCount: queue.pageIds.length,
        nextPageId,
        nextPageName: getPageNameById(nextPageId),
        updatedAt: queue.updatedAt
    };
}

function filterExistingPageIds(pageIds: string[]) {
    const existingPageIds = new Set([...mg.document.children].map(page => page.id));
    const result: string[] = [];
    const seen: { [id: string]: true } = {};
    for (const pageId of pageIds) {
        if (typeof pageId !== "string" || !existingPageIds.has(pageId) || seen[pageId]) continue;
        seen[pageId] = true;
        result.push(pageId);
    }
    return result;
}

function getPageNameById(pageId: string) {
    const page = [...mg.document.children].find(nextPage => nextPage.id === pageId);
    return page ? safeRead(() => page.name, "Untitled") : "Untitled";
}

function cacheLatestExportSummary(manifest: ExportManifest) {
    mg.clientStorage.setAsync("latest-mastergo2figma-export", {
        manifest: {
            schema: manifest.schema,
            version: manifest.version,
            source: manifest.source,
            documentId: manifest.documentId,
            exportedAt: manifest.exportedAt,
            scope: manifest.scope,
            stats: manifest.stats
        },
        savedAt: new Date().toISOString()
    }).catch(error => {
        console.warn("Unable to cache latest export summary:", error);
    });
}

function postUI(message: any) {
    try {
        mg.ui.postMessage(message);
    } catch (error) {
        logDiagnostic("error", "[MasterGo2Figma] postUI failed", {
            error: describeError(error),
            message: summarizeUIMessage(message),
            debugState: exportDebugState
        });
        throw error;
    }
}

function postProgressUI(message: any) {
    try {
        postUI(message);
    } catch (error) {
        logDiagnostic("warn", "Unable to post progress update", {
            error: describeError(error),
            debugState: exportDebugState
        });
    }
}

async function maybeReportExportProgress(current: number, total: number, label: string, force = false) {
    const now = Date.now();
    const progress = activeExportProgress || { lastCurrent: 0, lastPostedAt: 0 };
    const shouldPost = force ||
        current >= total && total > 0 ||
        current - progress.lastCurrent >= EXPORT_PROGRESS_EVERY_LAYERS ||
        now - progress.lastPostedAt >= EXPORT_PROGRESS_TIME_INTERVAL_MS;

    if (!shouldPost) return;

    postProgressUI({
        type: "progress",
        phase: "export",
        current,
        total,
        label
    });
    progress.lastCurrent = current;
    progress.lastPostedAt = now;
    activeExportProgress = progress;
    if (activeExportStats) {
        activeExportStats.progressPosts++;
        activeExportStats.progressYields++;
    }
    await yieldToEventLoop();
}

function setExportDebugState(nextState: Omit<ExportDebugState, "processedNodes" | "totalNodes">) {
    exportDebugState.phase = nextState.phase;
    exportDebugState.page = nextState.page;
    exportDebugState.node = nextState.node;
    exportDebugState.nodeComplexity = nextState.nodeComplexity;
    exportDebugState.parentId = nextState.parentId;
    exportDebugState.nodeIndex = nextState.nodeIndex;
    exportDebugState.file = nextState.file;
    exportDebugState.transferId = nextState.transferId;
    exportDebugState.fileIndex = nextState.fileIndex;
    exportDebugState.chunkIndex = nextState.chunkIndex;
    exportDebugState.fileSize = nextState.fileSize;
    exportDebugState.streamedBytes = nextState.streamedBytes;
    exportDebugState.processedNodes = processedNodes;
    exportDebugState.totalNodes = totalNodes;
}

function resetExportStats(options: ExportOptions, pageCount: number, rootCount: number) {
    logDiagnostic("log", "[MasterGo2Figma] Export session stats reset", {
        sessionId: options.sessionId || "",
        autoContinue: options.autoContinue === true,
        batchIndex: options.batchIndex || 0,
        batchTotal: options.batchTotal || 0,
        pageCount,
        rootCount,
        transferMode: options.transferMode,
        relayUrl: options.relayUrl || "",
        chunkMaxRecords: LAYER_CHUNK_MAX_RECORDS,
        chunkMaxBytes: LAYER_CHUNK_MAX_BYTES
    });
    activeExportStats = {
        startedAt: Date.now(),
        scope: options.scope,
        transferMode: options.transferMode,
        sessionId: options.sessionId || "",
        autoContinue: options.autoContinue === true,
        batchIndex: options.batchIndex || 0,
        batchTotal: options.batchTotal || 0,
        pageCount,
        rootCount,
        totalNodes: 0,
        processedNodes: 0,
        scanMs: 0,
        exportMs: 0,
        assetMs: 0,
        manifestMs: 0,
        ackMs: 0,
        files: 0,
        chunks: 0,
        bytes: 0,
        layerChunkFiles: 0,
        layerRecords: 0,
        splitPackages: 0,
        imageAssets: 0,
        missingImageAssets: 0,
        progressPosts: 0,
        progressYields: 0
    };
    activeExportProgress = {
        lastCurrent: 0,
        lastPostedAt: Date.now()
    };
}

async function timeExportPhase<T>(phase: "scanMs" | "exportMs" | "assetMs" | "manifestMs" | "ackMs", action: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
        return await action();
    } finally {
        if (activeExportStats) activeExportStats[phase] += Date.now() - startedAt;
    }
}

function noteExportFileTransfer(file: ExportFile, size: number, totalChunks: number) {
    if (!activeExportStats) return;
    activeExportStats.files++;
    activeExportStats.chunks += totalChunks;
    activeExportStats.bytes += size;
    if (file.path.indexOf("/layers/layers-") !== -1) activeExportStats.layerChunkFiles++;
}

function noteExportLayerRecord() {
    if (activeExportStats) activeExportStats.layerRecords++;
}

function noteExportSplitPackage() {
    if (activeExportStats) activeExportStats.splitPackages++;
}

function updateExportStatsFromManifest(manifest?: ExportManifest) {
    if (!activeExportStats) return;
    activeExportStats.totalNodes = totalNodes > 0 ? totalNodes : processedNodes;
    activeExportStats.processedNodes = processedNodes;
    if (manifest) {
        activeExportStats.imageAssets = manifest.stats.imageAssetCount;
        activeExportStats.missingImageAssets = manifest.stats.missingImageAssetCount;
    }
}

function logExportPerformanceSummary(label: string, manifest?: ExportManifest) {
    if (!activeExportStats) return;
    updateExportStatsFromManifest(manifest);
    const durationMs = Math.max(Date.now() - activeExportStats.startedAt, 1);
    const nodesPerSecond = Math.round((activeExportStats.processedNodes / durationMs) * 10000) / 10;
    console.log("[MasterGo2Figma] Export performance", {
        label,
        durationMs,
        duration: formatDurationMs(durationMs),
        nodesPerSecond,
        sessionId: activeExportStats.sessionId,
        autoContinue: activeExportStats.autoContinue,
        batchIndex: activeExportStats.batchIndex,
        batchTotal: activeExportStats.batchTotal,
        scope: activeExportStats.scope,
        transferMode: activeExportStats.transferMode,
        pageCount: activeExportStats.pageCount,
        rootCount: activeExportStats.rootCount,
        totalNodes: activeExportStats.totalNodes,
        processedNodes: activeExportStats.processedNodes,
        scanMs: activeExportStats.scanMs,
        exportMs: activeExportStats.exportMs,
        assetMs: activeExportStats.assetMs,
        manifestMs: activeExportStats.manifestMs,
        ackMs: activeExportStats.ackMs,
        files: activeExportStats.files,
        chunks: activeExportStats.chunks,
        bytes: activeExportStats.bytes,
        layerChunkFiles: activeExportStats.layerChunkFiles,
        layerRecords: activeExportStats.layerRecords,
        splitPackages: activeExportStats.splitPackages,
        imageAssets: activeExportStats.imageAssets,
        missingImageAssets: activeExportStats.missingImageAssets,
        progressPosts: activeExportStats.progressPosts,
        progressYields: activeExportStats.progressYields
    });
}

function formatDurationMs(ms: number) {
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
}

function describeError(error: any): any {
    if (error === null) return { kind: "null" };
    if (error === undefined) return { kind: "undefined" };

    try {
        if (error && error.name === "RuntimeError") {
            return {
                kind: "RuntimeError",
                message: "memory access out of bounds (Wasm OOM)"
            };
        }
    } catch (_) {}

    const id = softRead(() => error.id, "");
    const type = softRead(() => error.type, "");
    if (id || type) {
        return {
            kind: "HostObject",
            id,
            type,
            name: softRead(() => error.name, "Untitled")
        };
    }

    const name = softRead(() => error.name, "");
    const message = softRead(() => error.message, "");
    if (error instanceof Error || (name && message)) {
        return {
            kind: "Error",
            name: name || "Error",
            message: message || "No message",
            code: softRead(() => error.code, undefined)
        };
    }

    if (typeof error === "object") {
        const safeObj: any = { kind: "object" };
        try {
            for (const key of Object.keys(error)) {
                const val = error[key];
                if (val === null) {
                    safeObj[key] = null;
                } else if (Array.isArray(val)) {
                    safeObj[key] = `[Array(${val.length})]`;
                } else if (typeof val === "object") {
                    safeObj[key] = `[Object]`;
                } else if (typeof val !== "function") {
                    safeObj[key] = val;
                }
            }
        } catch (_) {
            safeObj.raw = String(error);
        }
        return safeObj;
    }

    return {
        kind: typeof error,
        value: String(error)
    };
}

function safeStringifyForLog(value: any): string {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value !== "object") return String(value);

    const nodeId = softRead(() => value.id, "");
    const nodeType = softRead(() => value.type, "");
    if ((nodeId || nodeType) && !isPlainObjectForLog(value)) {
        return `[HostNode: ${softRead(() => value.name, "Untitled")} (${nodeType}, id=${nodeId})]`;
    }

    try {
        const seen = new WeakSet();
        return JSON.stringify(value, (key, nextValue) => {
            if (typeof nextValue === "object" && nextValue !== null) {
                if (seen.has(nextValue)) return "[Circular]";
                seen.add(nextValue);

                const childId = softRead(() => nextValue.id, "");
                const childType = softRead(() => nextValue.type, "");
                if ((childId || childType) && !isPlainObjectForLog(nextValue)) {
                    return `[HostNode: ${softRead(() => nextValue.name, "Untitled")} (${childType}, id=${childId})]`;
                }

                const nextName = softRead(() => nextValue.name, "");
                const nextMsg = softRead(() => nextValue.message, "");
                if (nextName || nextMsg) {
                    return { name: nextName, message: nextMsg };
                }
            }
            return nextValue;
        });
    } catch (_) {
        try {
            const name = softRead(() => value.name, "");
            const msg = softRead(() => value.message, "");
            if (name || msg) return `[ErrorObject: ${name} - ${msg}]`;
            return `[Object: ${String(value)}]`;
        } catch (__) {
            return "[Object serialization failed]";
        }
    }
}

function isPlainObjectForLog(value: any) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    try {
        const proto = Object.getPrototypeOf(value);
        return proto === Object.prototype || proto === null;
    } catch (_) {
        return false;
    }
}


function logDiagnostic(level: "log" | "warn" | "error", message: string, payload?: any) {
    const text = payload === undefined ? "" : ` ${safeStringifyForLog(payload)}`;
    console[level](`${message}${text}`);
}

function summarizeUIMessage(message: any) {
    if (!message || typeof message !== "object") return { value: String(message) };
    return {
        type: message.type,
        transferId: message.transferId,
        index: message.index,
        chunkIndex: message.chunkIndex,
        path: message.path,
        kind: message.kind,
        size: message.size,
        totalChunks: message.totalChunks,
        contentLength: typeof message.content === "string" ? message.content.length : undefined,
        bytesLength: message.bytes && typeof message.bytes.length === "number" ? message.bytes.length : undefined
    };
}

function createExportTransfer(manifest: ExportManifest, filename?: string, options?: ExportOptions): ExportTransferState {
    const transferId = `export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const target: ExportTransferTarget = options && options.transferMode === "local-json-stream" ? EXPORT_TARGET_LOCAL_RELAY : EXPORT_TARGET_ZIP;
    return {
        transferId,
        filename: filename || createExportFilename(manifest),
        fileIndex: 0,
        postedChunks: 0,
        streamedBytes: 0,
        target,
        relayUrl: target === EXPORT_TARGET_LOCAL_RELAY && options ? options.relayUrl : undefined
    };
}

function getExportTransferMessageMeta(transfer: ExportTransferState) {
    return {
        target: transfer.target,
        relayUrl: transfer.relayUrl || ""
    };
}

function startExportTransfer(transfer: ExportTransferState) {
    postUI({
        type: "export-transfer-start",
        transferId: transfer.transferId,
        filename: transfer.filename,
        fileCount: 0,
        totalBytes: 0,
        ...getExportTransferMessageMeta(transfer)
    });
}

async function streamExportFileToUI(transfer: ExportTransferState, file: ExportFile) {
    const index = transfer.fileIndex++;
    const canSendTextAsBytes = file.bytes === undefined && SEND_TEXT_CHUNKS_AS_BYTES && typeof TextEncoder !== "undefined";
    const kind: ExportTransferFileKind = file.bytes !== undefined || canSendTextAsBytes ? "bytes" : "content";
    const contentParts = file.contentParts || (file.content !== undefined ? [file.content] : []);
    const size = kind === "bytes"
        ? (file.bytes ? file.bytes.length : contentParts.reduce((sum, part) => sum + part.length, 0))
        : contentParts.reduce((sum, part) => sum + part.length, 0);
    const totalChunks = kind === "bytes"
        ? Math.ceil(size / EXPORT_TRANSFER_CHUNK_SIZE)
        : Math.max(1, Math.ceil(size / EXPORT_TEXT_CHUNK_CHAR_LIMIT));
    let fileStarted = false;
    let fileEnded = false;

    try {
        setExportDebugState({
            phase: "transfer:file-start",
            file: file.path,
            transferId: transfer.transferId,
            fileIndex: index,
            fileSize: size,
            streamedBytes: transfer.streamedBytes
        });
        postUI({
            type: "export-file-start",
            transferId: transfer.transferId,
            index,
            path: file.path,
            kind,
            size,
            totalChunks,
            ...getExportTransferMessageMeta(transfer)
        });
        fileStarted = true;

        if (file.bytes !== undefined) {
            const bytes = file.bytes || new Uint8Array(0);
            for (let offset = 0, chunkIndex = 0; offset < bytes.length; offset += EXPORT_TRANSFER_CHUNK_SIZE, chunkIndex++) {
                setExportDebugState({
                    phase: "transfer:bytes-chunk",
                    file: file.path,
                    transferId: transfer.transferId,
                    fileIndex: index,
                    chunkIndex,
                    fileSize: size,
                    streamedBytes: transfer.streamedBytes
                });
                postUI({
                    type: "export-file-chunk",
                    transferId: transfer.transferId,
                    index,
                    chunkIndex,
                    bytes: bytes.slice(offset, offset + EXPORT_TRANSFER_CHUNK_SIZE),
                    ...getExportTransferMessageMeta(transfer)
                });
                transfer.postedChunks++;
                if (transfer.postedChunks % EXPORT_TRANSFER_YIELD_EVERY_CHUNKS === 0) await yieldToHost();
            }
        } else {
            let chunkIndex = 0;
            const textEncoder = canSendTextAsBytes ? new TextEncoder() : null;
            const postContentChunk = async (content: string) => {
                setExportDebugState({
                    phase: textEncoder ? "transfer:content-bytes-chunk" : "transfer:content-chunk",
                    file: file.path,
                    transferId: transfer.transferId,
                    fileIndex: index,
                    chunkIndex,
                    fileSize: size,
                    streamedBytes: transfer.streamedBytes
                });
                const message = textEncoder
                    ? {
                        type: "export-file-chunk",
                        transferId: transfer.transferId,
                        index,
                        chunkIndex,
                        bytes: textEncoder.encode(content),
                        ...getExportTransferMessageMeta(transfer)
                    }
                    : {
                        type: "export-file-chunk",
                        transferId: transfer.transferId,
                        index,
                        chunkIndex,
                        content,
                        ...getExportTransferMessageMeta(transfer)
                    };
                postUI(message);
                chunkIndex++;
                transfer.postedChunks++;
                if (transfer.postedChunks % EXPORT_TRANSFER_YIELD_EVERY_CHUNKS === 0) await yieldToHost();
            };
            for (const part of contentParts) {
                if (!part) continue;
                let offset = 0;
                while (offset < part.length) {
                    const nextLength = Math.min(EXPORT_TEXT_CHUNK_CHAR_LIMIT, part.length - offset);
                    const chunkStr = part.slice(offset, offset + nextLength);
                    await postContentChunk(chunkStr);
                    offset += nextLength;
                }
            }
            if (size === 0) await postContentChunk("");
        }

        transfer.streamedBytes += size;
        setExportDebugState({
            phase: "transfer:file-end",
            file: file.path,
            transferId: transfer.transferId,
            fileIndex: index,
            fileSize: size,
            streamedBytes: transfer.streamedBytes
        });
        const fileAckPromise = waitForExportFileAck(transfer, index, file.path);
        postUI({ type: "export-file-end", transferId: transfer.transferId, index, ...getExportTransferMessageMeta(transfer) });
        fileEnded = true;
        await fileAckPromise;
        noteExportFileTransfer(file, size, totalChunks);
        if (index % 25 === 0) await yieldToHost();
    } catch (error) {
        logDiagnostic("error", "[MasterGo2Figma] Transfer file failed", {
            error: describeError(error),
            file: {
                path: file.path,
                kind,
                index,
                size,
                started: fileStarted,
                ended: fileEnded
            },
            debugState: exportDebugState
        });
        if (fileStarted && !fileEnded) abortExportFileToUI(transfer, index, file.path, error);
        clearPendingExportFileAck(transfer, index);
        throw error;
    }
}

function abortExportFileToUI(transfer: ExportTransferState, index: number, path: string, error: any) {
    try {
        postUI({
            type: "export-file-abort",
            transferId: transfer.transferId,
            index,
            path,
            reason: safeStringifyForLog(describeError(error)),
            ...getExportTransferMessageMeta(transfer)
        });
    } catch (abortError) {
        logDiagnostic("warn", "[MasterGo2Figma] Unable to send export-file-abort", {
            abortError: describeError(abortError),
            originalError: describeError(error),
            transfer: summarizeTransfer(transfer),
            file: { index, path }
        });
    }
}

function getExportFileAckKey(transferId: string, index: number) {
    return `${transferId}:${index}`;
}

function resolveExportFileAck(message: any) {
    const transferId = String(message && message.transferId || "");
    const index = Number(message && message.index);
    const key = getExportFileAckKey(transferId, index);
    const resolver = exportFileAckResolvers[key];
    if (!resolver) return;
    clearTimeout(resolver.timeoutId);
    delete exportFileAckResolvers[key];

    const ack: ExportFileAck = {
        transferId,
        index,
        success: message && message.success === true,
        path: typeof message.path === "string" ? message.path : resolver.path,
        error: typeof message.error === "string" ? message.error : undefined,
        pendingCount: typeof message.pendingCount === "number" ? message.pendingCount : undefined
    };

    if (ack.success) {
        resolver.resolve(ack);
    } else {
        resolver.reject(new Error(`UI failed to write ${ack.path || resolver.path}: ${ack.error || "unknown error"}; pending=${ack.pendingCount === undefined ? "unknown" : ack.pendingCount}`));
    }
}

function waitForExportFileAck(transfer: ExportTransferState, index: number, path: string, timeoutMs = 60000) {
    return new Promise<ExportFileAck>((resolve, reject) => {
        const key = getExportFileAckKey(transfer.transferId, index);
        const timeoutId = setTimeout(() => {
            delete exportFileAckResolvers[key];
            reject(new Error(`Timed out waiting for UI file ack: ${path}`));
        }, timeoutMs) as any as number;
        exportFileAckResolvers[key] = {
            resolve,
            reject,
            timeoutId,
            path
        };
    });
}

function clearPendingExportFileAck(transfer: ExportTransferState, index: number) {
    const key = getExportFileAckKey(transfer.transferId, index);
    const resolver = exportFileAckResolvers[key];
    if (!resolver) return;
    clearTimeout(resolver.timeoutId);
    delete exportFileAckResolvers[key];
}

function completeExportTransfer(
    transfer: ExportTransferState,
    manifest: ExportManifest,
    isFinal = true,
    stats: ExportManifest["stats"] = manifest.stats
) {
    postUI({
        type: "export-transfer-complete",
        transferId: transfer.transferId,
        filename: transfer.filename,
        fileCount: transfer.fileIndex,
        totalBytes: transfer.streamedBytes,
        stats,
        isFinal,
        ...getExportTransferMessageMeta(transfer)
    });
}

function resolveExportTransferAck(message: any) {
    const transferId = String(message && message.transferId || "");
    const resolver = exportTransferAckResolvers[transferId];
    if (!resolver) return;
    clearTimeout(resolver.timeoutId);
    delete exportTransferAckResolvers[transferId];

    const ack: ExportTransferAck = {
        transferId,
        success: message && message.success === true,
        filename: typeof message.filename === "string" ? message.filename : undefined,
        error: typeof message.error === "string" ? message.error : undefined,
        pendingCount: typeof message.pendingCount === "number" ? message.pendingCount : undefined
    };

    if (ack.success) {
        resolver.resolve(ack);
    } else {
        resolver.reject(new Error(`UI zip failed for ${ack.filename || transferId}: ${ack.error || "unknown error"}; pending=${ack.pendingCount === undefined ? "unknown" : ack.pendingCount}`));
    }
}

function waitForExportTransferAck(transfer: ExportTransferState, timeoutMs = 120000) {
    return new Promise<ExportTransferAck>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            delete exportTransferAckResolvers[transfer.transferId];
            reject(new Error(`Timed out waiting for UI zip ack: ${transfer.filename}`));
        }, timeoutMs) as any as number;
        exportTransferAckResolvers[transfer.transferId] = {
            resolve,
            reject,
            timeoutId
        };
    });
}

async function streamJsonExportPackage(options: ExportOptions): Promise<ExportManifest> {
    totalNodes = 0;
    processedNodes = 0;
    const previousImageAssetContext = activeImageAssetContext;

    try {
        const targets = getExportTargets(options);
        let rootCount = 0;
        for (const target of targets) {
            rootCount += ensureTargetNodes(target).length;
            clearTargetNodes(target);
        }
        if (rootCount === 0) {
            throw new Error(options.scope === "selected" ? "请先选择要导出的图层" : "没有可导出的图层");
        }

        resetExportStats(options, targets.length, rootCount);

        if (shouldSplitExportPackages(options, targets)) {
            const aggregateManifest = await streamSplitJsonExportPackages(options, targets);
            logExportPerformanceSummary("split-complete", aggregateManifest);
            return aggregateManifest;
        }

        postProgressUI({ type: "progress", phase: "scan", current: 0, total: 0, label: "正在扫描图层..." });
        countVisited = 0;
        totalNodes = 0;
        await timeExportPhase("scanMs", async () => {
            for (const target of targets) {
                const nodes = ensureTargetNodes(target);
                for (const node of nodes) await countNodes(node);
                clearTargetNodes(target);
            }
        });
        processedNodes = 0;
        postProgressUI({ type: "progress", phase: "prepare", current: 0, total: totalNodes, label: "准备分块导出 JSON..." });

        const imageAssetContext = createImageAssetContext();
        activeImageAssetContext = imageAssetContext;
        const manifest = createBaseExportManifest(options, targets.length);
        const transfer = createExportTransfer(manifest, undefined, options);
        startExportTransfer(transfer);

        console.log(`[MasterGo2Figma] Export v2 start: ${targets.length} pages, ${rootCount} roots, nodes=${totalNodes}.`);

        await timeExportPhase("exportMs", async () => {
            for (let pageIndex = 0; pageIndex < targets.length; pageIndex++) {
                const pageTarget = targets[pageIndex];
                ensureTargetNodes(pageTarget);
                await streamPageExportToTransfer(pageTarget, pageIndex, targets.length, manifest, transfer);
                clearTargetNodes(pageTarget);
                targets[pageIndex] = null as any;
            }
        });

        postProgressUI({ type: "progress", phase: "assets", current: processedNodes, total: totalNodes, label: "正在导出图片资源..." });
        await timeExportPhase("assetMs", async () => {
            await streamImageAssetsToTransfer(imageAssetContext, manifest, transfer);
        });

        await timeExportPhase("manifestMs", async () => {
            await streamExportFileToUI(transfer, {
                path: "manifest.json",
                content: JSON.stringify(manifest)
            });
        });

        postProgressUI({ type: "progress", phase: "complete", current: processedNodes, total: processedNodes, label: "JSON 已生成，正在准备下载..." });
        const ackPromise = waitForExportTransferAck(transfer);
        completeExportTransfer(transfer, manifest);
        const ack = await timeExportPhase("ackMs", async () => await ackPromise);
        console.log(`[MasterGo2Figma] UI zip complete: ${ack.filename || transfer.filename}, files=${transfer.fileIndex}, bytes=${transfer.streamedBytes}`);
        logExportPerformanceSummary("complete", manifest);
        return manifest;
    } catch (error) {
        logExportPerformanceSummary("failed");
        logDiagnostic("error", "[MasterGo2Figma] Export transfer failed", {
            error: describeError(error),
            debugState: exportDebugState
        });
        throw error;
    } finally {
        activeImageAssetContext = previousImageAssetContext;
    }
}

function createBaseExportManifest(options: ExportOptions, pageCount: number): ExportManifest {
    return {
        schema: "mastergo2figma.package.v2",
        version: 2,
        source: "mastergo",
        documentId: mg.documentId,
        exportedAt: new Date().toISOString(),
        scope: options.scope,
        pages: [],
        assets: {},
        stats: {
            pageCount,
            layerCount: 0,
            imageAssetCount: 0,
            missingImageAssetCount: 0
        }
    };
}

function shouldSplitExportPackages(options: ExportOptions, targets: PageExportTarget[]) {
    if (!ENABLE_SPLIT_EXPORT) return false;
    if (options.transferMode === "direct-zip") return false;
    if (targets.length > 1) return true;
    const nodes = ensureTargetNodes(targets[0]);
    return nodes.length > 1;
}

async function streamSplitJsonExportPackages(
    options: ExportOptions,
    targets: PageExportTarget[]
): Promise<ExportManifest> {
    const aggregateManifest = createBaseExportManifest(options, targets.length);
    let rootCount = 0;
    for (const target of targets) {
        rootCount += ensureTargetNodes(target).length;
        clearTargetNodes(target);
    }
    console.log(`[MasterGo2Figma] Split export start: ${targets.length} pages, ${rootCount} roots. Node pre-scan skipped.`);
    postProgressUI({
        type: "progress",
        phase: "prepare",
        current: 0,
        total: 0,
        label: "正在按页面分包导出..."
    });

    for (let pageIndex = 0; pageIndex < targets.length; pageIndex++) {
        const pageTarget = targets[pageIndex];
        ensureTargetNodes(pageTarget);
        await streamPageRootSegmentsToPackages(options, pageTarget, pageIndex, targets.length, aggregateManifest);
        clearTargetNodes(pageTarget);
        targets[pageIndex] = null as any;
    }

    return aggregateManifest;
}

async function streamPageRootSegmentsToPackages(
    options: ExportOptions,
    pageTarget: PageExportTarget,
    pageIndex: number,
    pageCount: number,
    aggregateManifest: ExportManifest
) {
    const pageName = safeRead(() => pageTarget.page.name, "Untitled");
    isVerboseLoggingActive = pageIndex >= DEBUG_LOGGING_PAGE_INDEX_START;
    if (isVerboseLoggingActive) {
        console.log(`[MasterGo2Figma] [DEBUG] Verbose logging activated for split package page: ${pageName}`);
    }
    let rootIndex = 0;
    let segmentIndex = 0;
    const nodes = ensureTargetNodes(pageTarget);
    const useSegmentNames = nodes.length > 1;

    while (rootIndex < nodes.length) {
        const imageAssetContext = createImageAssetContext();
        activeImageAssetContext = imageAssetContext;
        const manifest = createBaseExportManifest(options, 1);
        const filename = createPageExportFilename(
            options.scope,
            pageTarget.page,
            pageIndex,
            pageCount,
            manifest.exportedAt,
            segmentIndex,
            useSegmentNames ? 0 : 1
        );
        const transfer = createExportTransfer(manifest, filename, options);
        startExportTransfer(transfer);

        const segmentLabel = useSegmentNames ? ` segment ${segmentIndex + 1}` : "";
        const pageNameOverride = useSegmentNames ? `${pageName} ${segmentIndex + 1}` : undefined;
        const startRootIndex = rootIndex;
        console.log(`[MasterGo2Figma] Split package start ${pageIndex + 1}/${pageCount}${segmentLabel}: ${pageName}, roots=${startRootIndex + 1}-${nodes.length}`);
        logDiagnostic("log", "[MasterGo2Figma] Split package detail", {
            pageIndex: pageIndex + 1,
            pageCount,
            pageName,
            segmentIndex: segmentIndex + 1,
            startRootIndex,
            remainingRootCount: nodes.length - startRootIndex,
            targetLayerCount: PAGE_SEGMENT_TARGET_LAYERS,
            chunkMaxRecords: LAYER_CHUNK_MAX_RECORDS,
            chunkMaxBytes: LAYER_CHUNK_MAX_BYTES,
            transfer: summarizeTransfer(transfer)
        });

        noteExportSplitPackage();
        const segmentResult = await timeExportPhase("exportMs", async () => await streamPageRootSegmentToTransfer(
            pageTarget,
            pageIndex,
            pageCount,
            rootIndex,
            PAGE_SEGMENT_TARGET_LAYERS,
            manifest,
            transfer,
            pageNameOverride
        ));
        rootIndex = segmentResult.nextRootIndex;

        postProgressUI({
            type: "progress",
            phase: "assets",
            current: processedNodes,
            total: 0,
            label: `正在导出图片资源 ${pageIndex + 1}/${pageCount}${segmentLabel}...`
        });
        await timeExportPhase("assetMs", async () => {
            await streamImageAssetsToTransfer(imageAssetContext, manifest, transfer);
        });

        await timeExportPhase("manifestMs", async () => {
            await streamExportFileToUI(transfer, {
                path: "manifest.json",
                content: JSON.stringify(manifest)
            });
        });

        const pageSummary = manifest.pages[0];
        if (pageSummary) aggregateManifest.pages.push(pageSummary);
        aggregateManifest.stats.pageCount = aggregateManifest.pages.length;
        aggregateManifest.stats.layerCount += manifest.stats.layerCount;
        aggregateManifest.stats.imageAssetCount += manifest.stats.imageAssetCount;
        aggregateManifest.stats.missingImageAssetCount += manifest.stats.missingImageAssetCount;

        const isFinal = pageIndex === pageCount - 1 && rootIndex >= nodes.length;
        const ackPromise = waitForExportTransferAck(transfer);
        completeExportTransfer(transfer, manifest, isFinal, isFinal ? aggregateManifest.stats : manifest.stats);
        releaseExportPackageMemory(manifest, imageAssetContext);
        activeImageAssetContext = null;
        const ack = await timeExportPhase("ackMs", async () => await ackPromise);
        console.log(`[MasterGo2Figma] Split package complete ${pageIndex + 1}/${pageCount}${segmentLabel}: ${ack.filename || transfer.filename}, roots=${segmentResult.rootCount}, layers=${segmentResult.layerCount}, files=${transfer.fileIndex}, bytes=${transfer.streamedBytes}`);
        segmentIndex++;
        await yieldToHost();
    }
}

async function streamPageRootSegmentToTransfer(
    pageTarget: PageExportTarget,
    pageIndex: number,
    pageCount: number,
    startRootIndex: number,
    targetLayerCount: number,
    manifest: ExportManifest,
    transfer: ExportTransferState,
    pageNameOverride?: string
) {
    const pageFolder = createPageFolderName(pageTarget.page, pageIndex);
    const pageId = safeRead(() => pageTarget.page.id, `page-${pageIndex + 1}`);
    const pageName = pageNameOverride || safeRead(() => pageTarget.page.name, "Untitled");
    const pageIndexRecord: ExportPageIndex = {
        schema: "mastergo2figma.page.v2",
        version: 2,
        id: pageId,
        name: pageName,
        folder: pageFolder,
        rootNodeIds: [],
        layerChunks: [],
        layerCount: 0
    };
    const chunk: LayerChunkAccumulator = {
        pageId,
        pageFolder,
        chunkIndex: 1,
        recordJsons: [],
        bytes: 0,
        writtenNodeIds: {}
    };

    const nodes = ensureTargetNodes(pageTarget);
    let rootIndex = startRootIndex;
    while (rootIndex < nodes.length) {
        const node = nodes[rootIndex];
        pageIndexRecord.rootNodeIds.push(safeRead(() => node.id, `root-${pageIndex + 1}-${rootIndex + 1}`));
        await collectSubtreeIterative(node, pageTarget.page, pageFolder, null, rootIndex, pageIndexRecord, chunk, transfer, "root");
        rootIndex++;
        if (pageIndexRecord.layerCount >= targetLayerCount) break;
    }

    await flushLayerChunk(pageIndexRecord, chunk, transfer);

    const pageFile = `pages/${pageFolder}/page.json`;
    await streamExportFileToUI(transfer, {
        path: pageFile,
        content: JSON.stringify(pageIndexRecord)
    });

    manifest.pages.push({
        id: pageIndexRecord.id,
        name: pageIndexRecord.name,
        folder: pageFolder,
        pageFile,
        layerCount: pageIndexRecord.layerCount
    });
    manifest.stats.layerCount += pageIndexRecord.layerCount;

    return {
        nextRootIndex: rootIndex,
        rootCount: rootIndex - startRootIndex,
        layerCount: pageIndexRecord.layerCount
    };
}

async function streamPageExportToTransfer(
    pageTarget: PageExportTarget,
    pageIndex: number,
    pageCount: number,
    manifest: ExportManifest,
    transfer: ExportTransferState,
    pageNameOverride?: string
) {
    const pageFolder = createPageFolderName(pageTarget.page, pageIndex);
    const pageId = safeRead(() => pageTarget.page.id, `page-${pageIndex + 1}`);
    const pageName = pageNameOverride || safeRead(() => pageTarget.page.name, "Untitled");
    const nodes = ensureTargetNodes(pageTarget);
    isVerboseLoggingActive = pageIndex >= DEBUG_LOGGING_PAGE_INDEX_START;
    if (isVerboseLoggingActive) {
        console.log(`[MasterGo2Figma] [DEBUG] Verbose logging activated for page: ${pageName}`);
    }
    console.log(`[MasterGo2Figma] Page export start ${pageIndex + 1}/${pageCount}: ${pageName}, roots=${nodes.length}`);
    const pageIndexRecord: ExportPageIndex = {
        schema: "mastergo2figma.page.v2",
        version: 2,
        id: pageId,
        name: pageName,
        folder: pageFolder,
        rootNodeIds: [],
        layerChunks: [],
        layerCount: 0
    };
    const chunk: LayerChunkAccumulator = {
        pageId,
        pageFolder,
        chunkIndex: 1,
        recordJsons: [],
        bytes: 0,
        writtenNodeIds: {}
    };

    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        pageIndexRecord.rootNodeIds.push(safeRead(() => node.id, `root-${pageIndex + 1}-${index + 1}`));
        await collectSubtreeIterative(node, pageTarget.page, pageFolder, null, index, pageIndexRecord, chunk, transfer, "root");
    }
    await flushLayerChunk(pageIndexRecord, chunk, transfer);

    const pageFile = `pages/${pageFolder}/page.json`;
    await streamExportFileToUI(transfer, {
        path: pageFile,
        content: JSON.stringify(pageIndexRecord)
    });
    console.log(`[MasterGo2Figma] Page export complete ${pageIndex + 1}/${pageCount}: ${pageIndexRecord.name}, layers=${pageIndexRecord.layerCount}, files=${pageIndexRecord.layerChunks.length}`);

    manifest.pages.push({
        id: pageIndexRecord.id,
        name: pageIndexRecord.name,
        folder: pageFolder,
        pageFile,
        layerCount: pageIndexRecord.layerCount
    });
    manifest.stats.layerCount += pageIndexRecord.layerCount;
}

async function streamImageAssetsToTransfer(
    imageAssetContext: ImageAssetContext,
    manifest: ExportManifest,
    transfer: ExportTransferState
) {
    if (!ENABLE_IMAGE_EXPORT) return;
    for (const asset of imageAssetContext.assets) {
        await loadAndStreamImageAsset(asset, imageAssetContext, transfer);
        manifest.assets[asset.key] = {
            key: asset.key,
            fileName: asset.fileName,
            path: asset.path,
            missing: asset.missing || undefined
        };
        if (asset.bytes && !asset.missing) manifest.stats.imageAssetCount++;
        // 显式断开强引用并给予主线程喘息机会
        asset.bytes = null;
        await yieldToHost();
    }
    manifest.stats.missingImageAssetCount = imageAssetContext.missingImageAssetCount;
}

function releaseExportPackageMemory(manifest: ExportManifest, imageAssetContext: ImageAssetContext) {
    manifest.pages = [];
    manifest.assets = {};
    imageAssetContext.assets.length = 0;
    imageAssetContext.bySourceRef = {};
}

function yieldToHost() {
    return new Promise<void>(resolve => setTimeout(resolve, 0));
}

function createExportFilename(manifest: ExportManifest) {
    const date = manifest.exportedAt.replace(/[:.]/g, "-");
    return `mastergo2figma-${manifest.scope}-${date}.zip`;
}

function createPageExportFilename(
    scope: ExportScope,
    page: PageNode,
    pageIndex: number,
    pageCount: number,
    exportedAt: string,
    segmentIndex = 0,
    segmentCount = 1
) {
    const date = exportedAt.replace(/[:.]/g, "-");
    const pageName = createFileSafeName(safeRead(() => page.name, ""), `page-${pageIndex + 1}`);
    const segmentName = segmentCount > 1
        ? `-segment-${padNumber(segmentIndex + 1)}-of-${padNumber(segmentCount)}`
        : (segmentCount === 0 ? `-segment-${padNumber(segmentIndex + 1)}` : "");
    return `mastergo2figma-${scope}-part-${padNumber(pageIndex + 1)}-of-${padNumber(pageCount)}${segmentName}-${pageName}-${date}.zip`;
}

function createFileSafeName(value: string, fallback: string) {
    const cleaned = String(value || "")
        .trim()
        .replace(/[\\/:*?"<>|]/g, "-")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 48);
    return cleaned || fallback;
}

function ensureTargetNodes(target: PageExportTarget): SceneNode[] {
    if (!target.nodes) {
        target.nodes = getSafeExportableChildren(target.page);
    }
    return target.nodes;
}

function clearTargetNodes(target: PageExportTarget) {
    if (target.nodes) {
        target.nodes.length = 0;
        delete target.nodes;
    }
}

function getExportTargets(options: ExportOptions): PageExportTarget[] {
    const pages = [...mg.document.children].filter(page => !page.name.endsWith("_Process"));
    const selectedPageIds = new Set(options.pageIds);

    if (options.scope === "all-pages") {
        return pages
            .filter(page => selectedPageIds.size === 0 || selectedPageIds.has(page.id))
            .map(page => ({ page }));
    }

    if (options.scope === "partial-pages") {
        if (selectedPageIds.size === 0) throw new Error("请至少选择一个页面");
        return pages
            .filter(page => selectedPageIds.has(page.id))
            .map(page => ({ page }));
    }

    if (options.scope === "selected") {
        const nodes = getTopLevelSelectedNodes(mg.document.currentPage.selection as SceneNode[]);
        return [{ page: mg.document.currentPage, nodes }];
    }

    return [{ page: mg.document.currentPage }];
}

function getExportableChildren(node: any): SceneNode[] {
    const rawChildren = safeRead(() => node.children, null);
    if (!rawChildren) return [];

    // Crucial: We MUST use index-based access.
    // Spreading [...rawChildren] will force the Wasm engine to instantiate all children at once,
    // which causes the "memory access out of bounds" error on large nodes.
    const result: SceneNode[] = [];
    const count = safeRead(() => rawChildren.length, 0);
    for (let i = 0; i < count; i++) {
        try {
            const child = rawChildren[i];
            if (child && !isGeneratedCarrierName(safeRead(() => child.name, ""))) {
                result.push(child);
            }
        } catch (error) {
            // If accessing a specific index fails in the Wasm layer (e.g. getLayerProperties fail),
            // we skip it to prevent crashing the whole export.
            if (isOutOfMemoryError(error)) {
                logDiagnostic("error", "[MasterGo2Figma] Child access OOM", {
                    parent: getNodeProbe(node),
                    childIndex: i,
                    error: describeError(error)
                });
                throw error;
            }
        }
    }
    return result;
}

function getSafeExportableChildren(node: any): SceneNode[] {
    try {
        return getExportableChildren(node);
    } catch (error) {
        if (isOutOfMemoryError(error)) throw error;
        logDiagnostic("warn", "[MasterGo2Figma] Unable to read children for export", {
            node: getNodeProbe(node),
            error: describeError(error)
        });
        return [];
    }
}

interface StackItem {
    nodeId: string;
    parentId: string | null;
    index: number;
    relation: "root" | "child";
}

async function collectSubtreeIterative(
    rootNode: SceneNode,
    page: PageNode,
    pageFolder: string,
    parentId: string | null,
    rootIndex: number,
    pageIndexRecord: ExportPageIndex,
    chunk: LayerChunkAccumulator,
    transfer: ExportTransferState,
    relation: "root" | "child"
) {
    const rootNodeId = safeRead(() => rootNode.id, "");
    if (!rootNodeId) return;

    const stack: StackItem[] = [{
        nodeId: rootNodeId,
        parentId,
        index: rootIndex,
        relation
    }];

    while (stack.length > 0) {
        const item = stack.pop()!;
        const { nodeId, parentId: currentParentId, index: currentIndex, relation: currentRelation } = item;

        try {
            const node = mg.getNodeById(nodeId);
            if (!node) {
                logDiagnostic("warn", `[MasterGo2Figma] DFS node not found by ID: ${nodeId}`, {
                    nodeId,
                    debugState: exportDebugState
                });
                continue;
            }

            const result = await collectSingleNodeExport(
                node,
                page,
                pageFolder,
                currentParentId,
                currentIndex,
                pageIndexRecord,
                chunk,
                transfer,
                currentRelation
            );

            if (result && result.shouldExportChildren && result.childIds && result.childIds.length > 0) {
                // Push children in reverse order to keep correct DFS sequence
                for (let i = result.childIds.length - 1; i >= 0; i--) {
                    const childId = result.childIds[i];
                    if (childId) {
                        stack.push({
                            nodeId: childId,
                            parentId: result.nodeId,
                            index: i,
                            relation: "child"
                        });
                    }
                }
            }
        } catch (error) {
            if (isOutOfMemoryError(error)) throw error;

            logDiagnostic("error", `[MasterGo2Figma] Iterative DFS node traversal failed: ${nodeId}`, {
                error: describeError(error),
                nodeId,
                debugState: exportDebugState
            });
        }
    }
}

async function collectSingleNodeExport(
    node: SceneNode,
    page: PageNode,
    pageFolder: string,
    parentId: string | null,
    index: number,
    pageIndex: ExportPageIndex,
    chunk: LayerChunkAccumulator,
    transfer: ExportTransferState,
    relation: "root" | "child"
): Promise<{ nodeId: string; shouldExportChildren: boolean; childIds: string[] } | null> {
    processedNodes++;
    const nodeDebug = getNodeDebugLabel(node);
    const pageName = safeRead(() => page.name, pageIndex.name);
    let phase = "start";
    let nodeId = safeRead(() => node.id, `node-${pageIndex.layerCount + 1}`);
    let nodeName = safeRead(() => node.name, "Untitled");
    let recordAppended = false;
    let childNodes: SceneNode[] = [];
    let shouldExportChildren = false;

    logDebug(`[DFS] Start node: id=${nodeId}, name=${nodeName}, type=${node.type}, page=${pageName}`);

    const setNodeDebug = (nextPhase: string, nodeComplexity?: NodeComplexitySnapshot) => {
        phase = nextPhase;
        logDebug(`  - [DFS] Node ${nodeId} enter phase: ${nextPhase}`);
        setExportDebugState({
            phase: `node:${nextPhase}`,
            page: pageName,
            node: nodeDebug,
            nodeComplexity,
            parentId,
            nodeIndex: index,
            transferId: transfer.transferId,
            fileIndex: transfer.fileIndex,
            streamedBytes: transfer.streamedBytes
        });
    };

    try {
        setNodeDebug("read-children");
        childNodes = getSafeExportableChildren(node as any);
        logDebug(`  - [DFS] Node ${nodeId} read-children done: childCount=${childNodes.length}`);

        setNodeDebug("analyse");
        let nodeJson: any = analyseNodes(node);
        logDebug(`  - [DFS] Node ${nodeId} analyse done`);

        setNodeDebug("enrich-boolean");
        await enrichBooleanOperationExport(node, nodeJson, childNodes);
        logDebug(`  - [DFS] Node ${nodeId} enrich-boolean done`);

        setNodeDebug("enrich-vector");
        await enrichFilledVectorExport(node, nodeJson);
        logDebug(`  - [DFS] Node ${nodeId} enrich-vector done`);

        setNodeDebug("override-layout");
        overrideExportLayoutFromSourceNode(nodeJson, node);
        logDebug(`  - [DFS] Node ${nodeId} override-layout done`);

        setNodeDebug("build-record");
        shouldExportChildren = !nodeJson || !nodeJson.omitChildrenOnRestore;
        const childIds = shouldExportChildren ? childNodes.map(child => safeRead(() => child.id, "")) : [];
        const omittedChildNodeCount = !shouldExportChildren && nodeJson && nodeJson.omittedChildNodeCount
            ? nodeJson.omittedChildNodeCount
            : 0;

        let layerRecord: any = {
            id: nodeId,
            pageId: safeRead(() => page.id, ""),
            parentId,
            index,
            name: nodeName,
            childIds,
            props: nodeJson
        };

        let nodeComplexity: any = createNodeComplexitySnapshot(node, childNodes, nodeJson);
        childNodes = [];
        if (shouldLogStringifyProbe(nodeComplexity)) {
            logDiagnostic("log", "[MasterGo2Figma] Stringify probe", {
                page: pageName,
                processedNodes,
                totalNodes,
                complexity: nodeComplexity
            });
        }

        setNodeDebug("stringify", nodeComplexity);
        let recordJson: any = stringifyLayerPayload(layerRecord, node, nodeComplexity);
        const recordBytes = recordJson.length;
        if (recordBytes >= STRINGIFY_RECORD_WARN_BYTES) {
            logDiagnostic("warn", "[MasterGo2Figma] Large layer record", {
                page: pageName,
                node: nodeDebug,
                recordBytes,
                chunkBytes: chunk.bytes,
                chunkRecords: chunk.recordJsons.length,
                complexity: nodeComplexity,
                transfer: summarizeTransfer(transfer)
            });
        }
        logDebug(`  - [DFS] Node ${nodeId} stringify done: length=${recordBytes}`);
        layerRecord = null;
        nodeJson = null;
        nodeComplexity = null;
        pageIndex.layerCount++;
        noteExportLayerRecord();

        setNodeDebug("append-record");
        await appendLayerRecord(recordJson, pageIndex, chunk, transfer);
        markLayerWritten(chunk, nodeId);
        recordAppended = true;
        logDebug(`  - [DFS] Node ${nodeId} append done`);

        if (omittedChildNodeCount) {
            processedNodes += omittedChildNodeCount;
        }

        setNodeDebug("progress");
        await maybeReportExportProgress(processedNodes, totalNodes, "正在导出图层...");

        // Clean up references immediately to allow GC
        recordJson = null;
        childNodes = null as any;

        logDebug(`[DFS] Complete node: id=${nodeId}`);
        return { nodeId, shouldExportChildren, childIds };
    } catch (error) {
        logDebug(`[DFS] Node export caught error: id=${nodeId}, phase=${phase}, error=`, describeError(error));
        const fatalOom = isOutOfMemoryError(error);
        logDiagnostic("error", fatalOom ? `[MasterGo2Figma] Fatal node OOM, stopping export: ${nodeId}` : `[MasterGo2Figma] Node export failed: ${nodeId}`, {
            phase,
            error: describeError(error),
            nodeId,
            page: pageName,
            debugState: exportDebugState
        });

        if (fatalOom) throw error;

        if (isRecoverableNodeExportError(error)) {
            if (nodeId && chunk.writtenNodeIds[nodeId]) {
                return null;
            }
            try {
                await appendFallbackLayerRecord(node, page, parentId, index, pageIndex, chunk, transfer);
            } catch (fallbackError) {
                logDiagnostic("error", "[MasterGo2Figma] Recoverable node fallback failed, skipping node", {
                    relation,
                    parentId,
                    node: getNodeProbe(node),
                    originalError: describeError(error),
                    fallbackError: describeError(fallbackError)
                });
            }
        } else {
            throw error;
        }

        return null;
    }
}

async function appendFallbackLayerRecord(
    node: SceneNode,
    page: PageNode,
    parentId: string | null,
    index: number,
    pageIndex: ExportPageIndex,
    chunk: LayerChunkAccumulator,
    transfer: ExportTransferState
) {
    const nodeId = safeRead(() => node.id, `fallback-${pageIndex.layerCount + 1}`);
    const nodeName = safeRead(() => node.name, "Untitled");
    const sourceType = safeRead(() => node.type, "UNKNOWN");
    const fallbackJson = createFallbackNodeJson(node, sourceType);
    const nodeComplexity = createNodeComplexitySnapshot(node, [], fallbackJson);
    const layerRecord = {
        id: nodeId,
        pageId: safeRead(() => page.id, ""),
        parentId,
        index,
        name: nodeName,
        childIds: [],
        props: fallbackJson
    };
    const recordJson = stringifyLayerPayload(layerRecord, node, nodeComplexity);
    pageIndex.layerCount++;
    noteExportLayerRecord();
    await appendLayerRecord(recordJson, pageIndex, chunk, transfer);
    markLayerWritten(chunk, nodeId);
}

function getNodeProbe(node: any) {
    return {
        id: softRead(() => node.id, "unknown-id"),
        name: softRead(() => node.name, "Untitled"),
        type: softRead(() => node.type, "UNKNOWN"),
        width: softRead(() => Number(node.width), undefined as any),
        height: softRead(() => Number(node.height), undefined as any),
        childCount: getRawChildCount(node)
    };
}

function createNodeComplexitySnapshot(node: any, childNodes?: SceneNode[], nodeJson?: any): NodeComplexitySnapshot {
    const vectorNetwork = nodeJson && nodeJson.vectorNetwork ? nodeJson.vectorNetwork : null;
    const regions = vectorNetwork && Array.isArray(vectorNetwork.regions) ? vectorNetwork.regions : undefined;
    return {
        id: softRead(() => node.id, "unknown-id"),
        name: softRead(() => node.name, "Untitled"),
        type: softRead(() => node.type, "UNKNOWN"),
        sourceType: nodeJson && typeof nodeJson.sourceType === "string" ? nodeJson.sourceType : undefined,
        restoreType: nodeJson && typeof nodeJson.restoreType === "string" ? nodeJson.restoreType : undefined,
        width: softRead(() => Number(node.width), undefined as any),
        height: softRead(() => Number(node.height), undefined as any),
        childCount: childNodes ? childNodes.length : getRawChildCount(node),
        rawChildCount: getRawChildCount(node),
        textLength: nodeJson && typeof nodeJson.characters === "string" ? nodeJson.characters.length : undefined,
        fillCount: nodeJson && nodeJson.geometry && Array.isArray(nodeJson.geometry.fills) ? nodeJson.geometry.fills.length : undefined,
        strokeCount: nodeJson && nodeJson.geometry && Array.isArray(nodeJson.geometry.strokes) ? nodeJson.geometry.strokes.length : undefined,
        effectCount: nodeJson && nodeJson.blend && Array.isArray(nodeJson.blend.effects) ? nodeJson.blend.effects.length : undefined,
        vectorNetwork: vectorNetwork ? {
            vertices: Array.isArray(vectorNetwork.vertices) ? vectorNetwork.vertices.length : undefined,
            segments: Array.isArray(vectorNetwork.segments) ? vectorNetwork.segments.length : undefined,
            regions: regions ? regions.length : undefined,
            loops: regions ? regions.reduce((sum, region) => sum + (region && Array.isArray(region.loops) ? region.loops.length : 0), 0) : undefined
        } : undefined
    };
}

function getRawChildCount(node: any) {
    return softRead(() => {
        const children = node && node.children;
        return children && typeof children.length === "number" ? children.length : undefined;
    }, undefined as any);
}

function shouldLogStringifyProbe(complexity: NodeComplexitySnapshot) {
    const vertexCount = complexity.vectorNetwork && complexity.vectorNetwork.vertices || 0;
    const segmentCount = complexity.vectorNetwork && complexity.vectorNetwork.segments || 0;
    const regionCount = complexity.vectorNetwork && complexity.vectorNetwork.regions || 0;
    const childCount = complexity.childCount || complexity.rawChildCount || 0;
    return vertexCount >= STRINGIFY_PROBE_VERTEX_THRESHOLD ||
        segmentCount >= STRINGIFY_PROBE_VERTEX_THRESHOLD ||
        regionCount >= 50 ||
        childCount >= STRINGIFY_PROBE_CHILD_THRESHOLD;
}

function isOutOfMemoryError(error: any) {
    let message = "";
    let name = "";
    try {
        message = String(error && error.message !== undefined ? error.message : error).toLowerCase();
    } catch (_) {
        message = "";
    }
    try {
        name = String(error && error.name !== undefined ? error.name : "").toLowerCase();
    } catch (_) {
        name = "";
    }
    return message.indexOf("out of memory") !== -1 ||
        message.indexOf("memory access out of bounds") !== -1 ||
        name.indexOf("internalerror") !== -1 && message.indexOf("memory") !== -1;
}

function isRecoverableNodeExportError(error: any) {
    if (isOutOfMemoryError(error)) return false;
    let message = "";
    try {
        message = String(error && error.message !== undefined ? error.message : error).toLowerCase();
    } catch (_) {
        message = "";
    }

    if (message.indexOf("ui zip") !== -1 || message.indexOf("timed out waiting for ui zip") !== -1) return false;
    return true;
}

function markLayerWritten(chunk: LayerChunkAccumulator, nodeId: string) {
    if (nodeId) chunk.writtenNodeIds[nodeId] = true;
}

function summarizeTransfer(transfer: ExportTransferState) {
    return {
        transferId: transfer.transferId,
        filename: transfer.filename,
        fileIndex: transfer.fileIndex,
        postedChunks: transfer.postedChunks,
        streamedBytes: transfer.streamedBytes
    };
}

async function enrichBooleanOperationExport(node: SceneNode, nodeJson: any, childNodes: SceneNode[]) {
    if (!nodeJson || safeRead(() => node.type, "") !== "BOOLEAN_OPERATION") return;
    const rule = getLayerRule("BOOLEAN_OPERATION");
    if (rule && rule.sendStrategy === "booleanTree") {
        // No fallback logic needed per user's instruction. Just return and let children export natively.
        return;
    }

    if (hasUsableVectorNetwork(nodeJson.vectorNetwork) || childNodes.length === 0) return;

    const svg = await tryExportBooleanSvgMarkup(node);
    if (svg) {
        nodeJson.svgMarkup = svg;
        nodeJson.svgFallback = true;
        nodeJson.receiveCreateOverride = "SVG";
        nodeJson.omitChildrenOnRestore = true;
        nodeJson.omittedChildNodeCount = Math.max(0, countExportableSubtreeNodes(node) - 1);
        return;
    }

    markBooleanAsFrameFallback(nodeJson);
}

async function attachBooleanSvgFallbackMarkup(node: SceneNode, nodeJson: any) {
    const svg = await tryExportSvgMarkup(node, "Boolean");
    if (!svg) return;
    nodeJson.svgMarkup = svg;
    nodeJson.svgFallback = true;
    nodeJson.booleanVisualFallback = "svg";
    nodeJson.receiveCreateOverride = "SVG";
    nodeJson.omitChildrenOnRestore = true;
    nodeJson.omittedChildNodeCount = Math.max(0, countExportableSubtreeNodes(node) - 1);
}

async function tryExportBooleanSvgMarkup(node: SceneNode) {
    return tryExportSvgMarkup(node, "Boolean");
}

async function enrichFilledVectorExport(node: SceneNode, nodeJson: any) {
    if (!shouldUseSvgFallbackForFilledVector(nodeJson)) return;

    const svg = await tryExportSvgMarkup(node, "Filled vector");
    if (!svg) return;
    nodeJson.svgMarkup = svg;
    nodeJson.svgFallback = true;
    nodeJson.receiveCreateOverride = "SVG";
    nodeJson.vectorFallback = "svgMissingRegions";
}

function shouldUseSvgFallbackForFilledVector(nodeJson: any) {
    if (!nodeJson || nodeJson.receiveCreateOverride || nodeJson.svgFallback) return false;
    if (nodeJson.sourceType !== "PEN" && nodeJson.sourceType !== "VECTOR") return false;
    if (!hasVisibleFill(nodeJson.geometry && nodeJson.geometry.fills)) return false;

    const vectorNetwork = nodeJson.vectorNetwork;
    if (!vectorNetwork || !Array.isArray(vectorNetwork.segments) || vectorNetwork.segments.length < 2) return false;
    if (Array.isArray(vectorNetwork.regions) && vectorNetwork.regions.length > 0) return false;
    return true;
}

function hasVisibleFill(fills: any) {
    if (!Array.isArray(fills)) return false;
    return fills.some(fill => fill && fill.type && fill.visible !== false && (fill.opacity === undefined || fill.opacity > 0));
}

async function tryExportSvgMarkup(node: SceneNode, label: string) {
    if (totalNodes === 0 && label !== "Boolean") return "";
    if (totalNodes > SVG_FALLBACK_MAX_DOCUMENT_NODES) return "";

    const subtreeNodeCount = countExportableSubtreeNodes(node);
    const width = Number(safeRead(() => node.width, 0)) || 0;
    const height = Number(safeRead(() => node.height, 0)) || 0;
    const area = Math.abs(width * height);

    if (subtreeNodeCount <= SVG_FALLBACK_MAX_NODES &&
        area <= SVG_FALLBACK_MAX_AREA &&
        Math.max(Math.abs(width), Math.abs(height)) <= SVG_FALLBACK_MAX_DIMENSION) {
        try {
            logDebug(`    * [SVG-Export] calling exportAsync for ${node.id} (${node.type}) - name=${node.name}, dims=${width}x${height}`);
            const svg = await (node as any).exportAsync({ format: "SVG" });
            logDebug(`    * [SVG-Export] completed exportAsync for ${node.id}: bytes=${svg ? svg.length : 0}`);
            if (typeof svg === "string" && svg.trim()) {
                if (svg.length > SVG_FALLBACK_MAX_BYTES) {
                    console.warn(`[MasterGo2Figma] ${label} SVG fallback skipped because SVG is too large: ${getNodeDebugLabel(node)}, bytes=${svg.length}`);
                    return "";
                }
                return svg;
            }
        } catch (error) {
            logDebug(`    * [SVG-Export] exportAsync failed for ${node.id}:`, describeError(error));
            console.warn(`Unable to export ${label} as SVG fallback:`, getNodeDebugLabel(node), error);
        }
    }

    return "";
}

function markBooleanAsFrameFallback(nodeJson: any) {
    nodeJson.type = "FRAME";
    nodeJson.restoreType = "FRAME";
    nodeJson.receiveCreateOverride = "FRAME";
    nodeJson.booleanFallback = "frameContainer";
    nodeJson.clipsContent = false;
    clearNodePaint(nodeJson);
}

function clearNodePaint(nodeJson: any) {
    if (!nodeJson.geometry) return;
    nodeJson.geometry.fills = [];
    nodeJson.geometry.strokes = [];
    nodeJson.geometry.strokeWeight = 0;
    nodeJson.geometry.strokeTopWeight = undefined;
    nodeJson.geometry.strokeBottomWeight = undefined;
    nodeJson.geometry.strokeLeftWeight = undefined;
    nodeJson.geometry.strokeRightWeight = undefined;
}

function hasUsableVectorNetwork(vectorNetwork: any) {
    return !!(vectorNetwork &&
        Array.isArray(vectorNetwork.vertices) &&
        vectorNetwork.vertices.length > 0 &&
        Array.isArray(vectorNetwork.segments));
}

function countExportableSubtreeNodes(node: any) {
    let count = 1;
    const children = getSafeExportableChildren(node);
    for (const child of children) {
        count += countExportableSubtreeNodes(child);
        if (count > SVG_FALLBACK_MAX_NODES) return count;
    }
    return count;
}

async function appendLayerRecord(
    recordJson: string,
    pageIndex: ExportPageIndex,
    chunk: LayerChunkAccumulator,
    transfer: ExportTransferState
) {
    const nextBytes = recordJson.length + (chunk.recordJsons.length > 0 ? 1 : 0);
    if (recordJson.length > LAYER_CHUNK_MAX_BYTES) {
        logDiagnostic("warn", "[MasterGo2Figma] Single layer record exceeds chunk byte target", {
            recordBytes: recordJson.length,
            chunkMaxBytes: LAYER_CHUNK_MAX_BYTES,
            page: pageIndex.name,
            transfer: summarizeTransfer(transfer)
        });
    }
    if (chunk.recordJsons.length > 0 &&
        (chunk.recordJsons.length >= LAYER_CHUNK_MAX_RECORDS || chunk.bytes + nextBytes > LAYER_CHUNK_MAX_BYTES)) {
        await flushLayerChunk(pageIndex, chunk, transfer);
    }

    chunk.recordJsons.push(recordJson);
    chunk.bytes += nextBytes;

    if (chunk.recordJsons.length >= LAYER_CHUNK_MAX_RECORDS || chunk.bytes >= LAYER_CHUNK_MAX_BYTES) {
        await flushLayerChunk(pageIndex, chunk, transfer);
    }

}

async function flushLayerChunk(
    pageIndex: ExportPageIndex,
    chunk: LayerChunkAccumulator,
    transfer: ExportTransferState
) {
    if (chunk.recordJsons.length === 0) return;

    const fileIndex = chunk.chunkIndex++;
    const path = `pages/${chunk.pageFolder}/layers/layers-${padNumber(fileIndex)}.json`;
    const recordCount = chunk.recordJsons.length;
    const byteCount = chunk.bytes;
    setExportDebugState({
        phase: "chunk:flush",
        page: pageIndex.name,
        file: path,
        transferId: transfer.transferId,
        fileIndex: transfer.fileIndex,
        chunkIndex: fileIndex,
        fileSize: byteCount,
        streamedBytes: transfer.streamedBytes
    });
    if (fileIndex === 1 || fileIndex % 50 === 0 || byteCount >= LAYER_CHUNK_LOG_BYTES) {
        logDiagnostic("log", "[MasterGo2Figma] Layer chunk flush", {
            page: pageIndex.name,
            path,
            chunkIndex: fileIndex,
            records: recordCount,
            bytes: byteCount,
            processedNodes,
            transfer: summarizeTransfer(transfer)
        });
    }
    const contentParts = [
        `{"schema":"mastergo2figma.layers.v2","version":2,"pageId":${JSON.stringify(chunk.pageId)},"records":[`
    ];
    for (let index = 0; index < chunk.recordJsons.length; index++) {
        contentParts.push(index > 0 ? `,${chunk.recordJsons[index]}` : chunk.recordJsons[index]);
    }
    contentParts.push("]}");

    await streamExportFileToUI(transfer, { path, contentParts });
    pageIndex.layerChunks.push(path);
    chunk.recordJsons = [];
    chunk.bytes = 0;
}

function getDocumentPageSummaries() {
    return [...mg.document.children]
        .filter(page => !page.name.endsWith("_Process"))
        .map(page => ({
            id: page.id,
            name: page.name,
            isCurrent: page.id === mg.document.currentPage.id,
            childCount: page.children.length
        }));
}

function createPageFolderName(page: PageNode, index: number) {
    const label = safeRead(() => page.name, "") || safeRead(() => page.id, "page");
    return `page-${padNumber(index + 1)}-${slugifyPathPart(label)}`;
}

function createLayerFileName(node: SceneNode, index: number) {
    const label = safeRead(() => node.name, "") || safeRead(() => node.type, "untitled");
    return `layer-${padNumber(index)}-${slugifyPathPart(label)}.json`;
}

function padNumber(value: number) {
    const text = String(value);
    if (text.length >= 3) return text;
    return "000".slice(0, 3 - text.length) + text;
}

function slugifyPathPart(value: string) {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
        .replace(/^-+|-+$/g, "");

    return (normalized || "untitled").slice(0, 48);
}

function safeCloneTransform(transform: Transform | undefined): Transform | null {
    if (!transform) return null;
    return cloneTransform(transform);
}

function safeRead<T>(reader: () => T, fallback: T): T {
    try {
        const value = reader();
        return value === undefined || value === null ? fallback : value;
    } catch (error) {
        if (isOutOfMemoryError(error)) throw error;
        return fallback;
    }
}

function softRead<T>(reader: () => T, fallback: T): T {
    try {
        const value = reader();
        return value === undefined || value === null ? fallback : value;
    } catch (_) {
        return fallback;
    }
}

function readNodeProperty<T>(node: any, property: string, fallback: T): T {
    try {
        const value = node ? node[property] : undefined;
        return value === undefined || value === null ? fallback : value;
    } catch (error) {
        if (isOutOfMemoryError(error)) {
            logDiagnostic("error", "[MasterGo2Figma] Node property read OOM", {
                property,
                node: getNodeProbe(node),
                error: describeError(error),
                debugState: exportDebugState
            });
        }
        return fallback;
    }
}

function cloneJsonCompatible(value: any, fallback?: any, depth = 0): any {
    if (value === undefined) return fallback;
    if (value === null) return null;

    const valueType = typeof value;
    if (valueType === "string" || valueType === "boolean") return value;
    if (valueType === "number") return Number.isFinite(value) ? value : fallback;
    if (valueType !== "object") return fallback;
    if (depth > 32) return fallback;
    if (isTypedArrayLike(value)) return fallback;

    if (Array.isArray(value)) {
        const result: any[] = [];
        for (let index = 0; index < value.length; index++) {
            const cloned = cloneJsonCompatible(value[index], null, depth + 1);
            result.push(cloned);
        }
        return result;
    }

    let keys: string[] = [];
    try {
        keys = Object.keys(value);
    } catch (_) {
        return fallback;
    }

    const result: any = {};
    for (const key of keys) {
        const cloned = cloneJsonCompatible(value[key], undefined, depth + 1);
        if (cloned !== undefined) result[key] = cloned;
    }
    return result;
}

function isTypedArrayLike(value: any) {
    try {
        return typeof ArrayBuffer !== "undefined" &&
            typeof ArrayBuffer.isView === "function" &&
            ArrayBuffer.isView(value);
    } catch (_) {
        return false;
    }
}

function finiteNumber(value: any, fallback = 0) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallback;
}

function clamp01(value: any, fallback = 0) {
    const numberValue = finiteNumber(value, fallback);
    if (numberValue < 0) return 0;
    if (numberValue > 1) return 1;
    return numberValue;
}

function cloneRgbColor(color: any) {
    return {
        r: finiteNumber(color && color.r, 0),
        g: finiteNumber(color && color.g, 0),
        b: finiteNumber(color && color.b, 0)
    };
}

function cloneRgbaColor(color: any) {
    return {
        r: finiteNumber(color && color.r, 0),
        g: finiteNumber(color && color.g, 0),
        b: finiteNumber(color && color.b, 0),
        a: clamp01(color && color.a, 1)
    };
}

function cloneVector2(point: any) {
    return {
        x: finiteNumber(point && point.x, 0),
        y: finiteNumber(point && point.y, 0)
    };
}

function cloneGradientStops(stops: any) {
    if (!Array.isArray(stops)) return [];
    return stops.map(stop => ({
        position: clamp01(stop && stop.position, 0),
        color: cloneRgbaColor(stop && stop.color)
    }));
}

function cloneVectorNetworkForExport(vectorNetwork: any) {
    if (!vectorNetwork || typeof vectorNetwork !== "object") return undefined;
    return {
        vertices: cloneJsonCompatible(vectorNetwork.vertices, []),
        segments: cloneJsonCompatible(vectorNetwork.segments, []),
        regions: normalizeVectorRegions(vectorNetwork.regions)
    };
}

function sanitizeExportNodeJson(nodeJson: any) {
    if (!nodeJson || typeof nodeJson !== "object") return nodeJson;

    if (nodeJson.constraints !== undefined) nodeJson.constraints = cloneJsonCompatible(nodeJson.constraints, undefined);
    if (nodeJson.exportSettings !== undefined) nodeJson.exportSettings = cloneJsonCompatible(nodeJson.exportSettings, []);
    if (nodeJson.arcData !== undefined) nodeJson.arcData = cloneJsonCompatible(nodeJson.arcData, undefined);
    if (nodeJson.fontName !== undefined) nodeJson.fontName = cloneJsonCompatible(nodeJson.fontName, nodeJson.fontName);
    if (nodeJson.letterSpacing !== undefined) nodeJson.letterSpacing = cloneJsonCompatible(nodeJson.letterSpacing, nodeJson.letterSpacing);
    if (nodeJson.lineHeight !== undefined) nodeJson.lineHeight = cloneJsonCompatible(nodeJson.lineHeight, nodeJson.lineHeight);
    if (nodeJson.connectorStart !== undefined) nodeJson.connectorStart = cloneJsonCompatible(nodeJson.connectorStart, undefined);
    if (nodeJson.connectorEnd !== undefined) nodeJson.connectorEnd = cloneJsonCompatible(nodeJson.connectorEnd, undefined);
    if (nodeJson.connectorStartLocal !== undefined) nodeJson.connectorStartLocal = cloneJsonCompatible(nodeJson.connectorStartLocal, undefined);
    if (nodeJson.connectorEndLocal !== undefined) nodeJson.connectorEndLocal = cloneJsonCompatible(nodeJson.connectorEndLocal, undefined);

    if (nodeJson.vectorNetwork && !isPlainObjectForLog(nodeJson.vectorNetwork)) {
        nodeJson.vectorNetwork = cloneVectorNetworkForExport(nodeJson.vectorNetwork);
    }

    if (nodeJson.geometry) {
        if (nodeJson.geometry.fills !== undefined) nodeJson.geometry.fills = cloneJsonCompatible(nodeJson.geometry.fills, []);
        if (nodeJson.geometry.strokes !== undefined) nodeJson.geometry.strokes = cloneJsonCompatible(nodeJson.geometry.strokes, []);
        if (nodeJson.geometry.dashPattern !== undefined) nodeJson.geometry.dashPattern = cloneJsonCompatible(nodeJson.geometry.dashPattern, []);
    }

    if (nodeJson.blend && Array.isArray(nodeJson.blend.effects)) {
        nodeJson.blend.effects = cloneJsonCompatible(nodeJson.blend.effects, []);
    }

    return nodeJson;
}

function getNodeDebugLabel(node: any) {
    const name = softRead(() => node.name, "Untitled");
    const type = softRead(() => node.type, "UNKNOWN");
    const id = softRead(() => node.id, "unknown-id");
    return `${name} (${type}, ${id})`;
}

function stringifyLayerPayload(payload: any, node: SceneNode, nodeComplexity?: NodeComplexitySnapshot) {
    try {
        return JSON.stringify(payload);
    } catch (error) {
        const fatalOom = isOutOfMemoryError(error);
        logDiagnostic(fatalOom ? "error" : "warn", fatalOom ? "[MasterGo2Figma] Stringify OOM" : "[MasterGo2Figma] Stringify failed, exporting fallback", {
            error: describeError(error),
            complexity: nodeComplexity || createNodeComplexitySnapshot(node)
        });
        if (fatalOom) throw error;

        const fallbackPayload = {
            ...payload,
            props: createFallbackNodeJson(node, safeRead(() => node.type, "UNKNOWN"))
        };
        return JSON.stringify(fallbackPayload);
    }
}

function isGeneratedCarrierName(name: string) {
    return name.startsWith(INTERNAL_PROPS_PREFIX) || name.startsWith(SIBLING_PROPS_PREFIX);
}

function overrideExportLayoutFromSourceNode(nodeJson: any, node: SceneNode) {
    if (!nodeJson || !nodeJson.layout) return;

    try {
        const layoutTransform = cloneTransform((node as any).relativeTransform);
        nodeJson.layout.relativeTransform = layoutTransform;
        nodeJson.layout.x = layoutTransform[0][2];
        nodeJson.layout.y = layoutTransform[1][2];
        nodeJson.layout.rotation = -((node as any).rotation || 0);
        nodeJson.layout.width = node.width;
        nodeJson.layout.height = node.height;
        nodeJson.layout.constrainProportions = (node as any).constrainProportions || false;
    } catch (error) {
        if (isOutOfMemoryError(error)) throw error;
    }
}

let countVisited = 0;
async function countNodes(node: any) {
    totalNodes++;
    countVisited++;
    if (countVisited % EXPORT_SCAN_YIELD_EVERY_NODES === 0) await yieldToEventLoop();
    try {
        let childNodes = getSafeExportableChildren(node);
        for (let i = 0; i < childNodes.length; i++) {
            const child = childNodes[i];
            childNodes[i] = null as any;
            await countNodes(child);
        }
        childNodes = null as any;
    } catch (error) {
        const canMark = !!(error && typeof error === "object");
        if (!canMark || !(error as any).__mastergo2figmaScanLogged) {
            if (canMark) (error as any).__mastergo2figmaScanLogged = true;
            logDiagnostic("error", "[MasterGo2Figma] Scan node failed", {
                error: describeError(error),
                node: getNodeProbe(node),
                totalNodes
            });
        }
        throw error;
    }
}

function yieldToEventLoop() {
    return new Promise<void>(resolve => setTimeout(resolve, 0));
}

function getTopLevelSelectedNodes(selection: SceneNode[]) {
    const selectedSet = new Set(selection.map(node => node.id));
    return selection.filter(node => !hasSelectedAncestor(node, selectedSet));
}

function hasSelectedAncestor(node: SceneNode, selectedSet: Set<string>) {
    let parent = node.parent as any;
    while (parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT") {
        if (selectedSet.has(parent.id)) return true;
        parent = parent.parent;
    }
    return false;
}

function analyseNodes(node: SceneNode, sourceType?: string): any {
    try {
        return sanitizeExportNodeJson(analyseNodesUnsafe(node, sourceType));
    } catch (error) {
        if (isOutOfMemoryError(error)) {
            logDiagnostic("error", "[MasterGo2Figma] Analyse node OOM", {
                node: getNodeProbe(node),
                sourceType,
                error: describeError(error)
            });
            throw error;
        }
        logDiagnostic("warn", "[MasterGo2Figma] Unable to fully analyse node, exporting fallback", {
            node: getNodeProbe(node),
            sourceType,
            error: describeError(error),
            debugState: exportDebugState
        });
        return sanitizeExportNodeJson(createFallbackNodeJson(node, sourceType));
    }
}

function analyseNodesUnsafe(node: SceneNode, sourceType?: string): any {
    const resolvedSourceType = sourceType || node.type;
    const rule = getLayerRule(resolvedSourceType) || getLayerRule(node.type);
    if (!rule) {
        console.warn("Unsupported layer type:", resolvedSourceType, node.type);
        return {};
    }

    if (rule.sendStrategy === "flattenBoolean") return transBONode(node as any);
    if (rule.sendStrategy === "booleanTree") return transBooleanTreeNode(node as BooleanOperationNode, rule.restoreType);
    if (rule.sendStrategy === "penNetwork") return transPenNode(node as any, resolvedSourceType, rule.restoreType);
    if (rule.sendStrategy === "ellipseArc") return transEllipseNode(node as EllipseNode);
    if (rule.sendStrategy === "text") return transTextNode(node as TextNode);
    if (rule.sendStrategy === "star") return transStarNode(node as StarNode);
    if (rule.sendStrategy === "polygon") return transPolygonNode(node as PolygonNode);
    if (rule.sendStrategy === "connector") return transConnectorNode(node as ConnectorNode);
    if (rule.sendStrategy === "frameLike") return transFrameNode(node as any, resolvedSourceType);
    if (rule.sendStrategy === "groupLike") return transGroupNode(node as GroupNode);
    return getUniversalProperty(node, resolvedSourceType, rule.restoreType);
}

function createFallbackNodeJson(node: SceneNode, sourceType?: string) {
    const resolvedSourceType = sourceType || safeRead(() => node.type, "UNKNOWN");
    const restoreType = getRuleRestoreType(resolvedSourceType);
    const layoutTransform = safeRead(() => cloneTransform((node as any).relativeTransform), [[1, 0, 0], [0, 1, 0]] as Transform);

    return {
        type: restoreType,
        sourceType: resolvedSourceType,
        restoreType,
        id: safeRead(() => node.id, ""),
        name: safeRead(() => node.name, "Untitled"),
        parentID: safeRead(() => node.parent && node.parent.type === "PAGE" ? null : node.parent?.id, null),
        constraints: cloneJsonCompatible(safeRead(() => (node as any).constraints, undefined), undefined),
        exportSettings: [],
        scence: {
            visible: safeRead(() => node.isVisible, true),
            locked: safeRead(() => node.isLocked, false)
        },
        blend: {
            opacity: safeRead(() => (node as any).opacity, 1),
            isMask: safeRead(() => (node as any).isMask, false),
            blendMode: "NORMAL",
            effects: []
        },
        corner: {
            topLeftRadius: 0,
            topRightRadius: 0,
            bottomLeftRadius: 0,
            bottomRightRadius: 0,
            cornerRadius: 0,
            cornerSmoothing: 0
        },
        geometry: {
            fills: [],
            strokes: [],
            strokeWeight: 0,
            strokeAlign: "CENTER",
            strokeJoin: "MITER",
            dashPattern: [],
            strokeCap: "NONE",
            strokeTopWeight: undefined,
            strokeBottomWeight: undefined,
            strokeLeftWeight: undefined,
            strokeRightWeight: undefined
        },
        layout: {
            relativeTransform: layoutTransform,
            x: layoutTransform[0][2],
            y: layoutTransform[1][2],
            rotation: safeRead(() => -((node as any).rotation || 0), 0),
            width: safeRead(() => node.width, 0),
            height: safeRead(() => node.height, 0),
            constrainProportions: false,
            layoutMode: "NONE",
            itemSpacing: 0,
            paddingLeft: 0,
            paddingRight: 0,
            paddingTop: 0,
            paddingBottom: 0,
            primaryAxisAlignItems: "MIN",
            counterAxisAlignItems: "MIN",
            counterAxisAlignContent: "AUTO",
            primaryAxisSizingMode: "FIXED",
            counterAxisSizingMode: "FIXED",
            itemReverseZIndex: false,
            strokesIncludedInLayout: false,
            layoutAlign: "INHERIT",
            layoutGrow: 0,
            layoutPositioning: "AUTO"
        },
        fallbackExport: true
    };
}

function transBONode(node: BooleanOperationNode) {
    // Avoid clone + flatten here. Complex boolean operations can crash the
    // MasterGo host runtime during large exports; direct network data is safer.
    const json: any = transPenNode(node as any, "BOOLEAN_OPERATION", getRuleRestoreType("BOOLEAN_OPERATION"));
    json.booleanOperation = safeRead(() => node.booleanOperation, "UNION");
    return json;
}

function transBooleanTreeNode(node: BooleanOperationNode, restoreType: string) {
    const json: any = getUniversalProperty(node as any, "BOOLEAN_OPERATION", restoreType);
    json.booleanOperation = safeRead(() => node.booleanOperation, "UNION");
    return json;
}

function transPenNode(selection: PenNode, sourceType?: string, restoreType?: string) {
    const universalStruct = getUniversalProperty(selection, sourceType, restoreType)
    const originJson = (selection as any).penNetwork
    if (!originJson || !originJson.ctrlNodes || !originJson.nodes || !originJson.paths) {
        const vectorNetwork = cloneVectorNetworkForExport((selection as any).vectorNetwork);
        const resultStruct = Object.assign(vectorNetwork ? { vectorNetwork } : {}, universalStruct);
        resultStruct.type = restoreType || getRuleRestoreType(sourceType || selection.type);
        return resultStruct;
    }

    const originCtrlNodes = originJson.ctrlNodes
    const originNodes = originJson.nodes
    const originPaths = originJson.paths
    const resultSegments = new Array()

    for (var j = 0; j < originPaths.length; j++) {
        var tempStart = originPaths[j][0]
        var tempEnd = originPaths[j][3]
        var tempTangentStart = { x: 0, y: 0 }
        var tempTangentEnd = { x: 0, y: 0 }

        if (originPaths[j][1] != -1) {
            tempTangentStart.x = originCtrlNodes[originPaths[j][1]].x - originNodes[tempStart].x
            tempTangentStart.y = originCtrlNodes[originPaths[j][1]].y - originNodes[tempStart].y
        }
        if (originPaths[j][2] != -1) {
            tempTangentEnd.x = originCtrlNodes[originPaths[j][2]].x - originNodes[tempEnd].x
            tempTangentEnd.y = originCtrlNodes[originPaths[j][2]].y - originNodes[tempEnd].y
        }

        resultSegments.push({
            start: tempStart,
            end: tempEnd,
            tangentStart: tempTangentStart,
            tangentEnd: tempTangentEnd
        })
    }
    const finalPathJson = {
        "segments": resultSegments,
        "vertices": cloneJsonCompatible(originNodes, []),
        "regions": normalizeVectorRegions(originJson.regions)
    }

    const otherStruct = {
        "vectorNetwork": finalPathJson
    }

    const resultStruct = Object.assign(otherStruct, universalStruct)
    resultStruct.type = restoreType || getRuleRestoreType(sourceType || selection.type);
    return resultStruct
}

function normalizeVectorRegions(regions: any) {
    if (!Array.isArray(regions)) return [];

    const result: any[] = [];
    for (const region of regions) {
        if (!region || typeof region !== "object") continue;
        const loops = normalizeVectorRegionLoops(region.loops);
        if (loops.length === 0) continue;
        result.push({
            windingRule: normalizeWindingRuleForFigma(region.windingRule),
            loops
        });
    }
    return result;
}

function normalizeVectorRegionLoops(loops: any) {
    if (!Array.isArray(loops)) return [];

    const result: number[][] = [];
    for (const loop of loops) {
        if (!Array.isArray(loop)) continue;
        const segmentIndexes = loop
            .map((value: any) => Number(value))
            .filter((value: number) => Number.isFinite(value));
        if (segmentIndexes.length > 0) result.push(segmentIndexes);
    }
    return result;
}

function normalizeWindingRuleForFigma(value: any) {
    if (value === "Evenodd" || value === "EVENODD") return "EVENODD";
    if (value === "Nonzero" || value === "NONZERO") return "NONZERO";
    return "NONZERO";
}

function transEllipseNode(selection: EllipseNode) {
    const universalStruct = getUniversalProperty(selection)
    const otherStruct = { "arcData": cloneJsonCompatible(selection.arcData, undefined) }
    return Object.assign(otherStruct, universalStruct)
}

function transRectangleNode(selection: RectangleNode) {
    const universalStruct = getUniversalProperty(selection)
    return Object.assign({}, universalStruct)
}

function transStarNode(selection: StarNode) {
    const universalStruct = getUniversalProperty(selection)
    const otherStruct = {
        "pointCount": selection.pointCount,
        "innerRadius": selection.innerRadius
    }
    return Object.assign(otherStruct, universalStruct)
}

function transLineNode(selection: LineNode) {
    const universalStruct = getUniversalProperty(selection)
    return Object.assign({}, universalStruct)
}

function transPolygonNode(selection: PolygonNode) {
    const universalStruct = getUniversalProperty(selection)
    const otherStruct = { "pointCount": selection.pointCount }
    return Object.assign(otherStruct, universalStruct)
}

function transFrameNode(selection: FrameNode | InstanceNode | ComponentNode, sourceType?: string) {
    const universalStruct = getUniversalProperty(selection, sourceType)
    const otherStruct = { "clipsContent": (selection as any).clipsContent }
    return Object.assign(otherStruct, universalStruct)
}

function transSectionNode(selection: SectionNode) {
    const universalStruct = getUniversalProperty(selection, "SECTION", "SECTION")
    const otherStruct = { "clipsContent": (selection as any).clipsContent }
    return Object.assign(otherStruct, universalStruct)
}

function transGroupNode(selection: GroupNode) {
    const universalStruct = getUniversalProperty(selection, "GROUP", "GROUP")
    const otherStruct = { "clipsContent": false }
    return Object.assign(otherStruct, universalStruct)
}

function transSliceNode(selection: SliceNode) {
    return getUniversalProperty(selection, "SLICE", "SLICE")
}

function transConnectorNode(selection: ConnectorNode) {
    const universalStruct = getUniversalProperty(selection, "CONNECTOR", "CONNECTOR");
    const connectorStart = normalizeConnectorEndpoint((selection as any).connectorStart);
    const connectorEnd = normalizeConnectorEndpoint((selection as any).connectorEnd);
    const connectorLineType = (selection as any).connectorLineType || "ELBOWED";
    const connectorCornerRadius = (selection as any).cornerRadius || 0;
    const connectorStartStrokeCap = (selection as any).connectorStartStrokeCap || "NONE";
    const connectorEndStrokeCap = (selection as any).connectorEndStrokeCap || "NONE";
    const otherStruct = {
        "connectorStart": connectorStart,
        "connectorEnd": connectorEnd,
        "connectorStartLocal": connectorEndpointToLocalPoint(selection, connectorStart, true),
        "connectorEndLocal": connectorEndpointToLocalPoint(selection, connectorEnd, false),
        "connectorStartStrokeCap": connectorStartStrokeCap,
        "connectorEndStrokeCap": connectorEndStrokeCap,
        "connectorLineType": connectorLineType,
        "connectorCornerRadius": connectorCornerRadius
    };
    (otherStruct as any).vectorNetwork = createConnectorVectorNetwork(
        otherStruct.connectorStartLocal,
        otherStruct.connectorEndLocal,
        connectorStart,
        connectorEnd,
        connectorLineType,
        connectorCornerRadius,
        connectorStartStrokeCap,
        connectorEndStrokeCap
    );
    return Object.assign(otherStruct, universalStruct);
}

function connectorEndpointToLocalPoint(selection: ConnectorNode, endpoint: any, isStart: boolean) {
    const point = endpoint && endpoint.position ? endpoint.position : null;
    if (point) return absolutePointToNodeLocal(selection, point);

    const width = Number(safeRead(() => selection.width, 0)) || 0;
    const height = Number(safeRead(() => selection.height, 0)) || 0;
    return isStart ? { x: 0, y: 0 } : { x: width, y: height };
}

function absolutePointToNodeLocal(node: SceneNode, point: { x: number; y: number }) {
    const transform = safeRead(() => (node as any).absoluteTransform, null as any);
    if (!transform || !transform[0] || !transform[1]) return { x: Number(point.x) || 0, y: Number(point.y) || 0 };

    const a = Number(transform[0][0]) || 0;
    const c = Number(transform[0][1]) || 0;
    const e = Number(transform[0][2]) || 0;
    const b = Number(transform[1][0]) || 0;
    const d = Number(transform[1][1]) || 0;
    const f = Number(transform[1][2]) || 0;
    const det = a * d - b * c;
    if (Math.abs(det) < 0.000001) return { x: (Number(point.x) || 0) - e, y: (Number(point.y) || 0) - f };

    const dx = (Number(point.x) || 0) - e;
    const dy = (Number(point.y) || 0) - f;
    return {
        x: (d * dx - c * dy) / det,
        y: (-b * dx + a * dy) / det
    };
}

function createConnectorVectorNetwork(
    start: any,
    end: any,
    startEndpoint: any,
    endEndpoint: any,
    lineType: string,
    cornerRadius: number,
    startStrokeCap: string,
    endStrokeCap: string
) {
    const points = createConnectorRoutePoints(start, end, startEndpoint, endEndpoint, lineType);
    const vertices = points.map((point, index) => {
        const vertex: any = { x: point.x, y: point.y };
        if (index === 0) vertex.strokeCap = normalizeConnectorVectorStrokeCap(startStrokeCap);
        if (index === points.length - 1) vertex.strokeCap = normalizeConnectorVectorStrokeCap(endStrokeCap);
        if (index > 0 && index < points.length - 1) {
            const radius = getConnectorCornerRadius(points, index, cornerRadius);
            if (radius > 0) vertex.cornerRadius = radius;
        }
        return vertex;
    });

    const segments: any[] = [];
    for (let index = 0; index < points.length - 1; index++) {
        segments.push({ start: index, end: index + 1, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } });
    }

    return { vertices, segments, regions: [] };
}

function createConnectorRoutePoints(start: any, end: any, startEndpoint: any, endEndpoint: any, lineType: string) {
    const startPoint = normalizeConnectorPoint(start);
    const endPoint = normalizeConnectorPoint(end);
    if (lineType !== "ELBOWED" || isSameConnectorAxis(startPoint, endPoint)) return dedupeConnectorPoints([startPoint, endPoint]);

    const horizontalFirst = shouldConnectorRouteStartHorizontal(startPoint, endPoint, startEndpoint, endEndpoint);
    const middlePoint = horizontalFirst
        ? { x: endPoint.x, y: startPoint.y }
        : { x: startPoint.x, y: endPoint.y };

    return dedupeConnectorPoints([startPoint, middlePoint, endPoint]);
}

function normalizeConnectorPoint(point: any) {
    return {
        x: Number(point && point.x) || 0,
        y: Number(point && point.y) || 0
    };
}

function isSameConnectorAxis(start: any, end: any) {
    return Math.abs(start.x - end.x) < 0.01 || Math.abs(start.y - end.y) < 0.01;
}

function shouldConnectorRouteStartHorizontal(start: any, end: any, startEndpoint: any, endEndpoint: any) {
    const startMagnet = startEndpoint && startEndpoint.magnet;
    if (startMagnet === "LEFT" || startMagnet === "RIGHT") return true;
    if (startMagnet === "TOP" || startMagnet === "BOTTOM") return false;

    const endMagnet = endEndpoint && endEndpoint.magnet;
    if (endMagnet === "TOP" || endMagnet === "BOTTOM") return true;
    if (endMagnet === "LEFT" || endMagnet === "RIGHT") return false;

    return Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
}

function dedupeConnectorPoints(points: Array<{ x: number; y: number }>) {
    const result: Array<{ x: number; y: number }> = [];
    for (const point of points) {
        const previous = result[result.length - 1];
        if (!previous || Math.abs(previous.x - point.x) >= 0.01 || Math.abs(previous.y - point.y) >= 0.01) {
            result.push(point);
        }
    }
    return result.length > 1 ? result : [points[0], points[points.length - 1]];
}

function getConnectorCornerRadius(points: Array<{ x: number; y: number }>, index: number, requestedRadius: number) {
    const radius = Number(requestedRadius) || 0;
    if (radius <= 0) return 0;

    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    const previousLength = Math.abs(current.x - previous.x) + Math.abs(current.y - previous.y);
    const nextLength = Math.abs(next.x - current.x) + Math.abs(next.y - current.y);
    return Math.min(radius, previousLength / 2, nextLength / 2);
}

function normalizeConnectorVectorStrokeCap(value: any) {
    if (value === "ARROW_EQUILATERAL" ||
        value === "ARROW_LINES" ||
        value === "TRIANGLE_FILLED" ||
        value === "DIAMOND_FILLED" ||
        value === "CIRCLE_FILLED" ||
        value === "ROUND" ||
        value === "SQUARE" ||
        value === "NONE") {
        return value;
    }

    if (value === "LINE_ARROW" || value === "LINE") return "ARROW_LINES";
    if (value === "TRIANGLE_ARROW") return "ARROW_EQUILATERAL";
    if (value === "DIAMOND") return "DIAMOND_FILLED";
    if (value === "ROUND_ARROW" || value === "RING") return "CIRCLE_FILLED";
    return "NONE";
}

function normalizeConnectorEndpoint(endpoint: any) {
    if (!endpoint || typeof endpoint !== "object") return undefined;

    const result: any = {};
    if (endpoint.position) {
        result.position = {
            x: Number(endpoint.position.x) || 0,
            y: Number(endpoint.position.y) || 0
        };
    }
    if (typeof endpoint.endpointNodeId === "string" && endpoint.endpointNodeId) {
        result.endpointNodeId = endpoint.endpointNodeId;
    }
    if (typeof endpoint.magnet === "string" && endpoint.magnet) {
        result.magnet = endpoint.magnet;
    }
    return result.position || result.endpointNodeId ? result : undefined;
}

function transTextNode(selection: TextNode) {
    const universalStruct = getUniversalProperty(selection)
    const textStyles = readNodeProperty<any[]>(selection, "textStyles", []);
    let tempFontName = cloneJsonCompatible(textStyles?.[0]?.textStyle?.fontName, undefined);

    if (tempFontName && tempFontName.family == "AlibabaPuHuiTi") {
        tempFontName = {
            family: "Alibaba PuHuiTi",
            style: tempFontName.style
        }
    }

    const style = textStyles?.[0]?.textStyle || {};

    const otherStruct = {
        "textAlignHorizontal": readNodeProperty(selection, "textAlignHorizontal", "LEFT"),
        "textAlignVertical": readNodeProperty(selection, "textAlignVertical", "TOP"),
        "textAutoResize": readNodeProperty(selection, "textAutoResize", "NONE"),
        "paragraphIndent": 0,
        "paragraphSpacing": readNodeProperty(selection, "paragraphSpacing", 0),
        "autoRename": false,
        "characters": readNodeProperty(selection, "characters", ""),
        "fontSize": style.fontSize,
        "fontName": tempFontName,
        "fontWeight": style.fontWeight,
        "textCase": style.textCase,
        "textDecoration": style.textDecoration,
        "letterSpacing": cloneJsonCompatible(style.letterSpacing, style.letterSpacing),
        "lineHeight": cloneJsonCompatible(style.lineHeight, style.lineHeight),
    }

    return Object.assign(otherStruct, universalStruct)
}

function transBooleanNode(selection: BooleanOperationNode) {
    const universalStruct = getUniversalProperty(selection)
    const otherStruct = { "booleanOperation": selection.booleanOperation }
    return Object.assign(otherStruct, universalStruct)
}

function createImageAssetContext(): ImageAssetContext {
    return {
        bySourceRef: {},
        assets: [],
        missingImageAssetCount: 0
    };
}

function createImageFillJson(fill: any) {
    const result: any = {
        "blendMode": processBlendMode(fill.blendMode),
        "opacity": fill.alpha ?? 1,
        "type": "IMAGE",
        "scaleMode": normalizeImageScaleModeForFigma(fill.scaleMode),
        "visible": fill.isVisible ?? true
    };

    if (fill.filters) result.filters = cloneJsonCompatible(fill.filters, undefined);
    if (fill.rotation !== undefined) result.rotation = finiteNumber(fill.rotation, 0);
    if (fill.ratio !== undefined) result.ratio = finiteNumber(fill.ratio, 1);

    const sourceRef = typeof fill.imageRef === "string" ? fill.imageRef : "";
    if (!sourceRef || !activeImageAssetContext || !ENABLE_IMAGE_EXPORT) {
        markMissingImageFill(result, "missing-image");
        return result;
    }

    const asset = registerImageAsset(sourceRef);
    result.imageRef = asset.key;
    return result;
}

function normalizeImageScaleModeForFigma(value: any) {
    if (value === "FILL" || value === "FIT" || value === "CROP" || value === "TILE") return value;
    if (value === "STRETCH") return "FILL";
    if (value === "CENTER") return "FIT";
    return "FILL";
}

function registerImageAsset(sourceRef: string): ImageAssetRecord {
    const context = activeImageAssetContext as ImageAssetContext;
    const existing = context.bySourceRef[sourceRef];
    if (existing) return existing;

    const index = context.assets.length + 1;
    const key = `image-${padNumber(index)}`;
    const fileName = `${key}.bin`;
    const asset: ImageAssetRecord = {
        key,
        sourceRef,
        index,
        fileName,
        path: `assets/${fileName}`,
        bytes: null,
        missing: false
    };

    context.bySourceRef[sourceRef] = asset;
    context.assets.push(asset);
    return asset;
}

async function loadAndStreamImageAsset(asset: ImageAssetRecord, context: ImageAssetContext, transfer: ExportTransferState) {
    let bytes: Uint8Array | null = null;
    try {
        setExportDebugState({
            phase: "asset:get-image",
            file: asset.path,
            transferId: transfer.transferId,
            fileIndex: transfer.fileIndex,
            streamedBytes: transfer.streamedBytes
        });
        const image = mg.getImageByHref(asset.sourceRef);
        if (!image || typeof image.getBytesAsync !== "function") throw new Error("图片资源不可读取");

        setExportDebugState({
            phase: "asset:get-bytes",
            file: asset.path,
            transferId: transfer.transferId,
            fileIndex: transfer.fileIndex,
            streamedBytes: transfer.streamedBytes
        });
        bytes = await image.getBytesAsync();
        if (!bytes || bytes.length === 0) throw new Error("图片资源为空");
    } catch (error) {
        markImageAssetMissing(asset, context, "read", error);
        return;
    }

    const extension = detectImageExtension(bytes);
    asset.bytes = bytes;
    asset.fileName = `image-${padNumber(asset.index)}.${extension}`;
    asset.path = `assets/${asset.fileName}`;

    try {
        await streamExportFileToUI(transfer, {
            path: asset.path,
            bytes
        });
    } catch (error) {
        asset.bytes = null;
        logDiagnostic("error", "[MasterGo2Figma] Unable to transfer image asset", {
            sourceRef: asset.sourceRef,
            assetKey: asset.key,
            path: asset.path,
            error: describeError(error),
            debugState: exportDebugState
        });
        throw error;
    }
}

function markImageAssetMissing(asset: ImageAssetRecord, context: ImageAssetContext, reason: "read", error: any) {
    asset.missing = true;
    asset.bytes = null;
    asset.fileName = `missing-image-${padNumber(asset.index)}.png`;
    asset.path = `assets/${asset.fileName}`;
    context.missingImageAssetCount++;
    logDiagnostic("warn", "[MasterGo2Figma] Unable to export image asset", {
        reason,
        sourceRef: asset.sourceRef,
        assetKey: asset.key,
        error: describeError(error),
        debugState: exportDebugState
    });
}

function markMissingImageFill(fill: any, fileName: string, shouldCount = true) {
    fill.imageRef = fileName;
    fill.missingAsset = true;
    if (shouldCount && activeImageAssetContext) activeImageAssetContext.missingImageAssetCount++;
}

function detectImageExtension(bytes: Uint8Array) {
    if (bytes.length >= 8 &&
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
        return "png";
    }

    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
    if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "gif";
    if (bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return "webp";
    }

    return "bin";
}

function fillsAndStrokes2Json(fills: readonly Paint[] | typeof mg.mixed, strokes: readonly Paint[]) {
    const resultFills: any[] = []
    if (Array.isArray(fills)) {
        for (const fill of fills) {
            let tempResultFill: any = {}
            if (fill.type == "SOLID") {
                tempResultFill = {
                    "type": fill.type,
                    "visible": fill.isVisible,
                    "opacity": clamp01(fill.color && fill.color.a, 1),
                    "blendMode": processBlendMode(fill.blendMode),
                    "color": cloneRgbColor(fill.color)
                }
            } else if (fill.type == "GRADIENT_LINEAR") {
                tempResultFill = {
                    "type": fill.type,
                    "visible": fill.isVisible,
                    "opacity": clamp01(fill.alpha, 1),
                    "blendMode": processBlendMode(fill.blendMode),
                    "gradientStops": cloneGradientStops(fill.gradientStops),
                    "gradientTransform": getResultArrayByTwoPoint(fill.gradientHandlePositions || [])
                }
            } else if (fill.type == "GRADIENT_RADIAL" || fill.type == "GRADIENT_ANGULAR" || fill.type == "GRADIENT_DIAMOND") {
                tempResultFill = {
                    "type": fill.type,
                    "visible": fill.isVisible,
                    "opacity": clamp01(fill.alpha, 1),
                    "blendMode": processBlendMode(fill.blendMode),
                    "gradientStops": cloneGradientStops(fill.gradientStops),
                    "gradientTransform": [[0, 1, 0], [-1, 0, 1]]
                }
            } else if (fill.type == "IMAGE") {
                tempResultFill = createImageFillJson(fill)
            }
            if (tempResultFill.type) resultFills.push(tempResultFill)
        }
    }

    const resultStrokes: any[] = []
    if (Array.isArray(strokes)) {
        for (const stroke of strokes) {
            let tempResultStroke: any = {}
            if (stroke.type == "SOLID") {
                tempResultStroke = {
                    "type": stroke.type,
                    "visible": stroke.isVisible,
                    "opacity": clamp01(stroke.color && stroke.color.a, 1),
                    "blendMode": processBlendMode(stroke.blendMode),
                    "color": cloneRgbColor(stroke.color)
                }
            } else if (stroke.type == "GRADIENT_LINEAR") {
                tempResultStroke = {
                    "type": stroke.type,
                    "visible": stroke.isVisible,
                    "opacity": clamp01(stroke.alpha, 1),
                    "blendMode": processBlendMode(stroke.blendMode),
                    "gradientStops": cloneGradientStops(stroke.gradientStops),
                    "gradientTransform": getResultArrayByTwoPoint(stroke.gradientHandlePositions || [])
                }
            } else if (stroke.type == "GRADIENT_RADIAL" || stroke.type == "GRADIENT_ANGULAR" || stroke.type == "GRADIENT_DIAMOND") {
                tempResultStroke = {
                    "type": stroke.type,
                    "visible": stroke.isVisible,
                    "opacity": clamp01(stroke.alpha, 1),
                    "blendMode": processBlendMode(stroke.blendMode),
                    "gradientStops": cloneGradientStops(stroke.gradientStops),
                    "gradientTransform": [[0, 1, 0], [-1, 0, 1]]
                }
            }
            if (tempResultStroke.type) resultStrokes.push(tempResultStroke)
        }
    }

    return { fills: resultFills, strokes: resultStrokes }
}

function rountGradientStops(gradientStops: ColorStop[]) {
    return gradientStops.map(stop => ({
        position: stop.position > 1 ? 1 : stop.position,
        color: { ...stop.color, a: stop.color.a > 1 ? 1 : stop.color.a }
    }));
}

function getResultArrayByTwoPoint(points: readonly Vector[]) {
    if (points == undefined || points.length < 2) {
        return [[1, 0, 0], [0, 1, 0]]
    }
    const first = cloneVector2(points[0]);
    const second = cloneVector2(points[1]);
    var x3 = first.x, y3 = first.y, x4 = second.x, y4 = second.y;
    const m1 = [[1, 0, 0], [0, 1, 0.5], [0, 0, 1]]
    const len = Math.sqrt((x4 - x3) ** 2 + (y4 - y3) ** 2)
    if (!Number.isFinite(len) || len <= 0) return [[1, 0, 0], [0, 1, 0]]
    const m2 = [[1 / len, 0, 0], [0, 1, 0], [0, 0, 1]]
    const sina = (y3 - y4) / len, cosa = (x4 - x3) / len
    const m3 = [[cosa, -sina, 0], [sina, cosa, 0], [0, 0, 1]]
    const m4 = [[1, 0, -x3], [0, 1, -y3], [0, 0, 1]]

    const m12 = matrixMultiplication(m2, m1)
    const m123 = matrixMultiplication(m12, m3)
    const m1234 = matrixMultiplication(m123, m4)
    return [m1234[0], m1234[1]]

    function matrixMultiplication(m1: number[][], m2: number[][]) {
        let res: number[][] = [];
        for (let i = 0; i < m1.length; i++) {
            res[i] = [];
            for (let j = 0; j < m2[0].length; j++) {
                let sum = 0;
                for (let k = 0; k < m2.length; k++) sum += m1[i][k] * m2[k][j];
                res[i][j] = sum;
            }
        }
        return res;
    }
}

function getUniversalProperty(selection: SceneNode, sourceType?: string, restoreType?: string) {
    const resolvedSourceType = sourceType || readNodeProperty(selection, "type", "UNKNOWN")
    const resolvedRestoreType = restoreType || getRestoreType(resolvedSourceType)
    const layoutTransform = getRelativeLayoutTransform(selection)
    const fills = readNodeProperty<any[]>(selection, "fills", [])
    const strokes = readNodeProperty<any[]>(selection, "strokes", [])
    var tFS = fillsAndStrokes2Json(fills, strokes)

    var fourCR = {
        tl: readNodeProperty(selection, "topLeftRadius", 0) || 0,
        tr: readNodeProperty(selection, "topRightRadius", 0) || 0,
        bl: readNodeProperty(selection, "bottomLeftRadius", 0) || 0,
        br: readNodeProperty(selection, "bottomRightRadius", 0) || 0
    }

    var resCR: number = readNodeProperty(selection, "cornerRadius", 0) || 0
    if (resCR as any === "Symbol(mg.mixed)") resCR = -1

    var resCS = readNodeProperty(selection, "cornerSmooth", 0) || 0

    var effectsArray: any[] = []
    const effects = readNodeProperty<any[]>(selection, "effects", [])
    for (const tE of effects) {
        if (tE.type == "DROP_SHADOW" || tE.type == "INNER_SHADOW") {
            effectsArray.push({
                "type": tE.type,
                "color": cloneRgbaColor(tE.color),
                "offset": cloneVector2(tE.offset),
                "radius": finiteNumber(tE.radius, 0),
                "spread": finiteNumber(tE.spread, 0),
                "visible": tE.isVisible,
                "blendMode": processBlendMode(tE.blendMode)
            })
        } else if (tE.type == 'LAYER_BLUR' || tE.type == 'BACKGROUND_BLUR') {
            effectsArray.push({ "type": tE.type, "radius": finiteNumber(tE.radius, 0), "visible": tE.isVisible })
        }
    }

    return {
        "type": resolvedRestoreType,
        "sourceType": resolvedSourceType,
        "restoreType": resolvedRestoreType,
        "id": readNodeProperty(selection, "id", ""),
        "name": readNodeProperty(selection, "name", "Untitled"),
        "parentID": safeRead(() => selection.parent && selection.parent.type == "PAGE" ? null : selection.parent?.id, null),
        "constraints": cloneJsonCompatible(readNodeProperty(selection, "constraints", undefined), undefined),
        "exportSettings": cloneJsonCompatible(readNodeProperty<any[]>(selection, "exportSettings", []), []),
        "scence": {
            "visible": readNodeProperty(selection, "isVisible", true),
            "locked": readNodeProperty(selection, "isLocked", false)
        },
        "blend": {
            "opacity": readNodeProperty(selection, "opacity", 1),
            "isMask": readNodeProperty(selection, "isMask", false) || false,
            "blendMode": processBlendMode(readNodeProperty(selection, "blendMode", "NORMAL")),
            "effects": effectsArray
        },
        "corner": {
            "topLeftRadius": fourCR.tl, "topRightRadius": fourCR.tr,
            "bottomLeftRadius": fourCR.bl, "bottomRightRadius": fourCR.br,
            "cornerRadius": resCR, "cornerSmoothing": resCS
        },
        "geometry": {
            "fills": tFS.fills, "strokes": tFS.strokes,
            "strokeWeight": readNodeProperty(selection, "strokeWeight", 0) || 0,
            "strokeAlign": readNodeProperty(selection, "strokeAlign", "CENTER"),
            "strokeJoin": readNodeProperty(selection, "strokeJoin", "MITER"),
            "dashPattern": cloneJsonCompatible(readNodeProperty<any[]>(selection, "strokeDashes", []), []),
            "strokeCap": readNodeProperty(selection, "strokeCap", "NONE"),
            "strokeTopWeight": ((selection as any).strokeTopWeight !== undefined) ? readNodeProperty(selection, "strokeTopWeight", 0) : undefined,
            "strokeBottomWeight": ((selection as any).strokeBottomWeight !== undefined) ? readNodeProperty(selection, "strokeBottomWeight", 0) : undefined,
            "strokeLeftWeight": ((selection as any).strokeLeftWeight !== undefined) ? readNodeProperty(selection, "strokeLeftWeight", 0) : undefined,
            "strokeRightWeight": ((selection as any).strokeRightWeight !== undefined) ? readNodeProperty(selection, "strokeRightWeight", 0) : undefined,
        },
        "layout": {
            "relativeTransform": layoutTransform,
            "x": layoutTransform[0][2], "y": layoutTransform[1][2],
            "rotation": -readNodeProperty(selection, "rotation", 0) || 0,
            "width": readNodeProperty(selection, "width", 0),
            "height": readNodeProperty(selection, "height", 0),
            "constrainProportions": readNodeProperty(selection, "constrainProportions", false) || false,
            "layoutMode": getLayoutMode(selection as any),
            "itemSpacing": readNodeProperty(selection, "itemSpacing", 0) || 0,
            "paddingLeft": readNodeProperty(selection, "paddingLeft", 0) || 0,
            "paddingRight": readNodeProperty(selection, "paddingRight", 0) || 0,
            "paddingTop": readNodeProperty(selection, "paddingTop", 0) || 0,
            "paddingBottom": readNodeProperty(selection, "paddingBottom", 0) || 0,
            "primaryAxisAlignItems": getAxisAlign(readNodeProperty(selection, "primaryAxisAlignItems", readNodeProperty(selection, "mainAxisAlignItems", "MIN"))),
            "counterAxisAlignItems": getAxisAlign(readNodeProperty(selection, "counterAxisAlignItems", readNodeProperty(selection, "crossAxisAlignItems", "MIN"))),
            "counterAxisAlignContent": getCounterAxisAlignContent(selection as any),
            "primaryAxisSizingMode": readNodeProperty(selection, "primaryAxisSizingMode", readNodeProperty(selection, "mainAxisSizingMode", "FIXED")),
            "counterAxisSizingMode": readNodeProperty(selection, "counterAxisSizingMode", readNodeProperty(selection, "crossAxisSizingMode", "FIXED")),
            "itemReverseZIndex": readNodeProperty(selection, "itemReverseZIndex", false) || false,
            "strokesIncludedInLayout": readNodeProperty(selection, "strokesIncludedInLayout", false) || false,
            "layoutAlign": getLayoutAlign(readNodeProperty(selection, "layoutAlign", readNodeProperty(selection, "alignSelf", "INHERIT"))),
            "layoutGrow": readNodeProperty(selection, "layoutGrow", readNodeProperty(selection, "flexGrow", 0)),
            "layoutPositioning": readNodeProperty(selection, "layoutPositioning", "AUTO")
        }
    }
}

function getRelativeLayoutTransform(selection: SceneNode) {
    // MasterGo reports absoluteTransform inconsistently for some grouped node
    // types. The node's own relativeTransform is the reliable local transform
    // and is also what we use when replacing the layer with a JSON text marker.
    return cloneTransform(readNodeProperty(selection, "relativeTransform", [[1, 0, 0], [0, 1, 0]] as Transform));
}

function overrideLayoutTransform(nodeJson: any, transform: Transform) {
    if (!nodeJson || !nodeJson.layout || !transform) return;

    const layoutTransform = cloneTransform(transform);
    nodeJson.layout.relativeTransform = layoutTransform;
    nodeJson.layout.x = layoutTransform[0][2];
    nodeJson.layout.y = layoutTransform[1][2];
}

function cloneTransform(transform: Transform): Transform {
    return [
        [transform[0][0], transform[0][1], transform[0][2]],
        [transform[1][0], transform[1][1], transform[1][2]]
    ];
}

function getRestoreType(sourceType: string) {
    return getRuleRestoreType(sourceType);
}

function getLayoutMode(selection: any) {
    const layoutMode = readNodeProperty<string>(selection, "layoutMode", readNodeProperty<string>(selection, "flexMode", "NONE"));
    if (layoutMode === "ROW") return "HORIZONTAL";
    if (layoutMode === "COLUMN") return "VERTICAL";
    return layoutMode;
}

function getAxisAlign(value: string) {
    if (value === "FLEX_START") return "MIN";
    if (value === "FLEX_END") return "MAX";
    if (value === "SPACING_BETWEEN") return "SPACE_BETWEEN";
    return value;
}

function getCounterAxisAlignContent(selection: any) {
    return readNodeProperty(selection, "counterAxisAlignContent", readNodeProperty(selection, "crossAxisAlignContent", "AUTO"));
}

function getLayoutAlign(value: string) {
    if (value === "STRETCH" || value === "INHERIT") return value;
    return getAxisAlign(value);
}

function multiplyTransform(a: Transform, b: Transform): Transform {
    return [
        [
            a[0][0] * b[0][0] + a[0][1] * b[1][0],
            a[0][0] * b[0][1] + a[0][1] * b[1][1],
            a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2]
        ],
        [
            a[1][0] * b[0][0] + a[1][1] * b[1][0],
            a[1][0] * b[0][1] + a[1][1] * b[1][1],
            a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2]
        ]
    ];
}

function invertTransform(transform: Transform): Transform {
    const a = transform[0][0];
    const b = transform[0][1];
    const c = transform[0][2];
    const d = transform[1][0];
    const e = transform[1][1];
    const f = transform[1][2];
    const det = a * e - b * d;

    if (Math.abs(det) < 0.000001) return [[1, 0, 0], [0, 1, 0]];

    return [
        [e / det, -b / det, (b * f - e * c) / det],
        [-d / det, a / det, (d * c - a * f) / det]
    ];
}

function createJsonCarrierFrame(name: string) {
    const frame = mg.createFrame();
    frame.name = name;
    frame.fills = [{
        type: "SOLID",
        color: { r: 0, g: 0, b: 0, a: 0.1 }
    }];
    return frame;
}

/**
 * 规范化并清洗混合模式（BlendMode）
 * 
 * 必要性说明：
 * 1. 在 Figma 插件 API 中，`PASS_THROUGH` 是合法的图层级别（Layer/Container）混合模式，
 *    但绝不能应用于 Paint 对象（如 Fills 填充或 Strokes 描边）。
 * 2. 如果将 `PASS_THROUGH` 写入描边或填充的 blendMode 并尝试在 Figma 中恢复，
 *    Figma Plugin API 会抛出错误，导致整个描边/填充赋值失败。
 * 3. 因此，必须在导出端（或导入端）将 Paint 对象中的 `PASS_THROUGH` 自动规范化为 `NORMAL`。
 */
function processBlendMode(blendMode: BlendMode | string) {
    var resultBlenderMode = blendMode
    if (resultBlenderMode == "PLUS_DARKER" || resultBlenderMode == "PASS_THROUGH") resultBlenderMode = "NORMAL"
    return resultBlenderMode
}
