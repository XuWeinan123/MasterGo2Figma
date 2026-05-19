"use strict";
/// <reference types="@mastergo/plugin-typings" />
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
let totalNodes = 0;
let processedNodes = 0;
let loadingNotify = null;
let lastNotifyAt = 0;
let exportInProgress = false;
const INTERNAL_PROPS_PREFIX = "[PROPS]";
const SIBLING_PROPS_PREFIX = "[PROPS_SIBLING]";
const LAYER_RULES_SCHEMA = "mastergo2figma.layer-conversion-rules.v1";
const LAYER_RULES_CACHE_KEY = "mastergo2figma.layer-conversion-rules.v1";
const REQUIRED_LAYER_TYPES = [
    "BOOLEAN_OPERATION", "PEN", "VECTOR", "ELLIPSE", "RECTANGLE", "STAR",
    "LINE", "POLYGON", "TEXT", "FRAME", "GROUP", "SECTION", "SLICE",
    "CONNECTOR", "COMPONENT", "COMPONENT_SET", "INSTANCE"
];
const VALID_SEND_STRATEGIES = [
    "text", "penNetwork", "flattenBoolean", "booleanTree", "frameLike", "groupLike",
    "ellipseArc", "star", "polygon", "connector", "universalOnly"
];
const VALID_RECEIVE_CREATE_TYPES = [
    "VECTOR", "ELLIPSE", "RECTANGLE", "STAR", "LINE", "POLYGON",
    "TEXT", "SECTION", "SLICE", "FRAME", "GROUP", "CONNECTOR", "BOOLEAN_OPERATION"
];
const COMMAND_ALL_PAGES = "all-pages";
const COMMAND_SELECTED = "selected";
const COMMAND_CURRENT_PAGE = "current-page";
const COMMAND_PARTIAL_PAGES = "partial-pages";
const EXPORT_TRANSFER_CHUNK_SIZE = 64 * 1024;
const EXPORT_TEXT_CHUNK_CHAR_LIMIT = 16 * 1024;
const EXPORT_TRANSFER_YIELD_EVERY_CHUNKS = 64;
const LARGE_LAYER_RECORD_BYTES = 96 * 1024;
const LAYER_CHUNK_MAX_RECORDS = 100;
const LAYER_CHUNK_MAX_BYTES = 512 * 1024;
const EXPORT_PROGRESS_EVERY_LAYERS = 250;
const EXPORT_LOG_EVERY_LAYERS = 500;
const EXPORT_LOG_EVERY_FILES = 1000;
const SVG_FALLBACK_MAX_DOCUMENT_NODES = 5000;
const SVG_FALLBACK_MAX_NODES = 48;
const SVG_FALLBACK_MAX_DIMENSION = 256;
const SVG_FALLBACK_MAX_AREA = 64 * 1024;
const SVG_FALLBACK_MAX_BYTES = 64 * 1024;
const SPLIT_EXPORT_NODE_THRESHOLD = 20000;
const PAGE_SEGMENT_NODE_THRESHOLD = 12000;
const PAGE_SEGMENT_TARGET_NODES = 8000;
let cachedLayerRules = null;
let layerRulesBySourceType = null;
let layerRulesLoadPromise = null;
let activeImageAssetContext = null;
let exportTransferAckResolvers = {};
let exportFileAckResolvers = {};
let exportDebugState = null;
try {
    showPluginUI();
}
catch (error) {
    console.error("Unable to open SendToFigma plugin UI:", error);
    try {
        mg.notify("插件界面打开失败，请查看控制台", {
            position: "bottom",
            timeout: 3000,
            type: "error"
        });
    }
    catch (_) {
        // Ignore notify failures while the host is already failing to open.
    }
}
function showPluginUI() {
    mg.ui.onmessage = (rawMessage) => __awaiter(this, void 0, void 0, function* () {
        const message = unwrapUIMessage(rawMessage);
        if (!message || typeof message !== "object")
            return;
        if (message.type === "ui-ready") {
            yield safePostInitUI();
            return;
        }
        if (message.type === "close") {
            mg.closePlugin();
            return;
        }
        if (message.type === "import-rules") {
            yield handleImportLayerRules(message);
            return;
        }
        if (message.type === "delete-rules") {
            yield handleDeleteLayerRules();
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
        if (message.type !== "start-export")
            return;
        if (exportInProgress)
            return;
        const options = {
            scope: normalizeScope(message.scope),
            pageIds: Array.isArray(message.pageIds) ? message.pageIds : []
        };
        exportInProgress = true;
        yield runWithUI(options);
        exportInProgress = false;
    });
    openPluginUI();
    startLayerRulesLoad();
    schedulePostInitUI(50);
    schedulePostInitUI(300);
}
function openPluginUI() {
    try {
        mg.showUI(__html__, { width: 400, height: 720 });
    }
    catch (error) {
        console.warn("Unable to open preferred SendToFigma UI size, retrying with compact size:", error);
        mg.showUI(__html__, { width: 400, height: 678 });
    }
}
function unwrapUIMessage(rawMessage) {
    if (rawMessage && rawMessage.pluginMessage)
        return rawMessage.pluginMessage;
    return rawMessage;
}
function postInitUI() {
    return __awaiter(this, void 0, void 0, function* () {
        yield ensureLayerRulesLoaded();
        postUI({
            type: "init",
            command: normalizeScope(mg.command),
            selectionCount: mg.document.currentPage.selection.length,
            pageCount: mg.document.children.length,
            currentPageName: mg.document.currentPage.name,
            currentPageId: mg.document.currentPage.id,
            pages: getDocumentPageSummaries(),
            rules: getLayerRuleStatus()
        });
    });
}
function safePostInitUI() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            yield postInitUI();
        }
        catch (error) {
            console.warn("Unable to initialize SendToFigma UI:", error);
            try {
                postUI({
                    type: "error",
                    message: error instanceof Error ? error.message : "插件初始化失败"
                });
            }
            catch (_) {
                // UI may not be ready yet.
            }
        }
    });
}
function schedulePostInitUI(delay) {
    setTimeout(() => {
        safePostInitUI();
    }, delay);
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
        try {
            const cached = yield mg.clientStorage.getAsync(LAYER_RULES_CACHE_KEY);
            if (!cached || !cached.config) {
                cachedLayerRules = null;
                layerRulesBySourceType = null;
                return;
            }
            const config = validateLayerConversionConfig(cached.config);
            cachedLayerRules = {
                config,
                fileName: String(cached.fileName || "layer-conversion-rules.json"),
                importedAt: String(cached.importedAt || "")
            };
            layerRulesBySourceType = createLayerRuleIndex(config);
        }
        catch (error) {
            console.warn("Unable to load cached layer conversion rules:", error);
            cachedLayerRules = null;
            layerRulesBySourceType = null;
        }
    });
}
function handleImportLayerRules(message) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const status = yield importLayerRulesFromText(String(message.fileName || ""), String(message.content || ""));
            postUI({ type: "rules-loaded", rules: status });
        }
        catch (error) {
            postUI({
                type: "rules-error",
                message: error instanceof Error ? error.message : "规则配置导入失败",
                rules: getLayerRuleStatus()
            });
        }
    });
}
function handleDeleteLayerRules() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            yield mg.clientStorage.deleteAsync(LAYER_RULES_CACHE_KEY);
            cachedLayerRules = null;
            layerRulesBySourceType = null;
            layerRulesLoadPromise = null;
            postUI({ type: "rules-deleted", rules: getLayerRuleStatus() });
        }
        catch (error) {
            postUI({
                type: "rules-error",
                message: error instanceof Error ? error.message : "规则配置删除失败",
                rules: getLayerRuleStatus()
            });
        }
    });
}
function importLayerRulesFromText(fileName, content) {
    return __awaiter(this, void 0, void 0, function* () {
        let parsed;
        try {
            parsed = JSON.parse(content);
        }
        catch (error) {
            throw new Error("规则配置不是有效的 JSON");
        }
        const config = validateLayerConversionConfig(parsed);
        const cacheRecord = {
            config,
            fileName: fileName || "layer-conversion-rules.json",
            importedAt: new Date().toISOString()
        };
        yield mg.clientStorage.setAsync(LAYER_RULES_CACHE_KEY, cacheRecord);
        cachedLayerRules = cacheRecord;
        layerRulesBySourceType = createLayerRuleIndex(config);
        return getLayerRuleStatus();
    });
}
function validateLayerConversionConfig(input) {
    if (!input || typeof input !== "object")
        throw new Error("规则配置格式不正确");
    if (input.schema !== LAYER_RULES_SCHEMA)
        throw new Error("规则配置 schema 不匹配");
    if (!input.rules || typeof input.rules !== "object")
        throw new Error("规则配置缺少 rules");
    for (const sourceType of REQUIRED_LAYER_TYPES) {
        const rule = input.rules[sourceType];
        if (!rule || typeof rule !== "object")
            throw new Error(`规则配置缺少 ${sourceType}`);
        if (rule.sourceType !== sourceType)
            throw new Error(`${sourceType} 的 sourceType 不匹配`);
        if (typeof rule.restoreType !== "string" || !rule.restoreType)
            throw new Error(`${sourceType} 缺少 restoreType`);
        if (VALID_SEND_STRATEGIES.indexOf(rule.sendStrategy) === -1)
            throw new Error(`${sourceType} 的 sendStrategy 不支持`);
        if (VALID_RECEIVE_CREATE_TYPES.indexOf(rule.receiveCreate) === -1)
            throw new Error(`${sourceType} 的 receiveCreate 不支持`);
        if (typeof rule.isContainer !== "boolean")
            throw new Error(`${sourceType} 缺少 isContainer`);
        if (typeof rule.visualFrameSource !== "boolean")
            throw new Error(`${sourceType} 缺少 visualFrameSource`);
    }
    return input;
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
function isConfiguredContainerType(sourceType) {
    const rule = getLayerRule(sourceType);
    return !!rule && rule.isContainer;
}
function normalizeScope(scope) {
    if (scope === COMMAND_ALL_PAGES)
        return "all-pages";
    if (scope === COMMAND_SELECTED)
        return "selected";
    if (scope === COMMAND_PARTIAL_PAGES)
        return "partial-pages";
    return "current-page";
}
function runWithUI(options) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            yield ensureLayerRulesLoaded();
            if (!hasValidLayerRules()) {
                throw new Error("请先导入有效的图层转换规则 JSON");
            }
            postProgressUI({ type: "progress", phase: "start", current: 0, total: 0, label: "正在扫描图层..." });
            const manifest = yield streamJsonExportPackage(options);
            cacheLatestExportSummary(manifest);
        }
        catch (error) {
            logDiagnostic("error", "[MasterGo2Figma] Export failed", {
                error: describeError(error),
                debugState: exportDebugState
            });
            postUI({
                type: "error",
                message: error instanceof Error ? error.message : "导出失败，请查看控制台"
            });
        }
    });
}
function cacheLatestExportSummary(manifest) {
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
function postUI(message) {
    try {
        mg.ui.postMessage(message);
    }
    catch (error) {
        logDiagnostic("error", "[MasterGo2Figma] postUI failed", {
            error: describeError(error),
            message: summarizeUIMessage(message),
            debugState: exportDebugState
        });
        throw error;
    }
}
function postProgressUI(message) {
    try {
        postUI(message);
    }
    catch (error) {
        logDiagnostic("warn", "Unable to post progress update", {
            error: describeError(error),
            debugState: exportDebugState
        });
    }
}
function setExportDebugState(nextState) {
    exportDebugState = Object.assign(Object.assign({}, nextState), { processedNodes,
        totalNodes });
}
function describeError(error) {
    if (error === null)
        return { kind: "null" };
    if (error === undefined)
        return { kind: "undefined" };
    if (error instanceof Error) {
        return {
            kind: "Error",
            name: error.name,
            message: error.message,
            stack: error.stack
        };
    }
    if (typeof error === "object") {
        return {
            kind: "object",
            name: safeRead(() => error.name, undefined),
            message: safeRead(() => error.message, undefined),
            stack: safeRead(() => error.stack, undefined),
            value: safeStringifyForLog(error)
        };
    }
    return {
        kind: typeof error,
        value: String(error)
    };
}
function safeStringifyForLog(value) {
    try {
        const seen = [];
        return JSON.stringify(value, (_key, nextValue) => {
            if (typeof nextValue === "object" && nextValue !== null) {
                if (seen.indexOf(nextValue) !== -1)
                    return "[Circular]";
                seen.push(nextValue);
            }
            return nextValue;
        });
    }
    catch (_) {
        return String(value);
    }
}
function logDiagnostic(level, message, payload) {
    const text = payload === undefined ? "" : ` ${safeStringifyForLog(payload)}`;
    console[level](`${message}${text}`);
}
function summarizeUIMessage(message) {
    if (!message || typeof message !== "object")
        return { value: String(message) };
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
function createExportTransfer(manifest, filename) {
    const transferId = `export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return {
        transferId,
        filename: filename || createExportFilename(manifest),
        fileIndex: 0,
        postedChunks: 0,
        streamedBytes: 0
    };
}
function startExportTransfer(transfer) {
    postUI({
        type: "export-transfer-start",
        transferId: transfer.transferId,
        filename: transfer.filename,
        fileCount: 0,
        totalBytes: 0
    });
}
function streamExportFileToUI(transfer, file) {
    return __awaiter(this, void 0, void 0, function* () {
        const index = transfer.fileIndex++;
        const kind = file.bytes !== undefined ? "bytes" : "content";
        const contentParts = file.contentParts || (file.content !== undefined ? [file.content] : []);
        const size = kind === "bytes"
            ? (file.bytes ? file.bytes.length : 0)
            : contentParts.reduce((sum, part) => sum + part.length, 0);
        const totalChunks = kind === "bytes"
            ? Math.ceil(size / EXPORT_TRANSFER_CHUNK_SIZE)
            : Math.max(1, Math.ceil(size / EXPORT_TEXT_CHUNK_CHAR_LIMIT));
        let fileStarted = false;
        let fileEnded = false;
        if (index % EXPORT_LOG_EVERY_FILES === 0 || size >= LARGE_LAYER_RECORD_BYTES) {
            console.log(`[MasterGo2Figma] Transfer file ${index}: ${file.path}, kind=${kind}, size=${size}, chunks=${totalChunks}`);
        }
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
                totalChunks
            });
            fileStarted = true;
            if (kind === "bytes") {
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
                        bytes: bytes.slice(offset, offset + EXPORT_TRANSFER_CHUNK_SIZE)
                    });
                    transfer.postedChunks++;
                    if (transfer.postedChunks % EXPORT_TRANSFER_YIELD_EVERY_CHUNKS === 0)
                        yield yieldToHost();
                }
            }
            else {
                let chunkIndex = 0;
                const postContentChunk = (content) => __awaiter(this, void 0, void 0, function* () {
                    setExportDebugState({
                        phase: "transfer:content-chunk",
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
                        content
                    });
                    chunkIndex++;
                    transfer.postedChunks++;
                    if (transfer.postedChunks % EXPORT_TRANSFER_YIELD_EVERY_CHUNKS === 0)
                        yield yieldToHost();
                });
                let textBuffer = "";
                const flushTextBuffer = () => __awaiter(this, void 0, void 0, function* () {
                    if (!textBuffer)
                        return;
                    const nextContent = textBuffer;
                    textBuffer = "";
                    yield postContentChunk(nextContent);
                });
                for (const part of contentParts) {
                    if (!part)
                        continue;
                    let offset = 0;
                    while (offset < part.length) {
                        const available = EXPORT_TEXT_CHUNK_CHAR_LIMIT - textBuffer.length;
                        const nextLength = Math.min(available, part.length - offset);
                        textBuffer += part.slice(offset, offset + nextLength);
                        offset += nextLength;
                        if (textBuffer.length >= EXPORT_TEXT_CHUNK_CHAR_LIMIT)
                            yield flushTextBuffer();
                    }
                }
                yield flushTextBuffer();
                if (size === 0)
                    yield postContentChunk("");
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
            postUI({ type: "export-file-end", transferId: transfer.transferId, index });
            fileEnded = true;
            yield fileAckPromise;
            if (transfer.fileIndex % EXPORT_LOG_EVERY_FILES === 0) {
                console.log(`[MasterGo2Figma] Transfer progress: files=${transfer.fileIndex}, bytes=${transfer.streamedBytes}`);
            }
            if (index % 25 === 0)
                yield yieldToHost();
        }
        catch (error) {
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
            if (fileStarted && !fileEnded)
                abortExportFileToUI(transfer, index, file.path, error);
            clearPendingExportFileAck(transfer, index);
            throw error;
        }
    });
}
function abortExportFileToUI(transfer, index, path, error) {
    try {
        postUI({
            type: "export-file-abort",
            transferId: transfer.transferId,
            index,
            path,
            reason: safeStringifyForLog(describeError(error))
        });
    }
    catch (abortError) {
        logDiagnostic("warn", "[MasterGo2Figma] Unable to send export-file-abort", {
            abortError: describeError(abortError),
            originalError: describeError(error),
            transfer: summarizeTransfer(transfer),
            file: { index, path }
        });
    }
}
function getExportFileAckKey(transferId, index) {
    return `${transferId}:${index}`;
}
function resolveExportFileAck(message) {
    const transferId = String(message && message.transferId || "");
    const index = Number(message && message.index);
    const key = getExportFileAckKey(transferId, index);
    const resolver = exportFileAckResolvers[key];
    if (!resolver)
        return;
    clearTimeout(resolver.timeoutId);
    delete exportFileAckResolvers[key];
    const ack = {
        transferId,
        index,
        success: message && message.success === true,
        path: typeof message.path === "string" ? message.path : resolver.path,
        error: typeof message.error === "string" ? message.error : undefined,
        pendingCount: typeof message.pendingCount === "number" ? message.pendingCount : undefined
    };
    if (ack.success) {
        resolver.resolve(ack);
    }
    else {
        resolver.reject(new Error(`UI failed to write ${ack.path || resolver.path}: ${ack.error || "unknown error"}; pending=${ack.pendingCount === undefined ? "unknown" : ack.pendingCount}`));
    }
}
function waitForExportFileAck(transfer, index, path, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        const key = getExportFileAckKey(transfer.transferId, index);
        const timeoutId = setTimeout(() => {
            delete exportFileAckResolvers[key];
            reject(new Error(`Timed out waiting for UI file ack: ${path}`));
        }, timeoutMs);
        exportFileAckResolvers[key] = {
            resolve,
            reject,
            timeoutId,
            path
        };
    });
}
function clearPendingExportFileAck(transfer, index) {
    const key = getExportFileAckKey(transfer.transferId, index);
    const resolver = exportFileAckResolvers[key];
    if (!resolver)
        return;
    clearTimeout(resolver.timeoutId);
    delete exportFileAckResolvers[key];
}
function completeExportTransfer(transfer, manifest, isFinal = true, stats = manifest.stats) {
    postUI({
        type: "export-transfer-complete",
        transferId: transfer.transferId,
        fileCount: transfer.fileIndex,
        totalBytes: transfer.streamedBytes,
        stats,
        isFinal
    });
}
function resolveExportTransferAck(message) {
    const transferId = String(message && message.transferId || "");
    const resolver = exportTransferAckResolvers[transferId];
    if (!resolver)
        return;
    clearTimeout(resolver.timeoutId);
    delete exportTransferAckResolvers[transferId];
    const ack = {
        transferId,
        success: message && message.success === true,
        filename: typeof message.filename === "string" ? message.filename : undefined,
        error: typeof message.error === "string" ? message.error : undefined,
        pendingCount: typeof message.pendingCount === "number" ? message.pendingCount : undefined
    };
    if (ack.success) {
        resolver.resolve(ack);
    }
    else {
        resolver.reject(new Error(`UI zip failed for ${ack.filename || transferId}: ${ack.error || "unknown error"}; pending=${ack.pendingCount === undefined ? "unknown" : ack.pendingCount}`));
    }
}
function waitForExportTransferAck(transfer, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            delete exportTransferAckResolvers[transfer.transferId];
            reject(new Error(`Timed out waiting for UI zip ack: ${transfer.filename}`));
        }, timeoutMs);
        exportTransferAckResolvers[transfer.transferId] = {
            resolve,
            reject,
            timeoutId
        };
    });
}
function streamJsonExportPackage(options) {
    return __awaiter(this, void 0, void 0, function* () {
        totalNodes = 0;
        processedNodes = 0;
        const previousImageAssetContext = activeImageAssetContext;
        try {
            const targets = getExportTargets(options);
            for (const page of targets) {
                for (const node of page.nodes)
                    countNodes(node);
            }
            if (totalNodes === 0) {
                throw new Error(options.scope === "selected" ? "请先选择要导出的图层" : "没有可导出的图层");
            }
            if (shouldSplitExportPackages(targets)) {
                return yield streamSplitJsonExportPackages(options, targets);
            }
            const imageAssetContext = createImageAssetContext();
            activeImageAssetContext = imageAssetContext;
            const manifest = createBaseExportManifest(options, targets.length);
            const transfer = createExportTransfer(manifest);
            startExportTransfer(transfer);
            console.log(`[MasterGo2Figma] Export v2 start: ${targets.length} pages, ${totalNodes} nodes`);
            postProgressUI({ type: "progress", phase: "prepare", current: 0, total: totalNodes, label: "准备分块导出 JSON..." });
            for (let pageIndex = 0; pageIndex < targets.length; pageIndex++) {
                yield streamPageExportToTransfer(targets[pageIndex], pageIndex, targets.length, manifest, transfer);
            }
            console.log(`[MasterGo2Figma] Layer chunks streamed; image assets queued: ${imageAssetContext.assets.length}`);
            postProgressUI({ type: "progress", phase: "assets", current: processedNodes, total: totalNodes, label: "正在导出图片资源..." });
            yield streamImageAssetsToTransfer(imageAssetContext, manifest, transfer);
            yield streamExportFileToUI(transfer, {
                path: "manifest.json",
                content: JSON.stringify(manifest)
            });
            postProgressUI({ type: "progress", phase: "complete", current: totalNodes, total: totalNodes, label: "JSON 已生成，正在准备下载..." });
            const ackPromise = waitForExportTransferAck(transfer);
            completeExportTransfer(transfer, manifest);
            const ack = yield ackPromise;
            console.log(`[MasterGo2Figma] UI zip complete: ${ack.filename || transfer.filename}, files=${transfer.fileIndex}, bytes=${transfer.streamedBytes}`);
            return manifest;
        }
        catch (error) {
            logDiagnostic("error", "[MasterGo2Figma] Export transfer failed", {
                error: describeError(error),
                debugState: exportDebugState
            });
            throw error;
        }
        finally {
            activeImageAssetContext = previousImageAssetContext;
        }
    });
}
function createBaseExportManifest(options, pageCount) {
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
function shouldSplitExportPackages(targets) {
    return targets.length > 1 && totalNodes >= SPLIT_EXPORT_NODE_THRESHOLD;
}
function streamSplitJsonExportPackages(options, targets) {
    return __awaiter(this, void 0, void 0, function* () {
        const aggregateManifest = createBaseExportManifest(options, targets.length);
        console.log(`[MasterGo2Figma] Large export detected: ${targets.length} pages, ${totalNodes} nodes. Exporting one zip per page.`);
        postProgressUI({
            type: "progress",
            phase: "prepare",
            current: 0,
            total: totalNodes,
            label: "文件较大，正在按页面分包导出..."
        });
        for (let pageIndex = 0; pageIndex < targets.length; pageIndex++) {
            const pageTarget = targets[pageIndex];
            const pageSegments = createPageSegments(pageTarget);
            if (pageSegments.length > 1) {
                console.log(`[MasterGo2Figma] Page ${safeRead(() => pageTarget.page.name, "Untitled")} is large; split into ${pageSegments.length} root segments.`);
            }
            for (let segmentIndex = 0; segmentIndex < pageSegments.length; segmentIndex++) {
                const segmentTarget = pageSegments[segmentIndex];
                const imageAssetContext = createImageAssetContext();
                activeImageAssetContext = imageAssetContext;
                const manifest = createBaseExportManifest(options, 1);
                const filename = createPageExportFilename(options.scope, pageTarget.page, pageIndex, targets.length, manifest.exportedAt, segmentTarget.segmentIndex, segmentTarget.segmentCount);
                const transfer = createExportTransfer(manifest, filename);
                startExportTransfer(transfer);
                const segmentLabel = segmentTarget.segmentCount > 1 ? ` segment ${segmentTarget.segmentIndex + 1}/${segmentTarget.segmentCount}` : "";
                const pageNameOverride = segmentTarget.segmentCount > 1
                    ? `${safeRead(() => pageTarget.page.name, "Untitled")} ${segmentTarget.segmentIndex + 1}-${segmentTarget.segmentCount}`
                    : undefined;
                console.log(`[MasterGo2Figma] Split package start ${pageIndex + 1}/${targets.length}${segmentLabel}: ${safeRead(() => pageTarget.page.name, "Untitled")}, nodes=${segmentTarget.nodeCount}`);
                yield streamPageExportToTransfer(segmentTarget, pageIndex, targets.length, manifest, transfer, pageNameOverride);
                console.log(`[MasterGo2Figma] Split package layers streamed; image assets queued: ${imageAssetContext.assets.length}`);
                postProgressUI({
                    type: "progress",
                    phase: "assets",
                    current: processedNodes,
                    total: totalNodes,
                    label: `正在导出图片资源 ${pageIndex + 1}/${targets.length}${segmentLabel}...`
                });
                yield streamImageAssetsToTransfer(imageAssetContext, manifest, transfer);
                yield streamExportFileToUI(transfer, {
                    path: "manifest.json",
                    content: JSON.stringify(manifest)
                });
                const pageSummary = manifest.pages[0];
                if (pageSummary)
                    aggregateManifest.pages.push(pageSummary);
                aggregateManifest.stats.pageCount = aggregateManifest.pages.length;
                aggregateManifest.stats.layerCount += manifest.stats.layerCount;
                aggregateManifest.stats.imageAssetCount += manifest.stats.imageAssetCount;
                aggregateManifest.stats.missingImageAssetCount += manifest.stats.missingImageAssetCount;
                const isFinal = pageIndex === targets.length - 1 && segmentIndex === pageSegments.length - 1;
                const ackPromise = waitForExportTransferAck(transfer);
                completeExportTransfer(transfer, manifest, isFinal, isFinal ? aggregateManifest.stats : manifest.stats);
                releaseExportPackageMemory(manifest, imageAssetContext);
                activeImageAssetContext = null;
                const ack = yield ackPromise;
                console.log(`[MasterGo2Figma] Split package complete ${pageIndex + 1}/${targets.length}${segmentLabel}: ${ack.filename || transfer.filename}, files=${transfer.fileIndex}, bytes=${transfer.streamedBytes}`);
                yield yieldToHost();
            }
        }
        return aggregateManifest;
    });
}
function streamPageExportToTransfer(pageTarget, pageIndex, pageCount, manifest, transfer, pageNameOverride) {
    return __awaiter(this, void 0, void 0, function* () {
        const pageFolder = createPageFolderName(pageTarget.page, pageIndex);
        const pageId = safeRead(() => pageTarget.page.id, `page-${pageIndex + 1}`);
        const pageName = pageNameOverride || safeRead(() => pageTarget.page.name, "Untitled");
        console.log(`[MasterGo2Figma] Page export start ${pageIndex + 1}/${pageCount}: ${pageName}, roots=${pageTarget.nodes.length}`);
        const pageIndexRecord = {
            schema: "mastergo2figma.page.v2",
            version: 2,
            id: pageId,
            name: pageName,
            folder: pageFolder,
            rootNodeIds: [],
            layerChunks: [],
            layerCount: 0
        };
        const chunk = {
            pageId,
            pageFolder,
            chunkIndex: 1,
            recordJsons: [],
            bytes: 0
        };
        for (let index = 0; index < pageTarget.nodes.length; index++) {
            const node = pageTarget.nodes[index];
            pageIndexRecord.rootNodeIds.push(safeRead(() => node.id, `root-${pageIndex + 1}-${index + 1}`));
            yield collectNodeExport(node, pageTarget.page, pageFolder, null, index, pageIndexRecord, chunk, transfer);
        }
        yield flushLayerChunk(pageIndexRecord, chunk, transfer);
        const pageFile = `pages/${pageFolder}/page.json`;
        yield streamExportFileToUI(transfer, {
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
    });
}
function streamImageAssetsToTransfer(imageAssetContext, manifest, transfer) {
    return __awaiter(this, void 0, void 0, function* () {
        for (const asset of imageAssetContext.assets) {
            yield loadAndStreamImageAsset(asset, imageAssetContext, transfer);
            manifest.assets[asset.key] = {
                key: asset.key,
                fileName: asset.fileName,
                path: asset.path,
                missing: asset.missing || undefined
            };
            if (asset.bytes && !asset.missing)
                manifest.stats.imageAssetCount++;
            asset.bytes = null;
        }
        manifest.stats.missingImageAssetCount = imageAssetContext.missingImageAssetCount;
    });
}
function createPageSegments(pageTarget) {
    const nodeEntries = pageTarget.nodes.map(node => ({
        node,
        nodeCount: countNodesForExport(node)
    }));
    const pageNodeCount = nodeEntries.reduce((sum, entry) => sum + entry.nodeCount, 0);
    if (pageNodeCount < PAGE_SEGMENT_NODE_THRESHOLD || nodeEntries.length <= 1) {
        return [{
                page: pageTarget.page,
                nodes: pageTarget.nodes,
                nodeCount: pageNodeCount,
                segmentIndex: 0,
                segmentCount: 1
            }];
    }
    const batches = [];
    let currentNodes = [];
    let currentCount = 0;
    for (const entry of nodeEntries) {
        if (currentNodes.length > 0 && currentCount + entry.nodeCount > PAGE_SEGMENT_TARGET_NODES) {
            batches.push({ nodes: currentNodes, nodeCount: currentCount });
            currentNodes = [];
            currentCount = 0;
        }
        currentNodes.push(entry.node);
        currentCount += entry.nodeCount;
        if (entry.nodeCount > PAGE_SEGMENT_TARGET_NODES) {
            console.warn(`[MasterGo2Figma] Large root node segment: ${getNodeDebugLabel(entry.node)}, nodes=${entry.nodeCount}`);
        }
    }
    if (currentNodes.length > 0)
        batches.push({ nodes: currentNodes, nodeCount: currentCount });
    return batches.map((batch, index) => ({
        page: pageTarget.page,
        nodes: batch.nodes,
        nodeCount: batch.nodeCount,
        segmentIndex: index,
        segmentCount: batches.length
    }));
}
function countNodesForExport(node) {
    let count = 1;
    for (const child of getSafeExportableChildren(node)) {
        count += countNodesForExport(child);
    }
    return count;
}
function releaseExportPackageMemory(manifest, imageAssetContext) {
    manifest.pages = [];
    manifest.assets = {};
    imageAssetContext.assets.length = 0;
    imageAssetContext.bySourceRef = {};
}
function yieldToHost() {
    return new Promise(resolve => setTimeout(resolve, 0));
}
function createExportFilename(manifest) {
    const date = manifest.exportedAt.replace(/[:.]/g, "-");
    return `mastergo2figma-${manifest.scope}-${date}.zip`;
}
function createPageExportFilename(scope, page, pageIndex, pageCount, exportedAt, segmentIndex = 0, segmentCount = 1) {
    const date = exportedAt.replace(/[:.]/g, "-");
    const pageName = createFileSafeName(safeRead(() => page.name, ""), `page-${pageIndex + 1}`);
    const segmentName = segmentCount > 1 ? `-segment-${padNumber(segmentIndex + 1)}-of-${padNumber(segmentCount)}` : "";
    return `mastergo2figma-${scope}-part-${padNumber(pageIndex + 1)}-of-${padNumber(pageCount)}${segmentName}-${pageName}-${date}.zip`;
}
function createFileSafeName(value, fallback) {
    const cleaned = String(value || "")
        .trim()
        .replace(/[\\/:*?"<>|]/g, "-")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 48);
    return cleaned || fallback;
}
function getExportTargets(options) {
    const pages = [...mg.document.children].filter(page => !page.name.endsWith("_Process"));
    const selectedPageIds = new Set(options.pageIds);
    if (options.scope === "all-pages") {
        return pages
            .filter(page => selectedPageIds.size === 0 || selectedPageIds.has(page.id))
            .map(page => ({ page, nodes: getSafeExportableChildren(page) }));
    }
    if (options.scope === "partial-pages") {
        if (selectedPageIds.size === 0)
            throw new Error("请至少选择一个页面");
        return pages
            .filter(page => selectedPageIds.has(page.id))
            .map(page => ({ page, nodes: getSafeExportableChildren(page) }));
    }
    if (options.scope === "selected") {
        const nodes = getTopLevelSelectedNodes(mg.document.currentPage.selection);
        return [{ page: mg.document.currentPage, nodes }];
    }
    return [{ page: mg.document.currentPage, nodes: getSafeExportableChildren(mg.document.currentPage) }];
}
function getExportableChildren(node) {
    if (!node.children)
        return [];
    return [...node.children].filter((child) => !isGeneratedCarrierName(safeRead(() => child.name, "")));
}
function getSafeExportableChildren(node) {
    try {
        return getExportableChildren(node);
    }
    catch (error) {
        console.warn("Unable to read children for export:", getNodeDebugLabel(node), error);
        return [];
    }
}
function collectNodeExport(node, page, pageFolder, parentId, index, pageIndex, chunk, transfer) {
    return __awaiter(this, void 0, void 0, function* () {
        processedNodes++;
        const nodeDebug = getNodeDebugLabel(node);
        const pageName = safeRead(() => page.name, pageIndex.name);
        let phase = "start";
        let nodeId = safeRead(() => node.id, `node-${pageIndex.layerCount + 1}`);
        let nodeName = safeRead(() => node.name, "Untitled");
        let recordAppended = false;
        const setNodeDebug = (nextPhase) => {
            phase = nextPhase;
            setExportDebugState({
                phase: `node:${nextPhase}`,
                page: pageName,
                node: nodeDebug,
                parentId,
                nodeIndex: index,
                transferId: transfer.transferId,
                fileIndex: transfer.fileIndex,
                streamedBytes: transfer.streamedBytes
            });
        };
        try {
            setNodeDebug("read-children");
            const childNodes = getSafeExportableChildren(node);
            setNodeDebug("analyse");
            const nodeJson = analyseNodes(node);
            setNodeDebug("enrich-boolean");
            yield enrichBooleanOperationExport(node, nodeJson, childNodes);
            setNodeDebug("enrich-vector");
            yield enrichFilledVectorExport(node, nodeJson);
            setNodeDebug("override-layout");
            overrideExportLayoutFromSourceNode(nodeJson, node);
            setNodeDebug("build-record");
            const shouldExportChildren = !nodeJson || !nodeJson.omitChildrenOnRestore;
            const childIds = shouldExportChildren ? childNodes.map(child => safeRead(() => child.id, "")) : [];
            const layerRecord = {
                id: nodeId,
                pageId: safeRead(() => page.id, ""),
                parentId,
                index,
                name: nodeName,
                childIds,
                props: nodeJson
            };
            setNodeDebug("stringify");
            const recordJson = stringifyLayerPayload(layerRecord, node);
            pageIndex.layerCount++;
            setNodeDebug("append-record");
            yield appendLayerRecord(recordJson, pageIndex, chunk, transfer);
            recordAppended = true;
            if (!shouldExportChildren && nodeJson && nodeJson.omittedChildNodeCount) {
                processedNodes += nodeJson.omittedChildNodeCount;
            }
            if (processedNodes % EXPORT_PROGRESS_EVERY_LAYERS === 0 || processedNodes === totalNodes) {
                setNodeDebug("progress");
                postProgressUI({
                    type: "progress",
                    phase: "export",
                    current: processedNodes,
                    total: totalNodes,
                    label: "正在导出图层..."
                });
                yield yieldToEventLoop();
            }
            if (shouldExportChildren) {
                setNodeDebug("children");
                for (let childIndex = 0; childIndex < childNodes.length; childIndex++) {
                    yield collectNodeExport(childNodes[childIndex], page, pageFolder, nodeId, childIndex, pageIndex, chunk, transfer);
                }
            }
        }
        catch (error) {
            logDiagnostic("error", "[MasterGo2Figma] Node export failed", {
                phase,
                error: describeError(error),
                node: getNodeProbe(node),
                page: pageName,
                parentId,
                index,
                processedNodes,
                totalNodes,
                pageLayerCount: pageIndex.layerCount,
                transfer: summarizeTransfer(transfer)
            });
            if (recordAppended)
                return;
            try {
                yield appendFallbackLayerRecord(node, page, parentId, index, pageIndex, chunk, transfer);
            }
            catch (fallbackError) {
                logDiagnostic("error", "[MasterGo2Figma] Fallback node export failed", {
                    phase,
                    originalError: describeError(error),
                    fallbackError: describeError(fallbackError),
                    node: getNodeProbe(node),
                    page: pageName,
                    transfer: summarizeTransfer(transfer)
                });
                throw fallbackError;
            }
        }
    });
}
function appendFallbackLayerRecord(node, page, parentId, index, pageIndex, chunk, transfer) {
    return __awaiter(this, void 0, void 0, function* () {
        const nodeId = safeRead(() => node.id, `fallback-${pageIndex.layerCount + 1}`);
        const nodeName = safeRead(() => node.name, "Untitled");
        const sourceType = safeRead(() => node.type, "UNKNOWN");
        const fallbackJson = createFallbackNodeJson(node, sourceType);
        const layerRecord = {
            id: nodeId,
            pageId: safeRead(() => page.id, ""),
            parentId,
            index,
            name: nodeName,
            childIds: [],
            props: fallbackJson
        };
        const recordJson = stringifyLayerPayload(layerRecord, node);
        pageIndex.layerCount++;
        yield appendLayerRecord(recordJson, pageIndex, chunk, transfer);
    });
}
function getNodeProbe(node) {
    return {
        id: safeRead(() => node.id, "unknown-id"),
        name: safeRead(() => node.name, "Untitled"),
        type: safeRead(() => node.type, "UNKNOWN"),
        width: safeRead(() => Number(node.width), undefined),
        height: safeRead(() => Number(node.height), undefined),
        childCount: safeRead(() => Array.isArray(node.children) ? node.children.length : undefined, undefined)
    };
}
function summarizeTransfer(transfer) {
    return {
        transferId: transfer.transferId,
        filename: transfer.filename,
        fileIndex: transfer.fileIndex,
        postedChunks: transfer.postedChunks,
        streamedBytes: transfer.streamedBytes
    };
}
function enrichBooleanOperationExport(node, nodeJson, childNodes) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!nodeJson || safeRead(() => node.type, "") !== "BOOLEAN_OPERATION")
            return;
        const rule = getLayerRule("BOOLEAN_OPERATION");
        if (rule && rule.sendStrategy === "booleanTree") {
            yield attachBooleanSvgFallbackMarkup(node, nodeJson);
            return;
        }
        if (hasUsableVectorNetwork(nodeJson.vectorNetwork) || childNodes.length === 0)
            return;
        const svg = yield tryExportBooleanSvgMarkup(node);
        if (svg) {
            nodeJson.svgMarkup = svg;
            nodeJson.svgFallback = true;
            nodeJson.receiveCreateOverride = "SVG";
            nodeJson.omitChildrenOnRestore = true;
            nodeJson.omittedChildNodeCount = Math.max(0, countExportableSubtreeNodes(node) - 1);
            return;
        }
        markBooleanAsFrameFallback(nodeJson);
    });
}
function attachBooleanSvgFallbackMarkup(node, nodeJson) {
    return __awaiter(this, void 0, void 0, function* () {
        const svg = yield tryExportSvgMarkup(node, "Boolean");
        if (!svg)
            return;
        nodeJson.svgMarkup = svg;
        nodeJson.booleanVisualFallback = "svg";
    });
}
function tryExportBooleanSvgMarkup(node) {
    return __awaiter(this, void 0, void 0, function* () {
        return tryExportSvgMarkup(node, "Boolean");
    });
}
function enrichFilledVectorExport(node, nodeJson) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!shouldUseSvgFallbackForFilledVector(nodeJson))
            return;
        const svg = yield tryExportSvgMarkup(node, "Filled vector");
        if (!svg)
            return;
        nodeJson.svgMarkup = svg;
        nodeJson.svgFallback = true;
        nodeJson.receiveCreateOverride = "SVG";
        nodeJson.vectorFallback = "svgMissingRegions";
    });
}
function shouldUseSvgFallbackForFilledVector(nodeJson) {
    if (!nodeJson || nodeJson.receiveCreateOverride || nodeJson.svgFallback)
        return false;
    if (nodeJson.sourceType !== "PEN" && nodeJson.sourceType !== "VECTOR")
        return false;
    if (!hasVisibleFill(nodeJson.geometry && nodeJson.geometry.fills))
        return false;
    const vectorNetwork = nodeJson.vectorNetwork;
    if (!vectorNetwork || !Array.isArray(vectorNetwork.segments) || vectorNetwork.segments.length < 2)
        return false;
    if (Array.isArray(vectorNetwork.regions) && vectorNetwork.regions.length > 0)
        return false;
    return true;
}
function hasVisibleFill(fills) {
    if (!Array.isArray(fills))
        return false;
    return fills.some(fill => fill && fill.type && fill.visible !== false && (fill.opacity === undefined || fill.opacity > 0));
}
function tryExportSvgMarkup(node, label) {
    return __awaiter(this, void 0, void 0, function* () {
        if (totalNodes > SVG_FALLBACK_MAX_DOCUMENT_NODES)
            return "";
        const subtreeNodeCount = countExportableSubtreeNodes(node);
        const width = Number(safeRead(() => node.width, 0)) || 0;
        const height = Number(safeRead(() => node.height, 0)) || 0;
        const area = Math.abs(width * height);
        if (subtreeNodeCount <= SVG_FALLBACK_MAX_NODES &&
            area <= SVG_FALLBACK_MAX_AREA &&
            Math.max(Math.abs(width), Math.abs(height)) <= SVG_FALLBACK_MAX_DIMENSION) {
            try {
                const svg = yield node.exportAsync({ format: "SVG" });
                if (typeof svg === "string" && svg.trim()) {
                    if (svg.length > SVG_FALLBACK_MAX_BYTES) {
                        console.warn(`[MasterGo2Figma] ${label} SVG fallback skipped because SVG is too large: ${getNodeDebugLabel(node)}, bytes=${svg.length}`);
                        return "";
                    }
                    return svg;
                }
            }
            catch (error) {
                console.warn(`Unable to export ${label} as SVG fallback:`, getNodeDebugLabel(node), error);
            }
        }
        return "";
    });
}
function markBooleanAsFrameFallback(nodeJson) {
    nodeJson.type = "FRAME";
    nodeJson.restoreType = "FRAME";
    nodeJson.receiveCreateOverride = "FRAME";
    nodeJson.booleanFallback = "frameContainer";
    nodeJson.clipsContent = false;
    clearNodePaint(nodeJson);
}
function clearNodePaint(nodeJson) {
    if (!nodeJson.geometry)
        return;
    nodeJson.geometry.fills = [];
    nodeJson.geometry.strokes = [];
    nodeJson.geometry.strokeWeight = 0;
}
function hasUsableVectorNetwork(vectorNetwork) {
    return !!(vectorNetwork &&
        Array.isArray(vectorNetwork.vertices) &&
        vectorNetwork.vertices.length > 0 &&
        Array.isArray(vectorNetwork.segments));
}
function countExportableSubtreeNodes(node) {
    let count = 1;
    const children = getSafeExportableChildren(node);
    for (const child of children) {
        count += countExportableSubtreeNodes(child);
        if (count > SVG_FALLBACK_MAX_NODES)
            return count;
    }
    return count;
}
function appendLayerRecord(recordJson, pageIndex, chunk, transfer) {
    return __awaiter(this, void 0, void 0, function* () {
        if (recordJson.length >= LARGE_LAYER_RECORD_BYTES) {
            console.log(`[MasterGo2Figma] Large layer record: ${recordJson.length} bytes on page ${pageIndex.name}`);
        }
        const nextBytes = recordJson.length + (chunk.recordJsons.length > 0 ? 1 : 0);
        if (chunk.recordJsons.length > 0 &&
            (chunk.recordJsons.length >= LAYER_CHUNK_MAX_RECORDS || chunk.bytes + nextBytes > LAYER_CHUNK_MAX_BYTES)) {
            yield flushLayerChunk(pageIndex, chunk, transfer);
        }
        chunk.recordJsons.push(recordJson);
        chunk.bytes += nextBytes;
        if (chunk.recordJsons.length >= LAYER_CHUNK_MAX_RECORDS || chunk.bytes >= LAYER_CHUNK_MAX_BYTES) {
            yield flushLayerChunk(pageIndex, chunk, transfer);
        }
        if (pageIndex.layerCount % EXPORT_LOG_EVERY_LAYERS === 0) {
            console.log(`[MasterGo2Figma] Page ${pageIndex.name}: collected ${pageIndex.layerCount} layers; openChunkRecords=${chunk.recordJsons.length}; latest=${recordJson.length} bytes`);
        }
    });
}
function flushLayerChunk(pageIndex, chunk, transfer) {
    return __awaiter(this, void 0, void 0, function* () {
        if (chunk.recordJsons.length === 0)
            return;
        const fileIndex = chunk.chunkIndex++;
        const path = `pages/${chunk.pageFolder}/layers/layers-${padNumber(fileIndex)}.json`;
        const contentParts = [
            `{"schema":"mastergo2figma.layers.v2","version":2,"pageId":${JSON.stringify(chunk.pageId)},"records":[`
        ];
        for (let index = 0; index < chunk.recordJsons.length; index++) {
            contentParts.push(index > 0 ? `,${chunk.recordJsons[index]}` : chunk.recordJsons[index]);
        }
        contentParts.push("]}");
        yield streamExportFileToUI(transfer, { path, contentParts });
        pageIndex.layerChunks.push(path);
        chunk.recordJsons = [];
        chunk.bytes = 0;
    });
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
function createPageFolderName(page, index) {
    const label = safeRead(() => page.name, "") || safeRead(() => page.id, "page");
    return `page-${padNumber(index + 1)}-${slugifyPathPart(label)}`;
}
function createLayerFileName(node, index) {
    const label = safeRead(() => node.name, "") || safeRead(() => node.type, "untitled");
    return `layer-${padNumber(index)}-${slugifyPathPart(label)}.json`;
}
function padNumber(value) {
    const text = String(value);
    if (text.length >= 3)
        return text;
    return "000".slice(0, 3 - text.length) + text;
}
function slugifyPathPart(value) {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return (normalized || "untitled").slice(0, 48);
}
function safeCloneTransform(transform) {
    if (!transform)
        return null;
    return cloneTransform(transform);
}
function safeRead(reader, fallback) {
    try {
        const value = reader();
        return value === undefined || value === null ? fallback : value;
    }
    catch (error) {
        return fallback;
    }
}
function readNodeProperty(node, property, fallback) {
    try {
        const value = node ? node[property] : undefined;
        return value === undefined || value === null ? fallback : value;
    }
    catch (error) {
        logDiagnostic("warn", "[MasterGo2Figma] Node property read failed", {
            property,
            node: getNodeProbe(node),
            error: describeError(error),
            debugState: exportDebugState
        });
        return fallback;
    }
}
function getNodeDebugLabel(node) {
    const name = safeRead(() => node.name, "Untitled");
    const type = safeRead(() => node.type, "UNKNOWN");
    const id = safeRead(() => node.id, "unknown-id");
    return `${name} (${type}, ${id})`;
}
function stringifyLayerPayload(payload, node) {
    try {
        return JSON.stringify(payload);
    }
    catch (error) {
        console.warn("Unable to stringify layer payload, exporting fallback:", getNodeDebugLabel(node), error);
        const fallbackPayload = Object.assign(Object.assign({}, payload), { props: createFallbackNodeJson(node, safeRead(() => node.type, "UNKNOWN")) });
        return JSON.stringify(fallbackPayload);
    }
}
function isGeneratedCarrierName(name) {
    return name.startsWith(INTERNAL_PROPS_PREFIX) || name.startsWith(SIBLING_PROPS_PREFIX);
}
function overrideExportLayoutFromSourceNode(nodeJson, node) {
    if (!nodeJson || !nodeJson.layout)
        return;
    try {
        const layoutTransform = cloneTransform(node.relativeTransform);
        nodeJson.layout.relativeTransform = layoutTransform;
        nodeJson.layout.x = layoutTransform[0][2];
        nodeJson.layout.y = layoutTransform[1][2];
        nodeJson.layout.rotation = -(node.rotation || 0);
        nodeJson.layout.width = node.width;
        nodeJson.layout.height = node.height;
        nodeJson.layout.constrainProportions = node.constrainProportions || false;
    }
    catch (error) {
        console.warn("Unable to override export layout:", getNodeDebugLabel(node), error);
    }
}
function countNodes(node) {
    totalNodes++;
    for (const child of getSafeExportableChildren(node))
        countNodes(child);
}
function processByCommand(command) {
    return __awaiter(this, void 0, void 0, function* () {
        yield ensureLayerRulesLoaded();
        if (!hasValidLayerRules()) {
            mg.notify("请先导入有效的图层转换规则 JSON", {
                position: "bottom",
                timeout: 3000,
                type: "warning"
            });
            return;
        }
        if (command === COMMAND_ALL_PAGES) {
            yield processPages([...mg.document.children], "all pages");
            return;
        }
        if (command === COMMAND_SELECTED) {
            yield processSelectedNodes();
            return;
        }
        yield processPages([mg.document.currentPage], "current page");
    });
}
function processSelectedNodes() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            totalNodes = 0;
            processedNodes = 0;
            const selectedNodes = getTopLevelSelectedNodes(mg.document.currentPage.selection);
            if (selectedNodes.length === 0) {
                mg.notify("请先选择要转换的图层", {
                    position: "bottom",
                    timeout: 3000,
                    type: "warning"
                });
                return;
            }
            setLoading(`准备转换已选中图层 (${selectedNodes.length})...`, true);
            for (const node of selectedNodes)
                countNodes(node);
            const processPage = mg.createPage();
            processPage.name = `${mg.document.currentPage.name}_Process_Selected_${selectedNodes.length}`;
            copyPageProperties(mg.document.currentPage, processPage);
            yield transformSelectedNodesIncrementally(selectedNodes, processPage);
            finishLoading("转换完成", "success");
        }
        catch (error) {
            console.error("Error processing selected nodes:", error);
            finishLoading("转换失败，请查看控制台", "error");
        }
    });
}
function processPages(pages, label) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            totalNodes = 0;
            processedNodes = 0;
            setLoading(`准备转换 ${label === "all pages" ? "所有页面" : "当前页"}...`, true);
            for (const page of pages) {
                if (page.name.endsWith("_Process"))
                    continue;
                countNodes(page);
            }
            const sourcePages = pages.filter(page => !page.name.endsWith("_Process"));
            for (let pageIndex = 0; pageIndex < sourcePages.length; pageIndex++) {
                const page = sourcePages[pageIndex];
                if (page.name.endsWith("_Process"))
                    continue;
                setLoading(`正在创建处理页 ${pageIndex + 1}/${sourcePages.length}: ${page.name}`, true);
                const processPage = mg.createPage();
                processPage.name = page.name + "_Process";
                copyPageProperties(page, processPage);
                yield transformPageNodesIncrementally(page, processPage, pageIndex + 1, sourcePages.length);
            }
            finishLoading("转换完成", "success");
        }
        catch (error) {
            console.error(`Error processing ${label}:`, error);
            finishLoading("转换失败，请查看控制台", "error");
        }
    });
}
function transformPageNodesIncrementally(sourcePage, processPage, pageIndex, pageCount) {
    return __awaiter(this, void 0, void 0, function* () {
        const children = [...sourcePage.children];
        for (let nodeIndex = 0; nodeIndex < children.length; nodeIndex++) {
            const sourceNode = children[nodeIndex];
            if (sourceNode.name.startsWith(INTERNAL_PROPS_PREFIX) || sourceNode.name.startsWith(SIBLING_PROPS_PREFIX))
                continue;
            setLoading(`转换页面 ${pageIndex}/${pageCount}：${sourcePage.name} (${nodeIndex + 1}/${children.length})`);
            const clonedNode = sourceNode.clone();
            processPage.appendChild(clonedNode);
            yield transformNodeRecursive(clonedNode);
            yield yieldToEventLoop();
        }
    });
}
function transformSelectedNodesIncrementally(selectedNodes, processPage) {
    return __awaiter(this, void 0, void 0, function* () {
        for (let nodeIndex = 0; nodeIndex < selectedNodes.length; nodeIndex++) {
            const sourceNode = selectedNodes[nodeIndex];
            if (sourceNode.name.startsWith(INTERNAL_PROPS_PREFIX) || sourceNode.name.startsWith(SIBLING_PROPS_PREFIX))
                continue;
            setLoading(`转换已选中图层 (${nodeIndex + 1}/${selectedNodes.length})：${sourceNode.name}`);
            const sourceTransform = cloneTransform(sourceNode.absoluteTransform || sourceNode.relativeTransform);
            const clonedNode = sourceNode.clone();
            processPage.appendChild(clonedNode);
            clonedNode.relativeTransform = sourceTransform;
            clonedNode.x = sourceTransform[0][2];
            clonedNode.y = sourceTransform[1][2];
            yield transformNodeRecursive(clonedNode);
            yield yieldToEventLoop();
        }
    });
}
function transformNodeRecursive(node) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            processedNodes++;
            if (processedNodes % 50 === 0 || processedNodes === totalNodes) {
                const progress = Math.round((processedNodes / totalNodes) * 100);
                setLoading(`转换中 ${progress}% (${processedNodes}/${totalNodes})`);
                yield yieldToEventLoop();
            }
            // Skip our own generated layers if we rerun or process similar names
            if (node.name.startsWith(INTERNAL_PROPS_PREFIX) || node.name.startsWith(SIBLING_PROPS_PREFIX))
                return;
            const isContainer = isConfiguredContainerType(node.type);
            if (isContainer) {
                const sourceType = node.type;
                let containerNode = node;
                let nodeJson = null;
                // Instances are intentionally downgraded to visual frames in this iteration.
                if (node.type === "INSTANCE") {
                    containerNode = node.detachInstance();
                }
                else if (sourceType === "GROUP") {
                    nodeJson = analyseNodes(node, sourceType);
                    containerNode = replaceGroupWithFrame(node);
                }
                else if (sourceType === "COMPONENT_SET") {
                    nodeJson = analyseNodes(node, sourceType);
                    containerNode = replaceComponentSetWithFrame(node);
                }
                // Generate PROPS node for container to preserve styles and type
                if (!nodeJson)
                    nodeJson = analyseNodes(containerNode, sourceType);
                if (shouldUseSiblingProps(containerNode)) {
                    yield insertSiblingPropsMarker(containerNode, nodeJson);
                }
                else {
                    const carrierFrame = createJsonCarrierFrame(INTERNAL_PROPS_PREFIX + JSON.stringify([nodeJson, []]));
                    if ('insertChild' in containerNode) {
                        containerNode.insertChild(0, carrierFrame);
                    }
                    else {
                        containerNode.appendChild(carrierFrame);
                    }
                    carrierFrame.width = 1;
                    carrierFrame.height = 1;
                    carrierFrame.x = 0;
                    carrierFrame.y = 0;
                }
                const children = [...containerNode.children];
                for (const child of children) {
                    if (child.name.startsWith(INTERNAL_PROPS_PREFIX) || child.name.startsWith(SIBLING_PROPS_PREFIX))
                        continue;
                    yield transformNodeRecursive(child);
                }
            }
            else {
                // For leaf nodes, replace with a Frame node whose name contains full property JSON.
                const nodeParent = node.parent;
                const nodeWidth = node.width;
                const nodeHeight = node.height;
                const nodeTransform = node.relativeTransform;
                const nodeJson = analyseNodes(node);
                overrideLayoutTransform(nodeJson, nodeTransform);
                const carrierFrame = createJsonCarrierFrame(JSON.stringify([nodeJson, []]));
                if (nodeParent && 'insertChild' in nodeParent) {
                    const childrenList = nodeParent.children;
                    let index = -1;
                    for (let i = 0; i < childrenList.length; i++) {
                        if (childrenList[i].id === node.id) {
                            index = i;
                            break;
                        }
                    }
                    if (index !== -1) {
                        nodeParent.insertChild(index, carrierFrame);
                    }
                    else {
                        nodeParent.appendChild(carrierFrame);
                    }
                    // Set dimensions and position exactly as the original
                    carrierFrame.width = nodeWidth;
                    carrierFrame.height = nodeHeight;
                    carrierFrame.relativeTransform = nodeTransform;
                    if (!node.removed)
                        node.remove();
                }
            }
        }
        catch (error) {
            console.error("Error processing node:", node.name, error);
        }
    });
}
function copyPageProperties(sourcePage, processPage) {
    try {
        processPage.bgColor = sourcePage.bgColor;
    }
    catch (error) {
        console.warn("Unable to copy page background:", sourcePage.name, error);
    }
    try {
        processPage.label = sourcePage.label;
    }
    catch (error) {
        console.warn("Unable to copy page label:", sourcePage.name, error);
    }
}
function setLoading(message, force = false) {
    const now = Date.now();
    if (!force && now - lastNotifyAt < 500)
        return;
    lastNotifyAt = now;
    if (loadingNotify)
        loadingNotify.cancel();
    loadingNotify = mg.notify(message, {
        position: "bottom",
        timeout: 30 * 1000,
        isLoading: true
    });
}
function finishLoading(message, type) {
    if (loadingNotify) {
        loadingNotify.cancel();
        loadingNotify = null;
    }
    mg.notify(message, {
        position: "bottom",
        timeout: 3000,
        type
    });
}
function yieldToEventLoop() {
    return new Promise(resolve => setTimeout(resolve, 0));
}
function getTopLevelSelectedNodes(selection) {
    const selectedSet = new Set(selection.map(node => node.id));
    return selection.filter(node => !hasSelectedAncestor(node, selectedSet));
}
function hasSelectedAncestor(node, selectedSet) {
    let parent = node.parent;
    while (parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT") {
        if (selectedSet.has(parent.id))
            return true;
        parent = parent.parent;
    }
    return false;
}
function insertSiblingPropsMarker(node, nodeJson) {
    return __awaiter(this, void 0, void 0, function* () {
        const nodeParent = node.parent;
        if (!nodeParent || !('insertChild' in nodeParent))
            return;
        const carrierFrame = createJsonCarrierFrame(SIBLING_PROPS_PREFIX + JSON.stringify([nodeJson, []]));
        const childrenList = nodeParent.children;
        let index = -1;
        for (let i = 0; i < childrenList.length; i++) {
            if (childrenList[i].id === node.id) {
                index = i;
                break;
            }
        }
        if (index !== -1) {
            nodeParent.insertChild(index, carrierFrame);
        }
        else {
            nodeParent.appendChild(carrierFrame);
        }
        carrierFrame.width = 1;
        carrierFrame.height = 1;
        carrierFrame.relativeTransform = node.relativeTransform;
    });
}
function shouldUseSiblingProps(node) {
    return !('insertChild' in node);
}
function replaceGroupWithFrame(node) {
    const parent = node.parent;
    if (!parent || !('insertChild' in parent))
        return node;
    const frame = createVisualFrameFromContainer(node);
    const childrenList = parent.children;
    const index = getChildIndex(parent, node);
    parent.insertChild(index !== -1 ? index : childrenList.length, frame);
    const children = [...(node.children || [])].map((child) => ({
        node: child,
        relativeTransform: cloneTransform(child.relativeTransform),
        x: child.x,
        y: child.y
    }));
    let movedChildren = 0;
    for (const child of children) {
        try {
            frame.appendChild(child.node);
            restoreLocalTransform(child.node, child.relativeTransform, child.x, child.y);
            movedChildren++;
        }
        catch (error) {
            console.error("Unable to move group child into visual frame:", child.node.name, error);
        }
    }
    if (children.length > 0 && movedChildren === 0) {
        if (!frame.removed)
            frame.remove();
        return node;
    }
    if (!node.removed)
        node.remove();
    return frame;
}
function replaceComponentSetWithFrame(node) {
    const parent = node.parent;
    if (!parent || !('insertChild' in parent))
        return node;
    const frame = createVisualFrameFromContainer(node);
    const childrenList = parent.children;
    const index = getChildIndex(parent, node);
    parent.insertChild(index !== -1 ? index : childrenList.length, frame);
    const nodeAbsoluteTransform = cloneTransform(node.absoluteTransform);
    const nodeInverseTransform = invertTransform(nodeAbsoluteTransform);
    const children = [...(node.children || [])].map((child) => ({
        node: child,
        relativeTransform: multiplyTransform(nodeInverseTransform, cloneTransform(child.absoluteTransform))
    }));
    let movedChildren = 0;
    for (const child of children) {
        try {
            frame.appendChild(child.node);
            restoreLocalTransform(child.node, child.relativeTransform, child.relativeTransform[0][2], child.relativeTransform[1][2]);
            movedChildren++;
        }
        catch (error) {
            console.error("Unable to move component child into visual frame:", child.node.name, error);
        }
    }
    if (children.length > 0 && movedChildren === 0) {
        if (!frame.removed)
            frame.remove();
        return node;
    }
    if (!node.removed)
        node.remove();
    return frame;
}
function createVisualFrameFromContainer(node) {
    const frame = mg.createFrame();
    frame.name = node.name;
    frame.isVisible = node.isVisible;
    frame.isLocked = node.isLocked;
    frame.fills = [];
    frame.relativeTransform = cloneTransform(node.relativeTransform);
    frame.x = node.x;
    frame.y = node.y;
    frame.width = node.width;
    frame.height = node.height;
    return frame;
}
function getChildIndex(parent, node) {
    const childrenList = parent.children || [];
    for (let i = 0; i < childrenList.length; i++) {
        if (childrenList[i].id === node.id)
            return i;
    }
    return -1;
}
function restoreLocalTransform(node, transform, x, y) {
    node.relativeTransform = cloneTransform(transform);
    node.x = x !== null && x !== void 0 ? x : transform[0][2];
    node.y = y !== null && y !== void 0 ? y : transform[1][2];
}
function analyseNodes(node, sourceType) {
    try {
        return analyseNodesUnsafe(node, sourceType);
    }
    catch (error) {
        logDiagnostic("warn", "[MasterGo2Figma] Unable to fully analyse node, exporting fallback", {
            node: getNodeProbe(node),
            sourceType,
            error: describeError(error),
            debugState: exportDebugState
        });
        return createFallbackNodeJson(node, sourceType);
    }
}
function analyseNodesUnsafe(node, sourceType) {
    const resolvedSourceType = sourceType || node.type;
    const rule = getLayerRule(resolvedSourceType) || getLayerRule(node.type);
    if (!rule) {
        console.warn("Unsupported layer type:", resolvedSourceType, node.type);
        return {};
    }
    if (rule.sendStrategy === "flattenBoolean")
        return transBONode(node);
    if (rule.sendStrategy === "booleanTree")
        return transBooleanTreeNode(node, rule.restoreType);
    if (rule.sendStrategy === "penNetwork")
        return transPenNode(node, resolvedSourceType, rule.restoreType);
    if (rule.sendStrategy === "ellipseArc")
        return transEllipseNode(node);
    if (rule.sendStrategy === "text")
        return transTextNode(node);
    if (rule.sendStrategy === "star")
        return transStarNode(node);
    if (rule.sendStrategy === "polygon")
        return transPolygonNode(node);
    if (rule.sendStrategy === "connector")
        return transConnectorNode(node);
    if (rule.sendStrategy === "frameLike")
        return transFrameNode(node, resolvedSourceType);
    if (rule.sendStrategy === "groupLike")
        return transGroupNode(node);
    return getUniversalProperty(node, resolvedSourceType, rule.restoreType);
}
function createFallbackNodeJson(node, sourceType) {
    const resolvedSourceType = sourceType || safeRead(() => node.type, "UNKNOWN");
    const restoreType = getRuleRestoreType(resolvedSourceType);
    const layoutTransform = safeRead(() => cloneTransform(node.relativeTransform), [[1, 0, 0], [0, 1, 0]]);
    return {
        type: restoreType,
        sourceType: resolvedSourceType,
        restoreType,
        id: safeRead(() => node.id, ""),
        name: safeRead(() => node.name, "Untitled"),
        parentID: safeRead(() => { var _a; return node.parent && node.parent.type === "PAGE" ? null : (_a = node.parent) === null || _a === void 0 ? void 0 : _a.id; }, null),
        constraints: safeRead(() => node.constraints, undefined),
        exportSettings: [],
        scence: {
            visible: safeRead(() => node.isVisible, true),
            locked: safeRead(() => node.isLocked, false)
        },
        blend: {
            opacity: safeRead(() => node.opacity, 1),
            isMask: safeRead(() => node.isMask, false),
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
            strokeCap: "NONE"
        },
        layout: {
            relativeTransform: layoutTransform,
            x: layoutTransform[0][2],
            y: layoutTransform[1][2],
            rotation: safeRead(() => -(node.rotation || 0), 0),
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
function transBONode(node) {
    // Avoid clone + flatten here. Complex boolean operations can crash the
    // MasterGo host runtime during large exports; direct network data is safer.
    const json = transPenNode(node, "BOOLEAN_OPERATION", getRuleRestoreType("BOOLEAN_OPERATION"));
    json.booleanOperation = safeRead(() => node.booleanOperation, "UNION");
    return json;
}
function transBooleanTreeNode(node, restoreType) {
    const json = getUniversalProperty(node, "BOOLEAN_OPERATION", restoreType);
    json.booleanOperation = safeRead(() => node.booleanOperation, "UNION");
    return json;
}
function transPenNode(selection, sourceType, restoreType) {
    const universalStruct = getUniversalProperty(selection, sourceType, restoreType);
    const originJson = selection.penNetwork;
    if (!originJson || !originJson.ctrlNodes || !originJson.nodes || !originJson.paths) {
        const vectorNetwork = selection.vectorNetwork;
        const resultStruct = Object.assign(vectorNetwork ? { vectorNetwork } : {}, universalStruct);
        resultStruct.type = restoreType || getRuleRestoreType(sourceType || selection.type);
        return resultStruct;
    }
    const originCtrlNodes = originJson.ctrlNodes;
    const originNodes = originJson.nodes;
    const originPaths = originJson.paths;
    const resultSegments = new Array();
    for (var j = 0; j < originPaths.length; j++) {
        var tempStart = originPaths[j][0];
        var tempEnd = originPaths[j][3];
        var tempTangentStart = { x: 0, y: 0 };
        var tempTangentEnd = { x: 0, y: 0 };
        if (originPaths[j][1] != -1) {
            tempTangentStart.x = originCtrlNodes[originPaths[j][1]].x - originNodes[tempStart].x;
            tempTangentStart.y = originCtrlNodes[originPaths[j][1]].y - originNodes[tempStart].y;
        }
        if (originPaths[j][2] != -1) {
            tempTangentEnd.x = originCtrlNodes[originPaths[j][2]].x - originNodes[tempEnd].x;
            tempTangentEnd.y = originCtrlNodes[originPaths[j][2]].y - originNodes[tempEnd].y;
        }
        resultSegments.push({
            start: tempStart,
            end: tempEnd,
            tangentStart: tempTangentStart,
            tangentEnd: tempTangentEnd
        });
    }
    const finalPathJson = {
        "segments": resultSegments,
        "vertices": originNodes,
        "regions": normalizeVectorRegions(originJson.regions)
    };
    const otherStruct = {
        "vectorNetwork": finalPathJson
    };
    const resultStruct = Object.assign(otherStruct, universalStruct);
    resultStruct.type = restoreType || getRuleRestoreType(sourceType || selection.type);
    return resultStruct;
}
function normalizeVectorRegions(regions) {
    if (!Array.isArray(regions))
        return [];
    const result = [];
    for (const region of regions) {
        if (!region || typeof region !== "object")
            continue;
        const loops = normalizeVectorRegionLoops(region.loops);
        if (loops.length === 0)
            continue;
        result.push({
            windingRule: normalizeWindingRuleForFigma(region.windingRule),
            loops
        });
    }
    return result;
}
function normalizeVectorRegionLoops(loops) {
    if (!Array.isArray(loops))
        return [];
    const result = [];
    for (const loop of loops) {
        if (!Array.isArray(loop))
            continue;
        const segmentIndexes = loop
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value));
        if (segmentIndexes.length > 0)
            result.push(segmentIndexes);
    }
    return result;
}
function normalizeWindingRuleForFigma(value) {
    if (value === "Evenodd" || value === "EVENODD")
        return "EVENODD";
    if (value === "Nonzero" || value === "NONZERO")
        return "NONZERO";
    return "NONZERO";
}
function transEllipseNode(selection) {
    const universalStruct = getUniversalProperty(selection);
    const otherStruct = { "arcData": selection.arcData };
    return Object.assign(otherStruct, universalStruct);
}
function transRectangleNode(selection) {
    const universalStruct = getUniversalProperty(selection);
    return Object.assign({}, universalStruct);
}
function transStarNode(selection) {
    const universalStruct = getUniversalProperty(selection);
    const otherStruct = {
        "pointCount": selection.pointCount,
        "innerRadius": selection.innerRadius
    };
    return Object.assign(otherStruct, universalStruct);
}
function transLineNode(selection) {
    const universalStruct = getUniversalProperty(selection);
    return Object.assign({}, universalStruct);
}
function transPolygonNode(selection) {
    const universalStruct = getUniversalProperty(selection);
    const otherStruct = { "pointCount": selection.pointCount };
    return Object.assign(otherStruct, universalStruct);
}
function transFrameNode(selection, sourceType) {
    const universalStruct = getUniversalProperty(selection, sourceType);
    const otherStruct = { "clipsContent": selection.clipsContent };
    return Object.assign(otherStruct, universalStruct);
}
function transSectionNode(selection) {
    const universalStruct = getUniversalProperty(selection, "SECTION", "SECTION");
    const otherStruct = { "clipsContent": selection.clipsContent };
    return Object.assign(otherStruct, universalStruct);
}
function transGroupNode(selection) {
    const universalStruct = getUniversalProperty(selection, "GROUP", "GROUP");
    const otherStruct = { "clipsContent": false };
    return Object.assign(otherStruct, universalStruct);
}
function transSliceNode(selection) {
    return getUniversalProperty(selection, "SLICE", "SLICE");
}
function transConnectorNode(selection) {
    const universalStruct = getUniversalProperty(selection, "CONNECTOR", "CONNECTOR");
    const connectorStart = normalizeConnectorEndpoint(selection.connectorStart);
    const connectorEnd = normalizeConnectorEndpoint(selection.connectorEnd);
    const connectorLineType = selection.connectorLineType || "ELBOWED";
    const connectorCornerRadius = selection.cornerRadius || 0;
    const connectorStartStrokeCap = selection.connectorStartStrokeCap || "NONE";
    const connectorEndStrokeCap = selection.connectorEndStrokeCap || "NONE";
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
    otherStruct.vectorNetwork = createConnectorVectorNetwork(otherStruct.connectorStartLocal, otherStruct.connectorEndLocal, connectorStart, connectorEnd, connectorLineType, connectorCornerRadius, connectorStartStrokeCap, connectorEndStrokeCap);
    return Object.assign(otherStruct, universalStruct);
}
function connectorEndpointToLocalPoint(selection, endpoint, isStart) {
    const point = endpoint && endpoint.position ? endpoint.position : null;
    if (point)
        return absolutePointToNodeLocal(selection, point);
    const width = Number(safeRead(() => selection.width, 0)) || 0;
    const height = Number(safeRead(() => selection.height, 0)) || 0;
    return isStart ? { x: 0, y: 0 } : { x: width, y: height };
}
function absolutePointToNodeLocal(node, point) {
    const transform = safeRead(() => node.absoluteTransform, null);
    if (!transform || !transform[0] || !transform[1])
        return { x: Number(point.x) || 0, y: Number(point.y) || 0 };
    const a = Number(transform[0][0]) || 0;
    const c = Number(transform[0][1]) || 0;
    const e = Number(transform[0][2]) || 0;
    const b = Number(transform[1][0]) || 0;
    const d = Number(transform[1][1]) || 0;
    const f = Number(transform[1][2]) || 0;
    const det = a * d - b * c;
    if (Math.abs(det) < 0.000001)
        return { x: (Number(point.x) || 0) - e, y: (Number(point.y) || 0) - f };
    const dx = (Number(point.x) || 0) - e;
    const dy = (Number(point.y) || 0) - f;
    return {
        x: (d * dx - c * dy) / det,
        y: (-b * dx + a * dy) / det
    };
}
function createConnectorVectorNetwork(start, end, startEndpoint, endEndpoint, lineType, cornerRadius, startStrokeCap, endStrokeCap) {
    const points = createConnectorRoutePoints(start, end, startEndpoint, endEndpoint, lineType);
    const vertices = points.map((point, index) => {
        const vertex = { x: point.x, y: point.y };
        if (index === 0)
            vertex.strokeCap = normalizeConnectorVectorStrokeCap(startStrokeCap);
        if (index === points.length - 1)
            vertex.strokeCap = normalizeConnectorVectorStrokeCap(endStrokeCap);
        if (index > 0 && index < points.length - 1) {
            const radius = getConnectorCornerRadius(points, index, cornerRadius);
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
function normalizeConnectorVectorStrokeCap(value) {
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
function normalizeConnectorEndpoint(endpoint) {
    if (!endpoint || typeof endpoint !== "object")
        return undefined;
    const result = {};
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
function transTextNode(selection) {
    var _a, _b, _c;
    const universalStruct = getUniversalProperty(selection);
    const textStyles = readNodeProperty(selection, "textStyles", []);
    let tempFontName = (_b = (_a = textStyles === null || textStyles === void 0 ? void 0 : textStyles[0]) === null || _a === void 0 ? void 0 : _a.textStyle) === null || _b === void 0 ? void 0 : _b.fontName;
    if (tempFontName && tempFontName.family == "AlibabaPuHuiTi") {
        tempFontName = {
            family: "Alibaba PuHuiTi",
            style: tempFontName.style
        };
    }
    const style = ((_c = textStyles === null || textStyles === void 0 ? void 0 : textStyles[0]) === null || _c === void 0 ? void 0 : _c.textStyle) || {};
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
        "letterSpacing": style.letterSpacing,
        "lineHeight": style.lineHeight,
    };
    return Object.assign(otherStruct, universalStruct);
}
function transBooleanNode(selection) {
    const universalStruct = getUniversalProperty(selection);
    const otherStruct = { "booleanOperation": selection.booleanOperation };
    return Object.assign(otherStruct, universalStruct);
}
function createImageAssetContext() {
    return {
        bySourceRef: {},
        assets: [],
        missingImageAssetCount: 0
    };
}
function createImageFillJson(fill) {
    var _a, _b;
    const result = {
        "blendMode": processBlendMode(fill.blendMode),
        "opacity": (_a = fill.alpha) !== null && _a !== void 0 ? _a : 1,
        "type": "IMAGE",
        "scaleMode": normalizeImageScaleModeForFigma(fill.scaleMode),
        "visible": (_b = fill.isVisible) !== null && _b !== void 0 ? _b : true
    };
    if (fill.filters)
        result.filters = fill.filters;
    if (fill.rotation !== undefined)
        result.rotation = fill.rotation;
    if (fill.ratio !== undefined)
        result.ratio = fill.ratio;
    const sourceRef = typeof fill.imageRef === "string" ? fill.imageRef : "";
    if (!sourceRef || !activeImageAssetContext) {
        markMissingImageFill(result, "missing-image");
        return result;
    }
    const asset = registerImageAsset(sourceRef);
    result.imageRef = asset.key;
    return result;
}
function normalizeImageScaleModeForFigma(value) {
    if (value === "FILL" || value === "FIT" || value === "CROP" || value === "TILE")
        return value;
    if (value === "STRETCH")
        return "FILL";
    if (value === "CENTER")
        return "FIT";
    return "FILL";
}
function registerImageAsset(sourceRef) {
    const context = activeImageAssetContext;
    const existing = context.bySourceRef[sourceRef];
    if (existing)
        return existing;
    const index = context.assets.length + 1;
    const key = `image-${padNumber(index)}`;
    const fileName = `${key}.bin`;
    const asset = {
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
function loadAndStreamImageAsset(asset, context, transfer) {
    return __awaiter(this, void 0, void 0, function* () {
        let bytes = null;
        try {
            setExportDebugState({
                phase: "asset:get-image",
                file: asset.path,
                transferId: transfer.transferId,
                fileIndex: transfer.fileIndex,
                streamedBytes: transfer.streamedBytes
            });
            const image = mg.getImageByHref(asset.sourceRef);
            if (!image || typeof image.getBytesAsync !== "function")
                throw new Error("图片资源不可读取");
            setExportDebugState({
                phase: "asset:get-bytes",
                file: asset.path,
                transferId: transfer.transferId,
                fileIndex: transfer.fileIndex,
                streamedBytes: transfer.streamedBytes
            });
            bytes = yield image.getBytesAsync();
            if (!bytes || bytes.length === 0)
                throw new Error("图片资源为空");
        }
        catch (error) {
            markImageAssetMissing(asset, context, "read", error);
            return;
        }
        const extension = detectImageExtension(bytes);
        asset.bytes = bytes;
        asset.fileName = `image-${padNumber(asset.index)}.${extension}`;
        asset.path = `assets/${asset.fileName}`;
        try {
            yield streamExportFileToUI(transfer, {
                path: asset.path,
                bytes
            });
        }
        catch (error) {
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
    });
}
function markImageAssetMissing(asset, context, reason, error) {
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
function markMissingImageFill(fill, fileName, shouldCount = true) {
    fill.imageRef = fileName;
    fill.missingAsset = true;
    if (shouldCount && activeImageAssetContext)
        activeImageAssetContext.missingImageAssetCount++;
}
function detectImageExtension(bytes) {
    if (bytes.length >= 8 &&
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
        return "png";
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
        return "jpg";
    if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
        return "gif";
    if (bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return "webp";
    }
    return "bin";
}
function fillsAndStrokes2Json(fills, strokes) {
    const resultFills = [];
    if (Array.isArray(fills)) {
        for (const fill of fills) {
            let tempResultFill = {};
            if (fill.type == "SOLID") {
                tempResultFill = {
                    "type": fill.type,
                    "visible": fill.isVisible,
                    "opacity": fill.color.a,
                    "blendMode": processBlendMode(fill.blendMode),
                    "color": { "r": fill.color.r, "g": fill.color.g, "b": fill.color.b }
                };
            }
            else if (fill.type == "GRADIENT_LINEAR") {
                tempResultFill = {
                    "type": fill.type,
                    "visible": fill.isVisible,
                    "opacity": fill.alpha,
                    "blendMode": processBlendMode(fill.blendMode),
                    "gradientStops": rountGradientStops([...fill.gradientStops]),
                    "gradientTransform": getResultArrayByTwoPoint(fill.gradientHandlePositions || [])
                };
            }
            else if (fill.type == "GRADIENT_RADIAL" || fill.type == "GRADIENT_ANGULAR" || fill.type == "GRADIENT_DIAMOND") {
                tempResultFill = {
                    "type": fill.type,
                    "visible": fill.isVisible,
                    "opacity": fill.alpha,
                    "blendMode": processBlendMode(fill.blendMode),
                    "gradientStops": rountGradientStops([...fill.gradientStops]),
                    "gradientTransform": [[0, 1, 0], [-1, 0, 1]]
                };
            }
            else if (fill.type == "IMAGE") {
                tempResultFill = createImageFillJson(fill);
            }
            if (tempResultFill.type)
                resultFills.push(tempResultFill);
        }
    }
    const resultStrokes = [];
    if (Array.isArray(strokes)) {
        for (const stroke of strokes) {
            let tempResultStroke = {};
            if (stroke.type == "SOLID") {
                tempResultStroke = {
                    "type": stroke.type,
                    "visible": stroke.isVisible,
                    "opacity": stroke.color.a,
                    "blendMode": stroke.blendMode,
                    "color": { "r": stroke.color.r, "g": stroke.color.g, "b": stroke.color.b }
                };
            }
            else if (stroke.type == "GRADIENT_LINEAR") {
                tempResultStroke = {
                    "type": stroke.type,
                    "visible": stroke.isVisible,
                    "opacity": stroke.alpha,
                    "blendMode": stroke.blendMode,
                    "gradientStops": rountGradientStops([...stroke.gradientStops]),
                    "gradientTransform": getResultArrayByTwoPoint(stroke.gradientHandlePositions || [])
                };
            }
            else if (stroke.type == "GRADIENT_RADIAL" || stroke.type == "GRADIENT_ANGULAR" || stroke.type == "GRADIENT_DIAMOND") {
                tempResultStroke = {
                    "type": stroke.type,
                    "visible": stroke.isVisible,
                    "opacity": stroke.alpha,
                    "blendMode": stroke.blendMode,
                    "gradientStops": rountGradientStops([...stroke.gradientStops]),
                    "gradientTransform": [[0, 1, 0], [-1, 0, 1]]
                };
            }
            if (tempResultStroke.type)
                resultStrokes.push(tempResultStroke);
        }
    }
    return { fills: resultFills, strokes: resultStrokes };
}
function rountGradientStops(gradientStops) {
    return gradientStops.map(stop => ({
        position: stop.position > 1 ? 1 : stop.position,
        color: Object.assign(Object.assign({}, stop.color), { a: stop.color.a > 1 ? 1 : stop.color.a })
    }));
}
function getResultArrayByTwoPoint(points) {
    if (points == undefined || points.length < 2) {
        return [[1, 0, 0], [0, 1, 0]];
    }
    var x3 = points[0].x, y3 = points[0].y, x4 = points[1].x, y4 = points[1].y;
    const m1 = [[1, 0, 0], [0, 1, 0.5], [0, 0, 1]];
    const len = Math.sqrt(Math.pow((x4 - x3), 2) + Math.pow((y4 - y3), 2));
    const m2 = [[1 / len, 0, 0], [0, 1, 0], [0, 0, 1]];
    const sina = (y3 - y4) / len, cosa = (x4 - x3) / len;
    const m3 = [[cosa, -sina, 0], [sina, cosa, 0], [0, 0, 1]];
    const m4 = [[1, 0, -x3], [0, 1, -y3], [0, 0, 1]];
    const m12 = matrixMultiplication(m2, m1);
    const m123 = matrixMultiplication(m12, m3);
    const m1234 = matrixMultiplication(m123, m4);
    return [m1234[0], m1234[1]];
    function matrixMultiplication(m1, m2) {
        let res = [];
        for (let i = 0; i < m1.length; i++) {
            res[i] = [];
            for (let j = 0; j < m2[0].length; j++) {
                let sum = 0;
                for (let k = 0; k < m2.length; k++)
                    sum += m1[i][k] * m2[k][j];
                res[i][j] = sum;
            }
        }
        return res;
    }
}
function getUniversalProperty(selection, sourceType, restoreType) {
    const resolvedSourceType = sourceType || readNodeProperty(selection, "type", "UNKNOWN");
    const resolvedRestoreType = restoreType || getRestoreType(resolvedSourceType);
    const layoutTransform = getRelativeLayoutTransform(selection);
    const fills = readNodeProperty(selection, "fills", []);
    const strokes = readNodeProperty(selection, "strokes", []);
    var tFS = fillsAndStrokes2Json(fills, strokes);
    var fourCR = {
        tl: readNodeProperty(selection, "topLeftRadius", 0) || 0,
        tr: readNodeProperty(selection, "topRightRadius", 0) || 0,
        bl: readNodeProperty(selection, "bottomLeftRadius", 0) || 0,
        br: readNodeProperty(selection, "bottomRightRadius", 0) || 0
    };
    var resCR = readNodeProperty(selection, "cornerRadius", 0) || 0;
    if (resCR === "Symbol(mg.mixed)")
        resCR = -1;
    var resCS = readNodeProperty(selection, "cornerSmooth", 0) || 0;
    var effectsArray = [];
    const effects = readNodeProperty(selection, "effects", []);
    for (const tE of effects) {
        if (tE.type == "DROP_SHADOW" || tE.type == "INNER_SHADOW") {
            effectsArray.push({
                "type": tE.type, "color": tE.color, "offset": tE.offset, "radius": tE.radius,
                "spread": tE.spread, "visible": tE.isVisible, "blendMode": processBlendMode(tE.blendMode)
            });
        }
        else if (tE.type == 'LAYER_BLUR' || tE.type == 'BACKGROUND_BLUR') {
            effectsArray.push({ "type": tE.type, "radius": tE.radius, "visible": tE.isVisible });
        }
    }
    return {
        "type": resolvedRestoreType,
        "sourceType": resolvedSourceType,
        "restoreType": resolvedRestoreType,
        "id": readNodeProperty(selection, "id", ""),
        "name": readNodeProperty(selection, "name", "Untitled"),
        "parentID": safeRead(() => { var _a; return selection.parent && selection.parent.type == "PAGE" ? null : (_a = selection.parent) === null || _a === void 0 ? void 0 : _a.id; }, null),
        "constraints": readNodeProperty(selection, "constraints", undefined),
        "exportSettings": readNodeProperty(selection, "exportSettings", []),
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
            "dashPattern": readNodeProperty(selection, "strokeDashes", []),
            "strokeCap": readNodeProperty(selection, "strokeCap", "NONE"),
        },
        "layout": {
            "relativeTransform": layoutTransform,
            "x": layoutTransform[0][2], "y": layoutTransform[1][2],
            "rotation": -readNodeProperty(selection, "rotation", 0) || 0,
            "width": readNodeProperty(selection, "width", 0),
            "height": readNodeProperty(selection, "height", 0),
            "constrainProportions": readNodeProperty(selection, "constrainProportions", false) || false,
            "layoutMode": getLayoutMode(selection),
            "itemSpacing": readNodeProperty(selection, "itemSpacing", 0) || 0,
            "paddingLeft": readNodeProperty(selection, "paddingLeft", 0) || 0,
            "paddingRight": readNodeProperty(selection, "paddingRight", 0) || 0,
            "paddingTop": readNodeProperty(selection, "paddingTop", 0) || 0,
            "paddingBottom": readNodeProperty(selection, "paddingBottom", 0) || 0,
            "primaryAxisAlignItems": getAxisAlign(readNodeProperty(selection, "primaryAxisAlignItems", readNodeProperty(selection, "mainAxisAlignItems", "MIN"))),
            "counterAxisAlignItems": getAxisAlign(readNodeProperty(selection, "counterAxisAlignItems", readNodeProperty(selection, "crossAxisAlignItems", "MIN"))),
            "counterAxisAlignContent": getCounterAxisAlignContent(selection),
            "primaryAxisSizingMode": readNodeProperty(selection, "primaryAxisSizingMode", readNodeProperty(selection, "mainAxisSizingMode", "FIXED")),
            "counterAxisSizingMode": readNodeProperty(selection, "counterAxisSizingMode", readNodeProperty(selection, "crossAxisSizingMode", "FIXED")),
            "itemReverseZIndex": readNodeProperty(selection, "itemReverseZIndex", false) || false,
            "strokesIncludedInLayout": readNodeProperty(selection, "strokesIncludedInLayout", false) || false,
            "layoutAlign": getLayoutAlign(readNodeProperty(selection, "layoutAlign", readNodeProperty(selection, "alignSelf", "INHERIT"))),
            "layoutGrow": readNodeProperty(selection, "layoutGrow", readNodeProperty(selection, "flexGrow", 0)),
            "layoutPositioning": readNodeProperty(selection, "layoutPositioning", "AUTO")
        }
    };
}
function getRelativeLayoutTransform(selection) {
    // MasterGo reports absoluteTransform inconsistently for some grouped node
    // types. The node's own relativeTransform is the reliable local transform
    // and is also what we use when replacing the layer with a JSON text marker.
    return cloneTransform(readNodeProperty(selection, "relativeTransform", [[1, 0, 0], [0, 1, 0]]));
}
function overrideLayoutTransform(nodeJson, transform) {
    if (!nodeJson || !nodeJson.layout || !transform)
        return;
    const layoutTransform = cloneTransform(transform);
    nodeJson.layout.relativeTransform = layoutTransform;
    nodeJson.layout.x = layoutTransform[0][2];
    nodeJson.layout.y = layoutTransform[1][2];
}
function cloneTransform(transform) {
    return [
        [transform[0][0], transform[0][1], transform[0][2]],
        [transform[1][0], transform[1][1], transform[1][2]]
    ];
}
function getRestoreType(sourceType) {
    return getRuleRestoreType(sourceType);
}
function getLayoutMode(selection) {
    const layoutMode = readNodeProperty(selection, "layoutMode", readNodeProperty(selection, "flexMode", "NONE"));
    if (layoutMode === "ROW")
        return "HORIZONTAL";
    if (layoutMode === "COLUMN")
        return "VERTICAL";
    return layoutMode;
}
function getAxisAlign(value) {
    if (value === "FLEX_START")
        return "MIN";
    if (value === "FLEX_END")
        return "MAX";
    if (value === "SPACING_BETWEEN")
        return "SPACE_BETWEEN";
    return value;
}
function getCounterAxisAlignContent(selection) {
    return readNodeProperty(selection, "counterAxisAlignContent", readNodeProperty(selection, "crossAxisAlignContent", "AUTO"));
}
function getLayoutAlign(value) {
    if (value === "STRETCH" || value === "INHERIT")
        return value;
    return getAxisAlign(value);
}
function multiplyTransform(a, b) {
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
function invertTransform(transform) {
    const a = transform[0][0];
    const b = transform[0][1];
    const c = transform[0][2];
    const d = transform[1][0];
    const e = transform[1][1];
    const f = transform[1][2];
    const det = a * e - b * d;
    if (Math.abs(det) < 0.000001)
        return [[1, 0, 0], [0, 1, 0]];
    return [
        [e / det, -b / det, (b * f - e * c) / det],
        [-d / det, a / det, (d * c - a * f) / det]
    ];
}
function createJsonCarrierFrame(name) {
    const frame = mg.createFrame();
    frame.name = name;
    frame.fills = [{
            type: "SOLID",
            color: { r: 0, g: 0, b: 0, a: 0.1 }
        }];
    return frame;
}
function processBlendMode(blendMode) {
    var resultBlenderMode = blendMode;
    if (resultBlenderMode == "PLUS_DARKER" || resultBlenderMode == "PASS_THROUGH")
        resultBlenderMode = "NORMAL";
    return resultBlenderMode;
}
