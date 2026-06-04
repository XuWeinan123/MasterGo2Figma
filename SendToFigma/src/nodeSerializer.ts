import { state } from "./state";
import { safeRead, isOutOfMemoryError, describeError } from "../../shared/utils";
import { 
    getUniversalProperty, readNodeProperty, cloneJsonCompatible, 
    getNodeProbe, overrideLayoutTransform 
} from "./serializers/universal";
import { transPenNode, cloneVectorNetworkForExport, normalizeVectorRegions } from "./serializers/vector";
import { 
    transEllipseNode, transRectangleNode, transStarNode, 
    transLineNode, transPolygonNode, transSliceNode 
} from "./serializers/shapes";
import { transTextNode } from "./serializers/text";
import { transConnectorNode } from "./serializers/connector";
import { transFrameNode, transSectionNode, transGroupNode, transBONode, transBooleanTreeNode } from "./serializers/container";
import { getLayerRule, getRuleRestoreType } from "./layerRules";
import { getSafeExportableChildren } from "./nodeTraverser";
import { appendLayerRecord, UI_TRANSFER_ERROR_CODE } from "./transferStream";
import {
    SVG_FALLBACK_MAX_NODES,
    SVG_FALLBACK_MAX_AREA,
    SVG_FALLBACK_MAX_DIMENSION,
    SVG_FALLBACK_MAX_BYTES,
    SVG_FALLBACK_MAX_DOCUMENT_NODES,
    STRINGIFY_PROBE_VERTEX_THRESHOLD,
    STRINGIFY_PROBE_REGION_THRESHOLD,
    STRINGIFY_PROBE_CHILD_THRESHOLD,
    STRINGIFY_RECORD_WARN_BYTES,
} from "./exportConfig";
import { cloneTransform } from "../../shared/matrixUtils";

export function hasUsableVectorNetwork(vectorNetwork: any): boolean {
    return !!(vectorNetwork &&
        Array.isArray(vectorNetwork.vertices) &&
        vectorNetwork.vertices.length > 0 &&
        Array.isArray(vectorNetwork.segments));
}

