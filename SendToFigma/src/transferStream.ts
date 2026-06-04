import { 
    ExportOptions, ExportManifest, PageExportTarget, ExportPageIndex, 
    LayerChunkAccumulator, ExportTransferState, ExportFile, ExportTransferFileKind,
    ExportTransferTarget, ExportTransferAck, ExportFileAck
} from "../../shared/types";
import { state } from "./state";
import { 
    safeRead, isOutOfMemoryError, describeError, yieldToEventLoop 
} from "../../shared/utils";
import { 
    collectSubtreeIterative, getSafeExportableChildren 
} from "./nodeTraverser";
import { loadAndStreamImageAsset, padNumber } from "./imageExporter";
import { getNodeProbe } from "./serializers/universal";
import {
    EXPORT_TRANSFER_CHUNK_SIZE,
    EXPORT_TEXT_CHUNK_CHAR_LIMIT,
    EXPORT_TRANSFER_YIELD_EVERY_CHUNKS,
    EXPORT_FILE_YIELD_EVERY_FILES,
    LAYER_CHUNK_MAX_RECORDS,
    LAYER_CHUNK_MAX_BYTES,
    LAYER_CHUNK_LOG_BYTES,
    LAYER_CHUNK_LOG_EVERY,
    PAGE_SEGMENT_TARGET_LAYERS,
    EXPORT_SCAN_YIELD_EVERY_NODES,
    DEBUG_LOGGING_PAGE_INDEX_START,
    EXPORT_FILE_ACK_TIMEOUT_MS,
    EXPORT_TRANSFER_ACK_TIMEOUT_MS,
} from "./exportConfig";

// Feature flags and transfer-target identifiers (not tuning numbers).
const EXPORT_TARGET_ZIP = "zip";
const EXPORT_TARGET_LOCAL_RELAY = "local-relay";
const SEND_TEXT_CHUNKS_AS_BYTES = true;
const ENABLE_IMAGE_EXPORT = true;
const ENABLE_SPLIT_EXPORT = true;

// Tagged error for the UI transfer / zip-write boundary. The main thread treats
// these as non-recoverable (it cannot retry a node when the UI side failed to
// write or timed out), so we mark them with an explicit, stable `code` instead
// of relying on substring matching of the human-readable message.
export const UI_TRANSFER_ERROR_CODE = "UI_TRANSFER";

export function uiTransferError(message: string): Error {
    const error = new Error(message) as Error & { code?: string };
    error.code = UI_TRANSFER_ERROR_CODE;
    return error;
}

export function safeStringifyForLog(value: any): string {
    try {
        return JSON.stringify(value);
    } catch (_) {
        return "[Unstringifyable Object]";
    }
}

export function getExportFileAckKey(transferId: string, index: number): string {
    return `${transferId}:${index}`;
}

export function getExportTransferMessageMeta(transfer: ExportTransferState) {
    return {
        target: transfer.target,
        relayUrl: transfer.relayUrl || ""
    };
}

export function startExportTransfer(transfer: ExportTransferState) {
    state.postUI({
        type: "export-transfer-start",
        transferId: transfer.transferId,
        filename: transfer.filename,
        fileCount: 0,
        totalBytes: 0,
        ...getExportTransferMessageMeta(transfer)
    });
}

export function abortExportFileToUI(transfer: ExportTransferState, index: number, path: string, error: any) {
    try {
        state.postUI({
            type: "export-file-abort",
            transferId: transfer.transferId,
            index,
            path,
            reason: safeStringifyForLog(describeError(error)),
            ...getExportTransferMessageMeta(transfer)
        });
    } catch (abortError) {
        state.logDiagnostic("warn", "[MasterGo2Figma] Unable to send export-file-abort", {
            abortError: describeError(abortError),
            originalError: describeError(error),
            transfer: summarizeTransfer(transfer),
            file: { index, path }
        });
    }
}

export function clearPendingExportFileAck(transfer: ExportTransferState, index: number) {
    const key = getExportFileAckKey(transfer.transferId, index);
    const resolver = state.exportFileAckResolvers[key];
    if (!resolver) return;
    clearTimeout(resolver.timeoutId);
    delete state.exportFileAckResolvers[key];
}

