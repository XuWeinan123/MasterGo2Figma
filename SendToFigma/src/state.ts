import { 
    ExportOptions, ExportPerformanceStats, ExportProgressState, ExportDebugState, 
    CachedLayerConversionRules, LayerConversionRule, ImageAssetContext, 
    ExportTransferAckResolver, ExportFileAckResolver, ExportFile, ExportManifest 
} from "../../shared/types";
import { formatDurationMs, describeError, yieldToEventLoop } from "../../shared/utils";

class SendToFigmaState {
    public totalNodes = 0;
    public processedNodes = 0;
    public loadingNotify: any = null; // NotificationHandler
    public lastNotifyAt = 0;
    public exportInProgress = false;
    public isVerboseLoggingActive = false;

    public cachedLayerRules: CachedLayerConversionRules | null = null;
    public layerRulesBySourceType: { [sourceType: string]: LayerConversionRule } | null = null;
    public layerRulesLoadPromise: Promise<void> | null = null;

    public activeImageAssetContext: ImageAssetContext | null = null;
    public exportTransferAckResolvers: { [transferId: string]: ExportTransferAckResolver } = {};
    public exportFileAckResolvers: { [key: string]: ExportFileAckResolver } = {};
    
    public exportDebugState: ExportDebugState = { phase: "idle" };
    public activeExportStats: ExportPerformanceStats | null = null;
    public activeExportProgress: ExportProgressState | null = null;

    public logDebug(message: string, ...args: any[]) {
        if (this.isVerboseLoggingActive) {
            console.log(`[MasterGo2Figma] [DEBUG] ${message}`, ...args);
        }
    }

    public logDiagnostic(level: "log" | "warn" | "error", message: string, payload?: any) {
        if (level === "error") {
            console.error(message, payload);
        } else if (level === "warn") {
            console.warn(message, payload);
        } else {
            console.log(message, payload);
        }
    }

    public setExportDebugState(nextState: Omit<ExportDebugState, "processedNodes" | "totalNodes">) {
        this.exportDebugState.phase = nextState.phase;
        this.exportDebugState.page = nextState.page;
        this.exportDebugState.node = nextState.node;
        this.exportDebugState.nodeComplexity = nextState.nodeComplexity;
        this.exportDebugState.parentId = nextState.parentId;
        this.exportDebugState.nodeIndex = nextState.nodeIndex;
        this.exportDebugState.file = nextState.file;
        this.exportDebugState.transferId = nextState.transferId;
        this.exportDebugState.fileIndex = nextState.fileIndex;
        this.exportDebugState.chunkIndex = nextState.chunkIndex;
        this.exportDebugState.fileSize = nextState.fileSize;
        this.exportDebugState.streamedBytes = nextState.streamedBytes;
        this.exportDebugState.processedNodes = this.processedNodes;
        this.exportDebugState.totalNodes = this.totalNodes;
    }