export function createFallbackNodeJson(node: SceneNode, sourceType?: string) {
    const resolvedSourceType = sourceType || safeRead(() => node.type, "UNKNOWN");
    const restoreType = getRuleRestoreType(resolvedSourceType);
    const layoutTransform = safeRead(() => cloneTransform((node as any).relativeTransform), [[1, 0, 0], [0, 1, 0]]);

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

export function analyseNodes(node: SceneNode, sourceType?: string): any {
    try {
        return sanitizeExportNodeJson(analyseNodesUnsafe(node, sourceType));
    } catch (error) {
        if (isOutOfMemoryError(error)) {
            state.logDiagnostic("error", "[MasterGo2Figma] Analyse node OOM", {
                node: getNodeProbe(node),
                sourceType,
                error: describeError(error)
            });
            throw error;
        }
        state.logDiagnostic("warn", "[MasterGo2Figma] Unable to fully analyse node, exporting fallback", {
            node: getNodeProbe(node),
            sourceType,
            error: describeError(error),
            debugState: state.exportDebugState
        });
        return sanitizeExportNodeJson(createFallbackNodeJson(node, sourceType));
    }
}

export function analyseNodesUnsafe(node: SceneNode, sourceType?: string): any {
    const resolvedSourceType = sourceType || node.type;
    const rule = getLayerRule(resolvedSourceType) || getLayerRule(node.type);
    if (!rule) {
        console.warn("Unsupported layer type:", resolvedSourceType, node.type);
        return {};
    }

    if (rule.sendStrategy === "flattenBoolean") return transBONode(node as any);
    if (rule.sendStrategy === "booleanTree") return transBooleanTreeNode(node as BooleanOperationNode, rule.restoreType);
    if (rule.sendStrategy === "penNetwork") return transPenNode(node as any, resolvedSourceType, rule.restoreType);
    if (rule.sendStrategy === "ellipseArc") return transEllipseNode(node as any);
    if (rule.sendStrategy === "text") return transTextNode(node as any);
    if (rule.sendStrategy === "star") return transStarNode(node as any);
    if (rule.sendStrategy === "polygon") return transPolygonNode(node as any);
    if (rule.sendStrategy === "connector") return transConnectorNode(node as any);
    if (rule.sendStrategy === "frameLike") return transFrameNode(node as any, resolvedSourceType);
    if (rule.sendStrategy === "groupLike") return transGroupNode(node as any);
    return getUniversalProperty(node as any, resolvedSourceType, rule.restoreType);
}

export function sanitizeExportNodeJson(nodeJson: any) {
    if (!nodeJson || typeof nodeJson !== "object") return nodeJson;

    if (nodeJson.constraints !== undefined) nodeJson.constraints = cloneJsonCompatible(nodeJson.constraints, undefined);
    if (nodeJson.exportSettings !== undefined) nodeJson.exportSettings = cloneJsonCompatible(nodeJson.exportSettings, []);
    if (nodeJson.arcData !== undefined) nodeJson.arcData = cloneJsonCompatible(nodeJson.arcData, undefined);
    if (nodeJson.fontName !== undefined) nodeJson.fontName = cloneJsonCompatible(nodeJson.fontName, nodeJson.fontName);
    if (nodeJson.letterSpacing !== undefined) nodeJson.letterSpacing = cloneJsonCompatible(nodeJson.letterSpacing, nodeJson.letterSpacing);
    if (nodeJson.lineHeight !== undefined) nodeJson.lineHeight = cloneJsonCompatible(nodeJson.lineHeight, nodeJson.lineHeight);
    if (nodeJson.styledTextSegments !== undefined) nodeJson.styledTextSegments = cloneJsonCompatible(nodeJson.styledTextSegments, nodeJson.styledTextSegments);
    return nodeJson;
}

export function countExportableSubtreeNodes(node: any): number {
    let count = 1;
    const children = getSafeExportableChildren(node);
    for (const child of children) {
        count += countExportableSubtreeNodes(child);
        if (count > SVG_FALLBACK_MAX_NODES) return count; // early exit: too many nodes for SVG fallback
    }
    return count;
}

export async function tryExportSvgMarkup(node: SceneNode, label: string): Promise<string> {
    if (state.totalNodes === 0 && label !== "Boolean") return "";
    if (state.totalNodes > SVG_FALLBACK_MAX_DOCUMENT_NODES) return ""; // document too large to rasterize

    const subtreeNodeCount = countExportableSubtreeNodes(node);
    const width = Number(safeRead(() => node.width, 0)) || 0;
    const height = Number(safeRead(() => node.height, 0)) || 0;
    const area = Math.abs(width * height);

    if (subtreeNodeCount <= SVG_FALLBACK_MAX_NODES &&
        area <= SVG_FALLBACK_MAX_AREA &&
        Math.max(Math.abs(width), Math.abs(height)) <= SVG_FALLBACK_MAX_DIMENSION) {
        try {
            state.logDebug(`    * [SVG-Export] calling exportAsync for ${node.id} (${node.type}) - name=${node.name}, dims=${width}x${height}`);
            const svg = await (node as any).exportAsync({ format: "SVG" });
            state.logDebug(`    * [SVG-Export] completed exportAsync for ${node.id}: bytes=${svg ? svg.length : 0}`);
            if (typeof svg === "string" && svg.trim()) {
                if (svg.length > SVG_FALLBACK_MAX_BYTES) { // generated SVG markup too large
                    console.warn(`[MasterGo2Figma] ${label} SVG fallback skipped because SVG is too large: ${getNodeDebugLabel(node)}, bytes=${svg.length}`);
                    return "";
                }
                return svg;
            }
        } catch (error) {
            state.logDebug(`    * [SVG-Export] exportAsync failed for ${node.id}:`, describeError(error));
            console.warn(`Unable to export ${label} as SVG fallback:`, getNodeDebugLabel(node), error);
        }
    }

    return "";
}

export function clearNodePaint(nodeJson: any) {
    if (!nodeJson.geometry) return;
    nodeJson.geometry.fills = [];
    nodeJson.geometry.strokes = [];
    nodeJson.geometry.strokeWeight = 0;
    nodeJson.geometry.strokeTopWeight = undefined;
    nodeJson.geometry.strokeBottomWeight = undefined;
    nodeJson.geometry.strokeLeftWeight = undefined;
    nodeJson.geometry.strokeRightWeight = undefined;
}

export function markBooleanAsFrameFallback(nodeJson: any) {
    nodeJson.type = "FRAME";
    nodeJson.restoreType = "FRAME";
    nodeJson.receiveCreateOverride = "FRAME";
    nodeJson.booleanFallback = "frameContainer";
    nodeJson.clipsContent = false;
    clearNodePaint(nodeJson);
}

export async function enrichBooleanOperationExport(node: SceneNode, nodeJson: any, childNodes: SceneNode[]) {
    if (!nodeJson || safeRead(() => node.type, "") !== "BOOLEAN_OPERATION") return;
    const rule = getLayerRule("BOOLEAN_OPERATION");
    if (rule && rule.sendStrategy === "booleanTree") {
        return;
    }

    if (hasUsableVectorNetwork(nodeJson.vectorNetwork) || childNodes.length === 0) return;

    const svg = await tryExportSvgMarkup(node, "Boolean");
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

export function hasVisibleFill(fills: any) {
    if (!Array.isArray(fills)) return false;
    return fills.some(fill => fill && fill.type && fill.visible !== false && (fill.opacity === undefined || fill.opacity > 0));
}

export function shouldUseSvgFallbackForFilledVector(nodeJson: any) {
    if (!nodeJson || nodeJson.receiveCreateOverride || nodeJson.svgFallback) return false;
    if (nodeJson.sourceType !== "PEN" && nodeJson.sourceType !== "VECTOR") return false;
    if (!hasVisibleFill(nodeJson.geometry && nodeJson.geometry.fills)) return false;

    const vectorNetwork = nodeJson.vectorNetwork;
    if (!vectorNetwork || !Array.isArray(vectorNetwork.segments) || vectorNetwork.segments.length < 2) return false;
    if (Array.isArray(vectorNetwork.regions) && vectorNetwork.regions.length > 0) return false;
    return true;
}

export async function enrichFilledVectorExport(node: SceneNode, nodeJson: any) {
    if (!shouldUseSvgFallbackForFilledVector(nodeJson)) return;

    const svg = await tryExportSvgMarkup(node, "Filled vector");
    if (!svg) return;
    nodeJson.svgMarkup = svg;
    nodeJson.svgFallback = true;
    nodeJson.receiveCreateOverride = "SVG";
    nodeJson.vectorFallback = "svgMissingRegions";
}

export function getRawChildCount(node: any): number | undefined {
    return safeRead(() => {
        const children = node && node.children;
        return children && typeof children.length === "number" ? children.length : undefined;
    }, undefined);
}

export function createNodeComplexitySnapshot(node: any, childNodes?: SceneNode[], nodeJson?: any) {
    const vectorNetwork = nodeJson && nodeJson.vectorNetwork ? nodeJson.vectorNetwork : null;
    const regions = vectorNetwork && Array.isArray(vectorNetwork.regions) ? vectorNetwork.regions : undefined;
    return {
        id: safeRead(() => node.id, "unknown-id"),
        name: safeRead(() => node.name, "Untitled"),
        type: safeRead(() => node.type, "UNKNOWN"),
        sourceType: nodeJson && typeof nodeJson.sourceType === "string" ? nodeJson.sourceType : undefined,
        restoreType: nodeJson && typeof nodeJson.restoreType === "string" ? nodeJson.restoreType : undefined,
        width: safeRead(() => Number(node.width), undefined as any),
        height: safeRead(() => Number(node.height), undefined as any),
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
            loops: regions ? regions.reduce((sum: number, region: any) => sum + (region && Array.isArray(region.loops) ? region.loops.length : 0), 0) : undefined
        } : undefined
    };
}

export function shouldLogStringifyProbe(complexity: any): boolean {
    const vertexCount = complexity.vectorNetwork && complexity.vectorNetwork.vertices || 0;
    const segmentCount = complexity.vectorNetwork && complexity.vectorNetwork.segments || 0;
    const regionCount = complexity.vectorNetwork && complexity.vectorNetwork.regions || 0;
    const childCount = complexity.childCount || complexity.rawChildCount || 0;
    return vertexCount >= STRINGIFY_PROBE_VERTEX_THRESHOLD ||
        segmentCount >= STRINGIFY_PROBE_VERTEX_THRESHOLD ||
        regionCount >= STRINGIFY_PROBE_REGION_THRESHOLD ||
        childCount >= STRINGIFY_PROBE_CHILD_THRESHOLD;
}

export function getNodeDebugLabel(node: any): string {
    const nodeId = safeRead(() => node.id, "");
    const nodeType = safeRead(() => node.type, "");
    if (node && node.id) {
        return `[HostNode: ${safeRead(() => node.name, "Untitled")} (${nodeType}, id=${nodeId})]`;
    }
    return `[JSON-Payload: ${safeRead(() => node.name, "Untitled")} (${nodeType}, id=${nodeId})]`;
}

export function stringifyLayerPayload(payload: any, node: SceneNode, nodeComplexity?: any) {
    try {
        return JSON.stringify(payload);
    } catch (error) {
        const fatalOom = isOutOfMemoryError(error);
        state.logDiagnostic(fatalOom ? "error" : "warn", fatalOom ? "[MasterGo2Figma] Stringify OOM" : "[MasterGo2Figma] Stringify failed, exporting fallback", {
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

export function isRecoverableNodeExportError(error: any): boolean {
    if (isOutOfMemoryError(error)) return false;

    // UI transfer / zip-write failures are tagged with an explicit, stable code
    // (see transferStream.uiTransferError). These are not recoverable per-node.
    if (error && (error as any).code === UI_TRANSFER_ERROR_CODE) return false;

    // Legacy fallback for errors that predate the explicit code tagging.
    let message = "";
    try {
        message = String(error && error.message !== undefined ? error.message : error).toLowerCase();
    } catch (_) {
        message = "";
    }

    if (message.indexOf("ui zip") !== -1 || message.indexOf("timed out waiting for ui zip") !== -1) return false;
    return true;
}

export function markLayerWritten(chunk: any, nodeId: string) {
    if (nodeId) chunk.writtenNodeIds[nodeId] = true;
}

export function summarizeTransfer(transfer: any) {
    return {
        transferId: transfer.transferId,
        filename: transfer.filename,
        fileIndex: transfer.fileIndex,
        postedChunks: transfer.postedChunks,
        streamedBytes: transfer.streamedBytes
    };
}

export async function appendFallbackLayerRecord(
    node: SceneNode,
    page: PageNode,
    parentId: string | null,
    index: number,
    pageIndex: any,
    chunk: any,
    transfer: any
) {
    const nodeId = safeRead(() => node.id, `node-fallback-${pageIndex.layerCount + 1}`);
    const fallbackJson = createFallbackNodeJson(node);
    const layerRecord = {
        id: nodeId,
        pageId: safeRead(() => page.id, ""),
        parentId,
        index,
        name: safeRead(() => node.name, "Untitled (Fallback)"),
        childIds: [] as string[],
        props: fallbackJson
    };
    const nodeComplexity = createNodeComplexitySnapshot(node, [], fallbackJson);
    const recordJson = stringifyLayerPayload(layerRecord, node, nodeComplexity);
    pageIndex.layerCount++;
    state.noteExportLayerRecord();
    await appendLayerRecord(recordJson, pageIndex, chunk, transfer);
    markLayerWritten(chunk, nodeId);
}

export async function collectSingleNodeExport(
    node: SceneNode,
    page: PageNode,
    pageFolder: string,
    parentId: string | null,
    index: number,
    pageIndex: any, // ExportPageIndex
    chunk: any, // LayerChunkAccumulator
    transfer: any, // ExportTransferState
    relation: "root" | "child"
): Promise<{ nodeId: string; shouldExportChildren: boolean; childIds: string[] } | null> {
    state.processedNodes++;
    const nodeDebug = getNodeDebugLabel(node);
    const pageName = safeRead(() => page.name, pageIndex.name);
    let phase = "start";
    const nodeId = safeRead(() => node.id, `node-${pageIndex.layerCount + 1}`);
    const nodeName = safeRead(() => node.name, "Untitled");
    let recordAppended = false;
    let childNodes: SceneNode[] = [];
    let shouldExportChildren = false;

    state.logDebug(`[DFS] Start node: id=${nodeId}, name=${nodeName}, type=${node.type}, page=${pageName}`);

    const setNodeDebug = (nextPhase: string, nodeComplexity?: any) => {
        phase = nextPhase;
        state.logDebug(`  - [DFS] Node ${nodeId} enter phase: ${nextPhase}`);
        state.setExportDebugState({
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
        childNodes = getSafeExportableChildren(node);
        state.logDebug(`  - [DFS] Node ${nodeId} read-children done: childCount=${childNodes.length}`);

        setNodeDebug("analyse");
        let nodeJson: any = analyseNodes(node);
        state.logDebug(`  - [DFS] Node ${nodeId} analyse done`);

        setNodeDebug("enrich-boolean");
        await enrichBooleanOperationExport(node, nodeJson, childNodes);
        state.logDebug(`  - [DFS] Node ${nodeId} enrich-boolean done`);

        setNodeDebug("enrich-vector");
        await enrichFilledVectorExport(node, nodeJson);
        state.logDebug(`  - [DFS] Node ${nodeId} enrich-vector done`);

        setNodeDebug("override-layout");
        overrideExportLayoutFromSourceNode(nodeJson, node);
        state.logDebug(`  - [DFS] Node ${nodeId} override-layout done`);

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
            state.logDiagnostic("log", "[MasterGo2Figma] Stringify probe", {
                page: pageName,
                processedNodes: state.processedNodes,
                totalNodes: state.totalNodes,
                complexity: nodeComplexity
            });
        }

        setNodeDebug("stringify", nodeComplexity);
        let recordJson: any = stringifyLayerPayload(layerRecord, node, nodeComplexity);
        const recordBytes = recordJson.length;
        if (recordBytes >= STRINGIFY_RECORD_WARN_BYTES) {
            state.logDiagnostic("warn", "[MasterGo2Figma] Large layer record", {
                page: pageName,
                node: nodeDebug,
                recordBytes,
                chunkBytes: chunk.bytes,
                chunkRecords: chunk.recordJsons.length,
                complexity: nodeComplexity,
                transfer: summarizeTransfer(transfer)
            });
        }
        state.logDebug(`  - [DFS] Node ${nodeId} stringify done: length=${recordBytes}`);
        layerRecord = null;
        nodeJson = null;
        nodeComplexity = null;
        pageIndex.layerCount++;
        state.noteExportLayerRecord();

        setNodeDebug("append-record");
        await appendLayerRecord(recordJson, pageIndex, chunk, transfer);
        markLayerWritten(chunk, nodeId);
        recordAppended = true;
        state.logDebug(`  - [DFS] Node ${nodeId} append done`);

        if (omittedChildNodeCount) {
            state.processedNodes += omittedChildNodeCount;
        }

        setNodeDebug("progress");
        await state.maybeReportExportProgress(state.processedNodes, state.totalNodes, "正在导出图层...");

        // Clean up references immediately to allow GC
        recordJson = null;
        childNodes = null as any;

        state.logDebug(`[DFS] Complete node: id=${nodeId}`);
        return { nodeId, shouldExportChildren, childIds };
    } catch (error) {
        state.logDebug(`[DFS] Node export caught error: id=${nodeId}, phase=${phase}, error=`, describeError(error));
        const fatalOom = isOutOfMemoryError(error);
        state.logDiagnostic("error", fatalOom ? `[MasterGo2Figma] Fatal node OOM, stopping export: ${nodeId}` : `[MasterGo2Figma] Node export failed: ${nodeId}`, {
            phase,
            error: describeError(error),
            nodeId,
            page: pageName,
            debugState: state.exportDebugState
        });

        if (fatalOom) throw error;

        if (isRecoverableNodeExportError(error)) {
            if (nodeId && chunk.writtenNodeIds[nodeId]) {
                return null;
            }
            try {
                await appendFallbackLayerRecord(node, page, parentId, index, pageIndex, chunk, transfer);
            } catch (fallbackError) {
                state.logDiagnostic("error", "[MasterGo2Figma] Recoverable node fallback failed, skipping node", {
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

export function overrideExportLayoutFromSourceNode(nodeJson: any, node: SceneNode) {
    if (!nodeJson || !nodeJson.layout) return;

    try {
        const layoutTransform = cloneTransform((node as any).relativeTransform);
        nodeJson.layout.relativeTransform = layoutTransform;
        nodeJson.layout.x = layoutTransform[0][2];
        nodeJson.layout.y = layoutTransform[1][2];
        nodeJson.layout.rotation = -safeRead(() => (node as any).rotation, 0) || 0;
        nodeJson.layout.width = safeRead(() => node.width, 0);
        nodeJson.layout.height = safeRead(() => node.height, 0);
    } catch (error) {
        if (isOutOfMemoryError(error)) throw error;
        state.logDiagnostic("warn", "[MasterGo2Figma] Unable to override layout properties for export, using analysed properties", {
            node: getNodeProbe(node),
            error: describeError(error)
        });
    }
}