export function waitForExportFileAck(transfer: ExportTransferState, index: number, path: string, timeoutMs = EXPORT_FILE_ACK_TIMEOUT_MS) {
    return new Promise<ExportFileAck>((resolve, reject) => {
        const key = getExportFileAckKey(transfer.transferId, index);
        const timeoutId = setTimeout(() => {
            delete state.exportFileAckResolvers[key];
            reject(uiTransferError(`Timed out waiting for UI file ack: ${path}`));
        }, timeoutMs) as any as number;
        state.exportFileAckResolvers[key] = {
            resolve,
            reject,
            timeoutId,
            path
        };
    });
}

export async function streamExportFileToUI(transfer: ExportTransferState, file: ExportFile) {
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
        state.setExportDebugState({
            phase: "transfer:file-start",
            file: file.path,
            transferId: transfer.transferId,
            fileIndex: index,
            fileSize: size,
            streamedBytes: transfer.streamedBytes
        });
        state.postUI({
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
                state.setExportDebugState({
                    phase: "transfer:bytes-chunk",
                    file: file.path,
                    transferId: transfer.transferId,
                    fileIndex: index,
                    chunkIndex,
                    fileSize: size,
                    streamedBytes: transfer.streamedBytes
                });
                state.postUI({
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
                state.setExportDebugState({
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
                state.postUI(message);
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
        state.setExportDebugState({
            phase: "transfer:file-end",
            file: file.path,
            transferId: transfer.transferId,
            fileIndex: index,
            fileSize: size,
            streamedBytes: transfer.streamedBytes
        });
        const fileAckPromise = waitForExportFileAck(transfer, index, file.path);
        state.postUI({ type: "export-file-end", transferId: transfer.transferId, index, ...getExportTransferMessageMeta(transfer) });
        fileEnded = true;
        await fileAckPromise;
        state.noteExportFileTransfer(file, size, totalChunks);
        if (index % EXPORT_FILE_YIELD_EVERY_FILES === 0) await yieldToHost();
    } catch (error) {
        state.logDiagnostic("error", "[MasterGo2Figma] Transfer file failed", {
            error: describeError(error),
            file: {
                path: file.path,
                kind,
                index,
                size,
                started: fileStarted,
                ended: fileEnded
            },
            debugState: state.exportDebugState
        });
        if (fileStarted && !fileEnded) abortExportFileToUI(transfer, index, file.path, error);
        clearPendingExportFileAck(transfer, index);
        throw error;
    }
}

export function resolveExportFileAck(message: any) {
    const transferId = String(message && message.transferId || "");
    const index = Number(message && message.index);
    const key = getExportFileAckKey(transferId, index);
    const resolver = state.exportFileAckResolvers[key];
    if (!resolver) return;
    clearTimeout(resolver.timeoutId);
    delete state.exportFileAckResolvers[key];

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
        resolver.reject(uiTransferError(`UI failed to write ${ack.path || resolver.path}: ${ack.error || "unknown error"}; pending=${ack.pendingCount === undefined ? "unknown" : ack.pendingCount}`));
    }
}

export function completeExportTransfer(
    transfer: ExportTransferState,
    manifest: ExportManifest,
    isFinal = true,
    stats: ExportManifest["stats"] = manifest.stats
) {
    state.postUI({
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

export function resolveExportTransferAck(message: any) {
    const transferId = String(message && message.transferId || "");
    const resolver = state.exportTransferAckResolvers[transferId];
    if (!resolver) return;
    clearTimeout(resolver.timeoutId);
    delete state.exportTransferAckResolvers[transferId];

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
        resolver.reject(uiTransferError(`UI zip failed for ${ack.filename || transferId}: ${ack.error || "unknown error"}; pending=${ack.pendingCount === undefined ? "unknown" : ack.pendingCount}`));
    }
}

export function waitForExportTransferAck(transfer: ExportTransferState, timeoutMs = EXPORT_TRANSFER_ACK_TIMEOUT_MS) {
    return new Promise<ExportTransferAck>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            delete state.exportTransferAckResolvers[transfer.transferId];
            reject(uiTransferError(`Timed out waiting for UI zip ack: ${transfer.filename}`));
        }, timeoutMs) as any as number;
        state.exportTransferAckResolvers[transfer.transferId] = {
            resolve,
            reject,
            timeoutId
        };
    });
}

export function yieldToHost() {
    return new Promise<void>(resolve => setTimeout(resolve, 0));
}

export function createExportFilename(manifest: ExportManifest) {
    const date = manifest.exportedAt.replace(/[:.]/g, "-");
    return `mastergo2figma-${manifest.scope}-${date}.zip`;
}

export function createPageExportFilename(
    scope: any, // ExportScope
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

export function createFileSafeName(value: string, fallback: string) {
    const cleaned = String(value || "")
        .trim()
        .replace(/[\\/:*?"<>|]/g, "-")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 48);
    return cleaned || fallback;
}

export function getExportTargets(options: ExportOptions): PageExportTarget[] {
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

export function getTopLevelSelectedNodes(selection: SceneNode[]) {
    const selectedSet = new Set(selection.map(node => node.id));
    return selection.filter(node => !hasSelectedAncestor(node, selectedSet));
}

export function hasSelectedAncestor(node: SceneNode, selectedSet: Set<string>) {
    let parent = node.parent as any;
    while (parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT") {
        if (selectedSet.has(parent.id)) return true;
        parent = parent.parent;
    }
    return false;
}

export function ensureTargetNodes(target: PageExportTarget): SceneNode[] {
    if (!target.nodes) {
        target.nodes = getSafeExportableChildren(target.page);
    }
    return target.nodes;
}

export function clearTargetNodes(target: PageExportTarget) {
    if (target.nodes) {
        target.nodes.length = 0;
        delete target.nodes;
    }
}

export function shouldSplitExportPackages(options: ExportOptions, targets: PageExportTarget[]): boolean {
    if (!ENABLE_SPLIT_EXPORT) return false;
    if (options.transferMode === "direct-zip") return false;
    if (targets.length > 1) return true;
    const nodes = ensureTargetNodes(targets[0]);
    return nodes.length > 1;
}

export function createBaseExportManifest(options: ExportOptions, pageCount: number): ExportManifest {
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

export function createExportTransfer(manifest: ExportManifest, filename?: string, options?: ExportOptions): ExportTransferState {
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

export function summarizeTransfer(transfer: ExportTransferState) {
    return {
        transferId: transfer.transferId,
        filename: transfer.filename,
        fileIndex: transfer.fileIndex,
        postedChunks: transfer.postedChunks,
        streamedBytes: transfer.streamedBytes
    };
}

export function releaseExportPackageMemory(manifest: ExportManifest, imageAssetContext: any) {
    manifest.pages = [];
    manifest.assets = {};
    imageAssetContext.assets.length = 0;
    imageAssetContext.bySourceRef = {};
}

export async function appendLayerRecord(
    recordJson: string,
    pageIndex: ExportPageIndex,
    chunk: LayerChunkAccumulator,
    transfer: ExportTransferState
) {
    const nextBytes = recordJson.length + (chunk.recordJsons.length > 0 ? 1 : 0);
    if (recordJson.length > LAYER_CHUNK_MAX_BYTES) {
        state.logDiagnostic("warn", "[MasterGo2Figma] Single layer record exceeds chunk byte target", {
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

export async function flushLayerChunk(
    pageIndex: ExportPageIndex,
    chunk: LayerChunkAccumulator,
    transfer: ExportTransferState
) {
    if (chunk.recordJsons.length === 0) return;

    const fileIndex = chunk.chunkIndex++;
    const path = `pages/${chunk.pageFolder}/layers/layers-${padNumber(fileIndex)}.json`;
    const recordCount = chunk.recordJsons.length;
    const byteCount = chunk.bytes;
    state.setExportDebugState({
        phase: "chunk:flush",
        page: pageIndex.name,
        file: path,
        transferId: transfer.transferId,
        fileIndex: transfer.fileIndex,
        chunkIndex: fileIndex,
        fileSize: byteCount,
        streamedBytes: transfer.streamedBytes
    });
    if (fileIndex === 1 || fileIndex % LAYER_CHUNK_LOG_EVERY === 0 || byteCount >= LAYER_CHUNK_LOG_BYTES) {
        state.logDiagnostic("log", "[MasterGo2Figma] Layer chunk flush", {
            page: pageIndex.name,
            path,
            chunkIndex: fileIndex,
            records: recordCount,
            bytes: byteCount,
            processedNodes: state.processedNodes,
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

export function getDocumentPageSummaries() {
    return [...mg.document.children]
        .filter(page => !page.name.endsWith("_Process"))
        .map(page => ({
            id: page.id,
            name: page.name,
            isCurrent: page.id === mg.document.currentPage.id,
            childCount: page.children.length
        }));
}

export function createPageFolderName(page: PageNode, index: number) {
    const label = safeRead(() => page.name, "") || safeRead(() => page.id, "page");
    return `page-${padNumber(index + 1)}-${slugifyPathPart(label)}`;
}

export function createLayerFileName(node: SceneNode, index: number) {
    const label = safeRead(() => node.name, "") || safeRead(() => node.type, "untitled");
    return `layer-${padNumber(index)}-${slugifyPathPart(label)}.json`;
}

export function slugifyPathPart(value: string) {
    const normalized = value
        .toLowerCase()
        .trim()
        .replace(/[\\/:*?"<>|]/g, "-")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 32);
    return normalized || "untitled";
}

export async function countNodes(node: any) {
    state.totalNodes++;
    state.processedNodes++; // countVisited equivalent
    if (state.processedNodes % EXPORT_SCAN_YIELD_EVERY_NODES === 0) await yieldToEventLoop();
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
            state.logDiagnostic("error", "[MasterGo2Figma] Scan node failed", {
                error: describeError(error),
                node: getNodeProbe(node),
                totalNodes: state.totalNodes
            });
        }
        throw error;
    }
}

export function createImageAssetContext() {
    return {
        bySourceRef: {} as { [sourceRef: string]: any },
        assets: [] as any[],
        missingImageAssetCount: 0
    };
}

export async function streamPageRootSegmentToTransfer(
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

export async function streamPageExportToTransfer(
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
    state.isVerboseLoggingActive = pageIndex >= DEBUG_LOGGING_PAGE_INDEX_START;
    if (state.isVerboseLoggingActive) {
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

export async function streamImageAssetsToTransfer(
    imageAssetContext: any,
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

export async function streamPageRootSegmentsToPackages(
    options: ExportOptions,
    pageTarget: PageExportTarget,
    pageIndex: number,
    pageCount: number,
    aggregateManifest: ExportManifest
) {
    const pageName = safeRead(() => pageTarget.page.name, "Untitled");
    state.isVerboseLoggingActive = pageIndex >= DEBUG_LOGGING_PAGE_INDEX_START;
    if (state.isVerboseLoggingActive) {
        console.log(`[MasterGo2Figma] [DEBUG] Verbose logging activated for split package page: ${pageName}`);
    }
    let rootIndex = 0;
    let segmentIndex = 0;
    const nodes = ensureTargetNodes(pageTarget);
    const useSegmentNames = nodes.length > 1;

    while (rootIndex < nodes.length) {
        const imageAssetContext = createImageAssetContext();
        state.activeImageAssetContext = imageAssetContext;
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
        state.logDiagnostic("log", "[MasterGo2Figma] Split package detail", {
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

        state.noteExportSplitPackage();
        const segmentResult = await state.timeExportPhase("exportMs", async () => await streamPageRootSegmentToTransfer(
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

        state.postProgressUI({
            type: "progress",
            phase: "assets",
            current: state.processedNodes,
            total: 0,
            label: `正在导出图片资源 ${pageIndex + 1}/${pageCount}${segmentLabel}...`
        });
        await state.timeExportPhase("assetMs", async () => {
            await streamImageAssetsToTransfer(imageAssetContext, manifest, transfer);
        });

        await state.timeExportPhase("manifestMs", async () => {
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
        state.activeImageAssetContext = null;
        const ack = await state.timeExportPhase("ackMs", async () => await ackPromise);
        console.log(`[MasterGo2Figma] Split package complete ${pageIndex + 1}/${pageCount}${segmentLabel}: ${ack.filename || transfer.filename}, roots=${segmentResult.rootCount}, layers=${segmentResult.layerCount}, files=${transfer.fileIndex}, bytes=${transfer.streamedBytes}`);
        segmentIndex++;
        await yieldToHost();
    }
}

export async function streamJsonExportPackage(options: ExportOptions): Promise<ExportManifest> {
    state.totalNodes = 0;
    state.processedNodes = 0;
    const previousImageAssetContext = state.activeImageAssetContext;

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

        state.resetExportStats(options, targets.length, rootCount);

        if (shouldSplitExportPackages(options, targets)) {
            const aggregateManifest = await streamSplitJsonExportPackages(options, targets);
            state.logExportPerformanceSummary("split-complete", aggregateManifest);
            return aggregateManifest;
        }

        state.postProgressUI({ type: "progress", phase: "scan", current: 0, total: 0, label: "正在扫描图层..." });
        state.processedNodes = 0; // countVisited equivalent
        state.totalNodes = 0;
        await state.timeExportPhase("scanMs", async () => {
            for (const target of targets) {
                const nodes = ensureTargetNodes(target);
                for (const node of nodes) await countNodes(node);
                clearTargetNodes(target);
            }
        });
        state.processedNodes = 0;
        state.postProgressUI({ type: "progress", phase: "prepare", current: 0, total: state.totalNodes, label: "准备分块导出 JSON..." });

        const imageAssetContext = createImageAssetContext();
        state.activeImageAssetContext = imageAssetContext;
        const manifest = createBaseExportManifest(options, targets.length);
        const transfer = createExportTransfer(manifest, undefined, options);
        startExportTransfer(transfer);

        console.log(`[MasterGo2Figma] Export v2 start: ${targets.length} pages, ${rootCount} roots, nodes=${state.totalNodes}.`);

        await state.timeExportPhase("exportMs", async () => {
            for (let pageIndex = 0; pageIndex < targets.length; pageIndex++) {
                const pageTarget = targets[pageIndex];
                ensureTargetNodes(pageTarget);
                await streamPageExportToTransfer(pageTarget, pageIndex, targets.length, manifest, transfer);
                clearTargetNodes(pageTarget);
                targets[pageIndex] = null as any;
            }
        });

        state.postProgressUI({ type: "progress", phase: "assets", current: state.processedNodes, total: state.totalNodes, label: "正在导出图片资源..." });
        await state.timeExportPhase("assetMs", async () => {
            await streamImageAssetsToTransfer(imageAssetContext, manifest, transfer);
        });

        await state.timeExportPhase("manifestMs", async () => {
            await streamExportFileToUI(transfer, {
                path: "manifest.json",
                content: JSON.stringify(manifest)
            });
        });

        state.postProgressUI({ type: "progress", phase: "complete", current: state.processedNodes, total: state.processedNodes, label: "JSON 已生成，正在准备下载..." });
        const ackPromise = waitForExportTransferAck(transfer);
        completeExportTransfer(transfer, manifest);
        const ack = await state.timeExportPhase("ackMs", async () => await ackPromise);
        console.log(`[MasterGo2Figma] UI zip complete: ${ack.filename || transfer.filename}, files=${transfer.fileIndex}, bytes=${transfer.streamedBytes}`);
        state.logExportPerformanceSummary("complete", manifest);
        return manifest;
    } catch (error) {
        state.logExportPerformanceSummary("failed");
        state.logDiagnostic("error", "[MasterGo2Figma] Export transfer failed", {
            error: describeError(error),
            debugState: state.exportDebugState
        });
        throw error;
    } finally {
        state.activeImageAssetContext = previousImageAssetContext;
    }
}

export async function streamSplitJsonExportPackages(
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
    state.postProgressUI({
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