    public resetExportStats(options: ExportOptions, pageCount: number, rootCount: number) {
        this.logDiagnostic("log", "[MasterGo2Figma] Export session stats reset", {
            pageCount,
            rootCount,
            transferMode: options.transferMode,
            relayUrl: options.relayUrl || ""
        });

        this.totalNodes = 0;
        this.processedNodes = 0;

        this.activeExportStats = {
            startedAt: Date.now(),
            scope: options.scope,
            transferMode: options.transferMode,
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
        this.activeExportProgress = {
            lastCurrent: 0,
            lastPostedAt: Date.now()
        };
    }

    public async timeExportPhase<T>(phase: "scanMs" | "exportMs" | "assetMs" | "manifestMs" | "ackMs", action: () => Promise<T>): Promise<T> {
        const startedAt = Date.now();
        try {
            return await action();
        } finally {
            if (this.activeExportStats) {
                this.activeExportStats[phase] += Date.now() - startedAt;
            }
        }
    }

    public noteExportFileTransfer(file: ExportFile, size: number, totalChunks: number) {
        if (!this.activeExportStats) return;
        this.activeExportStats.files++;
        this.activeExportStats.chunks += totalChunks;
        this.activeExportStats.bytes += size;
        if (file.path.indexOf("/layers/layers-") !== -1) {
            this.activeExportStats.layerChunkFiles++;
        }
    }

    public noteExportLayerRecord() {
        if (this.activeExportStats) this.activeExportStats.layerRecords++;
    }

    public noteExportSplitPackage() {
        if (this.activeExportStats) this.activeExportStats.splitPackages++;
    }

    public updateExportStatsFromManifest(manifest?: ExportManifest) {
        if (!this.activeExportStats) return;
        this.activeExportStats.totalNodes = this.totalNodes > 0 ? this.totalNodes : this.processedNodes;
        this.activeExportStats.processedNodes = this.processedNodes;
        if (manifest) {
            this.activeExportStats.imageAssets = manifest.stats.imageAssetCount;
            this.activeExportStats.missingImageAssets = manifest.stats.missingImageAssetCount;
        }
    }

    public logExportPerformanceSummary(label: string, manifest?: ExportManifest) {
        if (!this.activeExportStats) return;
        this.updateExportStatsFromManifest(manifest);
        const durationMs = Math.max(Date.now() - this.activeExportStats.startedAt, 1);
        const nodesPerSecond = Math.round((this.activeExportStats.processedNodes / durationMs) * 10000) / 10;
        console.log("[MasterGo2Figma] Export performance", {
            label,
            durationMs,
            duration: formatDurationMs(durationMs),
            nodesPerSecond,
            scope: this.activeExportStats.scope,
            transferMode: this.activeExportStats.transferMode,
            pageCount: this.activeExportStats.pageCount,
            rootCount: this.activeExportStats.rootCount,
            totalNodes: this.activeExportStats.totalNodes,
            processedNodes: this.activeExportStats.processedNodes,
            scanMs: this.activeExportStats.scanMs,
            exportMs: this.activeExportStats.exportMs,
            assetMs: this.activeExportStats.assetMs,
            manifestMs: this.activeExportStats.manifestMs,
            ackMs: this.activeExportStats.ackMs,
            files: this.activeExportStats.files,
            chunks: this.activeExportStats.chunks,
            bytes: this.activeExportStats.bytes,
            layerChunkFiles: this.activeExportStats.layerChunkFiles,
            layerRecords: this.activeExportStats.layerRecords,
            splitPackages: this.activeExportStats.splitPackages,
            imageAssets: this.activeExportStats.imageAssets,
            missingImageAssets: this.activeExportStats.missingImageAssets,
            progressPosts: this.activeExportStats.progressPosts,
            progressYields: this.activeExportStats.progressYields
        });
    }

    public postUI(message: any) {
        try {
            mg.ui.postMessage(message);
        } catch (error) {
            console.warn("Unable to post message to SendToFigma UI:", error);
        }
    }

    public postProgressUI(message: any) {
        this.postUI(message);
    }

    public async maybeReportExportProgress(current: number, total: number, label: string, force = false) {
        const now = Date.now();
        const state = this.activeExportProgress || {
            lastCurrent: 0,
            lastPostedAt: 0
        };
        const shouldPost = force ||
            current >= total ||
            current - state.lastCurrent >= 100 || // EXPORT_PROGRESS_EVERY_LAYERS
            now - state.lastPostedAt >= 200; // EXPORT_PROGRESS_TIME_INTERVAL_MS

        if (!shouldPost) return;

        this.postProgressUI({
            type: "progress",
            phase: "exporting",
            current,
            total,
            label
        });
        state.lastCurrent = current;
        state.lastPostedAt = now;
        this.activeExportProgress = state;

        if (this.activeExportStats) {
            this.activeExportStats.progressPosts++;
            this.activeExportStats.progressYields++;
        }
        await yieldToEventLoop();
    }
}

export const state = new SendToFigmaState();
export default state;
