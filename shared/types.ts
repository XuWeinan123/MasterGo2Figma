export type ExportScope = "selected" | "current-page" | "partial-pages" | "all-pages";
export type ExportTransferMode = "direct-zip" | "local-json-stream";
export type ExportTransferTarget = "zip" | "local-relay";
export type ExportTransferFileKind = "content" | "bytes";

export type ExportOptions = {
    scope: ExportScope;
    pageIds: string[];
    transferMode: ExportTransferMode;
    relayUrl?: string;
};

export type PendingExportQueue = {
    pageIds: string[];
    createdAt: string;
    updatedAt: string;
};

export type PreparedExportRun = {
    options: ExportOptions;
    remainingPageIds: string[];
    limitedToSinglePage: boolean;
};

export type ExportFile = {
    path: string;
    content?: string;
    contentParts?: string[];
    bytes?: Uint8Array;
};

export type SendStrategy = 
    | "text" 
    | "penNetwork" 
    | "flattenBoolean" 
    | "booleanTree" 
    | "frameLike" 
    | "groupLike" 
    | "ellipseArc" 
    | "star" 
    | "polygon" 
    | "connector" 
    | "universalOnly";

export type ReceiveCreateType = 
    | "VECTOR" 
    | "ELLIPSE" 
    | "RECTANGLE" 
    | "STAR" 
    | "LINE" 
    | "POLYGON" 
    | "TEXT" 
    | "SECTION" 
    | "SLICE" 
    | "FRAME" 
    | "GROUP" 
    | "CONNECTOR" 
    | "BOOLEAN_OPERATION"
    | "SVG";

export type LayerConversionRule = {
    sourceType: string;
    restoreType: string;
    sendStrategy: SendStrategy;
    receiveCreate: ReceiveCreateType;
    isContainer: boolean;
    visualFrameSource: boolean;
};

export type LayerConversionConfig = {
    schema: string;
    version: number;
    rules: { [sourceType: string]: LayerConversionRule };
};

export type CachedLayerConversionRules = {
    config: LayerConversionConfig;
    fileName: string;
    importedAt: string;
};

export type ExportManifestPage = {
    id: string;
    name: string;
    folder: string;
    pageFile: string;
    layerCount: number;
};

export type ExportManifestAsset = {
    key: string;
    fileName: string;
    path: string;
    missing?: boolean;
};

export type ExportManifest = {
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

export type ExportPageIndex = {
    schema: "mastergo2figma.page.v2";
    version: 2;
    id: string;
    name: string;
    folder: string;
    rootNodeIds: string[];
    layerChunks: string[];
    layerCount: number;
};

export type LayerChunkAccumulator = {
    pageId: string;
    pageFolder: string;
    chunkIndex: number;
    recordJsons: string[];
    bytes: number;
    writtenNodeIds: { [id: string]: true };
};

export type ExportTransferState = {
    transferId: string;
    filename: string;
    fileIndex: number;
    postedChunks: number;
    streamedBytes: number;
    target: ExportTransferTarget;
    relayUrl?: string;
};

export type ExportTransferAck = {
    transferId: string;
    success: boolean;
    filename?: string;
    error?: string;
    pendingCount?: number;
};

export type ExportTransferAckResolver = {
    resolve: (ack: ExportTransferAck) => void;
    reject: (error: Error) => void;
    timeoutId: number;
};

export type ExportFileAck = {
    transferId: string;
    index: number;
    success: boolean;
    path?: string;
    error?: string;
    pendingCount?: number;
};

export type ExportFileAckResolver = {
    resolve: (ack: ExportFileAck) => void;
    reject: (error: Error) => void;
    timeoutId: number;
    path: string;
};

export type ExportPerformanceStats = {
    startedAt: number;
    scope: ExportScope;
    transferMode: ExportTransferMode;
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

export type ExportProgressState = {
    lastCurrent: number;
    lastPostedAt: number;
};

export type PageExportTarget = {
    page: any; // PageNode
    nodes?: any[]; // SceneNode[]
};

export type NodeComplexitySnapshot = {
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

export type ExportDebugState = {
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

export type ImageAssetRecord = {
    key: string;
    sourceRef: string;
    index: number;
    fileName: string;
    path: string;
    bytes: Uint8Array | null;
    missing: boolean;
};

export type ImageAssetContext = {
    bySourceRef: { [sourceRef: string]: ImageAssetRecord };
    assets: ImageAssetRecord[];
    missingImageAssetCount: number;
};

export type ImportLayerRecord = {
    version: number;
    id: string;
    pageId: string;
    parentId: string | null;
    index: number;
    name: string;
    childIds: string[];
    props: any;
};

export type ImportManifestPage = {
    id: string;
    name: string;
    folder: string;
    pageFile: string;
    layerCount: number;
};

export type ImportManifestAsset = {
    key: string;
    fileName: string;
    path: string;
    missing?: boolean;
};

export type ImportPageIndex = {
    schema: "mastergo2figma.page.v2";
    version: 2;
    id: string;
    name: string;
    folder: string;
    rootNodeIds: string[];
    layerChunks: string[];
    layerCount: number;
};

export type ImportManifest = {
    schema: "mastergo2figma.package.v2";
    version: 2;
    source: "mastergo";
    exportedAt: string;
    scope: string;
    pages: ImportManifestPage[];
    assets: { [key: string]: ImportManifestAsset };
    stats: {
        pageCount: number;
        layerCount: number;
        imageAssetCount?: number;
        missingImageAssetCount?: number;
    };
};

export type ImportPayload = {
    manifest: ImportManifest;
    pages: ImportPageIndex[];
    layers: { [id: string]: ImportLayerRecord };
    assets: { [assetKey: string]: Uint8Array };
};

export type DeferredLayoutRestore = {
    node: any; // SceneNode
    layout: any;
    isGroup: boolean;
};

export type RestorePerformanceStats = {
    startedAt: number;
    totalNodes: number;
    restoredNodes: number;
    pageCount: number;
    textNodeCount: number;
    fontListLoadCount: number;
    fontLoadRequestCount: number;
    fontLoadCacheHitCount: number;
    fontLoadFailureCount: number;
    deferredLayoutNodeCount: number;
    deferredLayoutAppliedCount: number;
    safeSetWriteCount: number;
    safeSetSkipCount: number;
    resizeWriteCount: number;
    resizeSkipCount: number;
};

export type RestoreProgressState = {
    total: number;
    lastCurrent: number;
    lastPostedAt: number;
};

export type MissingFontTextRestoreResult = {
    scannedTextNodeCount: number;
    candidateTextNodeCount: number;
    restoredTextNodeCount: number;
    failedTextNodeCount: number;
    loadedFontCount: number;
    failedFontCount: number;
};

export type MissingFontTextRestoreTarget = {
    node: any; // TextNode
    requestedFontName: { family: string; style: string };
    resolvedFontName: { family: string; style: string } | null;
    restoredName: string;
    requestedFontKey: string;
    resolvedFontKey: string;
};
