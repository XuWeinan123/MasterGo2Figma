/// <reference types="@mastergo/plugin-typings" />

import { state } from "./state";
import {
    startLayerRulesLoad, ensureLayerRulesLoaded, getLayerRuleStatus
} from "./layerRules";
import {
    streamJsonExportPackage, getDocumentPageSummaries, resolveExportTransferAck, resolveExportFileAck
} from "./transferStream";
import {
    ExportOptions, PendingExportQueue, PreparedExportRun, ExportManifest
} from "../../shared/types";
import {
    safeRead, describeError, yieldToEventLoop
} from "../../shared/utils";

const EXPORT_QUEUE_CACHE_KEY = "mastergo2figma.export-queue.v1";
const MAX_PAGES_PER_BATCH = 1;

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

        if (message.type === "resize") {
            const width = typeof message.width === "number" ? message.width : 400;
            const height = typeof message.height === "number" ? message.height : 710;
            mg.ui.resize(width, height);
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
        if (state.exportInProgress) return;

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

        state.exportInProgress = true;
        try {
            const prepared = await prepareExportRun(options);
            state.logDiagnostic("log", "[MasterGo2Figma] Export queue plan", createPreparedExportLog(options, prepared));
            await savePendingExportQueueForRecovery(prepared);
            state.logDiagnostic("log", "[MasterGo2Figma] Export batch start", createPreparedExportLog(options, prepared));
            const success = await runWithUI(prepared.options);
            if (success) {
                state.logDiagnostic("log", "[MasterGo2Figma] Export batch complete", createPreparedExportLog(options, prepared));
                await updatePendingExportQueue(prepared);
            } else if (prepared.remainingPageIds.length > 0) {
                state.logDiagnostic("warn", "[MasterGo2Figma] Export queue not advanced because current run failed", {
                    sessionId: prepared.options.sessionId,
                    batchIndex: prepared.options.batchIndex,
                    batchTotal: prepared.options.batchTotal,
                    remainingPageCount: prepared.remainingPageIds.length,
                    remainingPages: summarizePageIds(prepared.remainingPageIds.slice(0, 5)),
                    debugState: state.exportDebugState
                });
            }
        } catch (error) {
            state.logDiagnostic("error", "[MasterGo2Figma] Export run failed before completion", {
                error: describeError(error),
                debugState: state.exportDebugState
            });
            state.postUI({
                type: "error",
                message: error instanceof Error ? error.message : "导出失败，请查看控制台"
            });
        } finally {
            state.exportInProgress = false;
        }
    };

    openPluginUI();
    startLayerRulesLoad();
}

function openPluginUI() {
    try {
        mg.showUI(__html__, { width: 400, height: 710 });
    } catch (error) {
        console.warn("Unable to open preferred SendToFigma UI size, retrying with compact size:", error);
        mg.showUI(__html__, { width: 400, height: 710 });
    }
}

function unwrapUIMessage(rawMessage: any) {
    if (rawMessage && rawMessage.pluginMessage) return rawMessage.pluginMessage;
    return rawMessage;
}

async function testMainRelayFetch(rawRelayUrl: string) {
    const relayUrl = normalizeRelayUrl(rawRelayUrl);
    state.postUI({
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
    state.postUI({
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
            state.postUI({
                type: "error",
                message: error instanceof Error ? error.message : "插件初始化失败"
            });
        } catch (_) {
            // UI may not be ready yet.
        }
    }
}

function normalizeScope(scope: string): ExportOptions["scope"] {
    if (scope === "all-pages") return "all-pages";
    if (scope === "selected") return "selected";
    if (scope === "partial-pages") return "partial-pages";
    return "current-page";
}

function normalizeTransferMode(mode: string): ExportOptions["transferMode"] {
    return mode === "local-json-stream" ? "local-json-stream" : "direct-zip";
}

async function runWithUI(options: ExportOptions): Promise<boolean> {
    try {
        await ensureLayerRulesLoaded();
        if (options.transferMode === "local-json-stream") {
            if (!options.relayUrl) throw new Error("请填写本地流传输服务地址");
            state.postProgressUI({ type: "progress", phase: "start", current: 0, total: 0, label: "正在准备流传输 JSON..." });
            const manifest = await streamJsonExportPackage(options);
            cacheLatestExportSummary(manifest);
            return true;
        }

        state.postProgressUI({ type: "progress", phase: "start", current: 0, total: 0, label: "正在准备生成 zip..." });
        const manifest = await streamJsonExportPackage(options);
        cacheLatestExportSummary(manifest);
        return true;
    } catch (error) {
        state.logDiagnostic("error", "[MasterGo2Figma] Export failed", {
            error: describeError(error),
            debugState: state.exportDebugState
        });
        state.postUI({
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
    state.logDiagnostic("log", "[MasterGo2Figma] Export recovery queue saved", {
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
        state.postUI({ type: "export-queue-cleared" });
        if (prepared.options.scope === "partial-pages") {
            state.logDiagnostic("log", "[MasterGo2Figma] Export queue complete", {
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
    const queueStatus = createExportQueueStatus(queue);
    state.logDiagnostic("log", "[MasterGo2Figma] Export queue saved", {
        sessionId: prepared.options.sessionId || "",
        autoContinue: prepared.options.autoContinue === true,
        exportedPages: summarizePageIds(prepared.options.pageIds),
        remainingPageCount: remainingPageIds.length,
        nextPage: summarizePageIds(remainingPageIds.slice(0, 1))[0] || null
    });
    state.postUI({ type: "export-queue-updated", exportQueue: queueStatus });
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
