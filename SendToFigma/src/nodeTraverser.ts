import { state } from "./state";
import { safeRead, isOutOfMemoryError, describeError } from "../../shared/utils";
import { getNodeProbe } from "./serializers/universal";
import { collectSingleNodeExport } from "./nodeSerializer";

export interface StackItem {
    nodeId: string;
    parentId: string | null;
    index: number;
    relation: "root" | "child";
}

const INTERNAL_PROPS_PREFIX = "[PROPS]";
const SIBLING_PROPS_PREFIX = "[PROPS_SIBLING]";

export function isGeneratedCarrierName(name: string): boolean {
    return name.startsWith(INTERNAL_PROPS_PREFIX) || name.startsWith(SIBLING_PROPS_PREFIX);
}

export function getExportableChildren(node: any): SceneNode[] {
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
                state.logDiagnostic("error", "[MasterGo2Figma] Child access OOM", {
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

export function getSafeExportableChildren(node: any): SceneNode[] {
    try {
        return getExportableChildren(node);
    } catch (error) {
        if (isOutOfMemoryError(error)) throw error;
        state.logDiagnostic("warn", "[MasterGo2Figma] Unable to read children for export", {
            node: getNodeProbe(node),
            error: describeError(error)
        });
        return [];
    }
}

export async function collectSubtreeIterative(
    rootNode: SceneNode,
    page: PageNode,
    pageFolder: string,
    parentId: string | null,
    rootIndex: number,
    pageIndexRecord: any, // ExportPageIndex
    chunk: any, // LayerChunkAccumulator
    transfer: any, // ExportTransferState
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
            const node = mg.getNodeById(nodeId) as SceneNode | null;
            if (!node) {
                state.logDiagnostic("warn", `[MasterGo2Figma] DFS node not found by ID: ${nodeId}`, {
                    nodeId,
                    debugState: state.exportDebugState
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

            state.logDiagnostic("error", `[MasterGo2Figma] Iterative DFS node traversal failed: ${nodeId}`, {
                error: describeError(error),
                nodeId,
                debugState: state.exportDebugState
            });
        }
    }
}
