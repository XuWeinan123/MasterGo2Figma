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
            const height = typeof message.height === "number" ? message.height : 620;
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
            relayUrl: typeof message.relayUrl === "string" ? message.relayUrl : undefined
        };

        state.exportInProgress = true;
        try {
            const prepared = await prepareExportRun(options);
            await savePendingExportQueueForRecovery(prepared);
            const success = await runWithUI(prepared.options);
            if (success) {
                await updatePendingExportQueue(prepared);
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
        mg.showUI(__html__, { width: 400, height: 620 });
    } catch (error) {
        console.warn("Unable to open preferred SendToFigma UI size, retrying with compact size:", error);
        mg.showUI(__html__, { width: 400, height: 620 });
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

async function prepareExportRun(options: ExportOptions): Promise<PreparedExportRun> {
    if (options.scope !== "partial-pages") {
        return { options, remainingPageIds: [], limitedToSinglePage: false };
    }

    // All selected pages are exported in one run. No per-page batching.
    const pageIds = filterExistingPageIds(options.pageIds);
    return { options: { ...options, pageIds }, remainingPageIds: [], limitedToSinglePage: false };
}

async function savePendingExportQueueForRecovery(prepared: PreparedExportRun) {
    // Record all pages being exported so that if the plugin crashes mid-run
    // the user can see which pages were in-flight when they next open the plugin.
    if (prepared.options.scope !== "partial-pages" || prepared.options.pageIds.length === 0) {
        await clearPendingExportQueue();
        return;
    }

    const now = new Date().toISOString();
    const queue: PendingExportQueue = {
        pageIds: prepared.options.pageIds,
        createdAt: now,
        updatedAt: now
    };
    await mg.clientStorage.setAsync(EXPORT_QUEUE_CACHE_KEY, queue);
}

async function updatePendingExportQueue(prepared: PreparedExportRun) {
    // All pages export in one run, so the queue is always clear after success.
    await clearPendingExportQueue();
    state.postUI({ type: "export-queue-cleared" });
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
