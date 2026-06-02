import { RestorePerformanceStats, RestoreProgressState, CachedLayerConversionRules, LayerConversionRule } from "../../shared/types";
import { formatDurationMs } from "../../shared/utils";

class RestorerState {
    public documentFonts: Font[] = [];
    public restoredLayoutByNodeId: { [id: string]: any } = {};
    public importInProgress = false;
    public cachedLayerRules: CachedLayerConversionRules | null = null;
    public layerRulesBySourceType: { [sourceType: string]: LayerConversionRule } | null = null;
    public layerRulesLoadPromise: Promise<void> | null = null;
    public activeImportAssets: { [fileName: string]: Uint8Array } = {};
    public imageHashByAssetName: { [fileName: string]: string } = {};
    public missingImageAssetNames: { [fileName: string]: boolean } = {};
    public missingImageAssetCount = 0;
    public placeholderImageHash: string | null = null;
    public restoredNodeIdBySourceId: { [sourceId: string]: string } = {};
    public deferredConnectorRestores: Array<{ node: ConnectorNode; data: any }> = [];
    public deferredLayoutRestores: Array<{ node: SceneNode; layout: any; isGroup: boolean }> = [];
    public fontLoadPromises: { [key: string]: Promise<void> } = {};
    public availableFontKeys: { [key: string]: boolean } = {};
    public fallbackConnectorCount = 0;
    public booleanFallbackCount = 0;
    public connectorFallbackLogged = false;
    public activeRestoreStats: RestorePerformanceStats | null = null;
    public activeProgressState: RestoreProgressState | null = null;

    public reset() {
        this.activeImportAssets = {};
        this.imageHashByAssetName = {};
        this.missingImageAssetNames = {};
        this.missingImageAssetCount = 0;
        this.restoredNodeIdBySourceId = {};
        this.deferredConnectorRestores = [];
        this.deferredLayoutRestores = [];
        this.fallbackConnectorCount = 0;
        this.booleanFallbackCount = 0;
        this.connectorFallbackLogged = false;
    }

    public resetRestoreRuntimeStats(totalNodes: number, pageCount: number) {
        this.activeRestoreStats = {
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
        this.activeProgressState = {
            total: totalNodes,
            lastCurrent: 0,
            lastPostedAt: Date.now()
        };
    }

    public logRestorePerformanceSummary(restoredNodes: number, pageCount: number) {
        if (!this.activeRestoreStats) return;

        this.activeRestoreStats.restoredNodes = restoredNodes;
        this.activeRestoreStats.pageCount = pageCount;
        const durationMs = Math.max(Date.now() - this.activeRestoreStats.startedAt, 1);
        const nodesPerSecond = Math.round((restoredNodes / durationMs) * 10000) / 10;

        console.log("[MasterGo2Figma] Restore performance", {
            durationMs,
            duration: formatDurationMs(durationMs),
            nodesPerSecond,
            totalNodes: this.activeRestoreStats.totalNodes,
            restoredNodes,
            pageCount,
            textNodeCount: this.activeRestoreStats.textNodeCount,
            fontListLoadCount: this.activeRestoreStats.fontListLoadCount,
            fontLoadRequestCount: this.activeRestoreStats.fontLoadRequestCount,
            fontLoadCacheHitCount: this.activeRestoreStats.fontLoadCacheHitCount,
            fontLoadFailureCount: this.activeRestoreStats.fontLoadFailureCount,
            deferredLayoutNodeCount: this.activeRestoreStats.deferredLayoutNodeCount,
            deferredLayoutAppliedCount: this.activeRestoreStats.deferredLayoutAppliedCount,
            safeSetWriteCount: this.activeRestoreStats.safeSetWriteCount,
            safeSetSkipCount: this.activeRestoreStats.safeSetSkipCount,
            resizeWriteCount: this.activeRestoreStats.resizeWriteCount,
            resizeSkipCount: this.activeRestoreStats.resizeSkipCount,
            booleanFallbackCount: this.booleanFallbackCount,
            fallbackConnectorCount: this.fallbackConnectorCount
        });
    }
}

export const state = new RestorerState();
