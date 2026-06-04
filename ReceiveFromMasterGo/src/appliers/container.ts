import { state } from "../state";
import { safeSet } from "../../../shared/utils";
import { ImportLayerRecord } from "../../../shared/types";
import { appendRestoredNode, safeRemove, hasUsableVectorNetwork } from "../nodeCreator";

export function shouldRestoreBooleanVectorAsFrame(data: any, layerRecord: ImportLayerRecord): boolean {
    if (!data || data.sourceType !== "BOOLEAN_OPERATION") return false;
    if (data.receiveCreateOverride || data.svgFallback) return false;
    if (data.type !== "VECTOR" && data.restoreType !== "VECTOR") return false;
    if (!layerRecord.childIds || layerRecord.childIds.length === 0) return false;
    return !hasUsableVectorNetwork(data.vectorNetwork);
}

export function shouldRestoreBooleanOperationTree(data: any): boolean {
    if (!data) return false;
    return data.sourceType === "BOOLEAN_OPERATION" &&
        (data.type === "BOOLEAN_OPERATION" || data.restoreType === "BOOLEAN_OPERATION" || data.receiveCreateOverride === "BOOLEAN_OPERATION");
}

export function normalizeBooleanOperation(value: any): "UNION" | "SUBTRACT" | "INTERSECT" | "EXCLUDE" | null {
    if (value === "UNION" || value === "SUBTRACT" || value === "INTERSECT" || value === "EXCLUDE") {
        return value;
    }
    return null;
}

export function createBooleanOperationNode(
    operation: "UNION" | "SUBTRACT" | "INTERSECT" | "EXCLUDE",
    children: SceneNode[],
    parent: BaseNode & ChildrenMixin,
    index: number
): BooleanOperationNode {
    if (operation === "UNION") return figma.union(children, parent, index);
    if (operation === "SUBTRACT") return figma.subtract(children, parent, index);
    if (operation === "INTERSECT") return figma.intersect(children, parent, index);
    return figma.exclude(children, parent, index);
}

export function createSvgFallbackNode(data: any): SceneNode | null {
    if (typeof data?.svgMarkup !== "string" || !data.svgMarkup.trim()) return null;
    try {
        return figma.createNodeFromSvg(data.svgMarkup);
    } catch (error) {
        console.warn("Unable to create boolean SVG fallback:", data?.name || data?.id || "Untitled", error);
        return null;
    }
}

export function createSvgFallbackProps(data: any): any {
    return {
        ...data,
        svgFallback: true,
        receiveCreateOverride: "SVG"
    };
}

export function clearGeometryPaint(geometry: any): any {
    if (!geometry || typeof geometry !== "object") return geometry;
    return {
        ...geometry,
        fills: [],
        strokes: [],
        strokeWeight: 0,
        strokeTopWeight: undefined,
        strokeBottomWeight: undefined,
        strokeLeftWeight: undefined,
        strokeRightWeight: undefined
    };
}

export function createBooleanFrameFallbackProps(data: any): any {
    return {
        ...data,
        type: "FRAME",
        restoreType: "FRAME",
        receiveCreateOverride: "FRAME",
        booleanFallback: "frameContainer",
        clipsContent: false,
        geometry: clearGeometryPaint(data.geometry)
    };
}

// ---- Native group restoration -------------------------------------------------
// MasterGo GROUP layers used to be restored as a plain FRAME placeholder. Figma
// has a real GroupNode, so we restore one by mirroring the boolean-tree shell
// pattern: build a temporary frame carrying the group's transform so children
// land in the right place, recurse the children into it, then figma.group() the
// children and drop the shell. Falls back to keeping the frame if grouping
// fails or there are no children.

export function shouldRestoreGroupNode(data: any): boolean {
    if (!data) return false;
    if (data.receiveCreateOverride === "SVG" || data.svgFallback) return false;
    return data.sourceType === "GROUP" &&
        (data.type === "GROUP" || data.restoreType === "GROUP" || data.receiveCreateOverride === "GROUP");
}

export function createGroupShellFrameProps(data: any): any {
    return {
        ...data,
        type: "FRAME",
        restoreType: "FRAME",
        receiveCreateOverride: "FRAME",
        clipsContent: false,
        geometry: clearGeometryPaint(data.geometry)
    };
}

export async function restoreGroupNode(
    nodeProps: any,
    parent: PageNode | SceneNode,
    layerRecord: ImportLayerRecord,
    layers: { [id: string]: ImportLayerRecord },
    restoredBefore: number,
    totalNodes: number,
    restoreNodeCallback: (nodeId: string, parent: PageNode | SceneNode, layers: { [id: string]: ImportLayerRecord }, restoredBefore: number, totalNodes: number) => Promise<number>,
    applyPropertiesCallback: (node: any, data: any) => Promise<void>,
    maybeReportProgressCallback: (current: number, total: number, label: string) => Promise<void>
): Promise<number> {
    const shell = figma.createFrame();
    const shellProps = createGroupShellFrameProps(nodeProps);
    let appended = false;

    try {
        if (!appendRestoredNode(parent, shell)) return 0;
        appended = true;
        await applyPropertiesCallback(shell as any, shellProps);
    } catch (error) {
        console.warn("Unable to create group restore shell:", nodeProps?.name || layerRecord.name, error);
        if (appended) safeRemove(shell);
        return 0;
    }

    let restoredCount = 1;
    await maybeReportProgressCallback(restoredBefore + restoredCount, totalNodes, "正在还原：" + (nodeProps.name || layerRecord.name));

    const childIds = nodeProps.omitChildrenOnRestore ? [] : (layerRecord.childIds || []);
    for (const childId of childIds) {
        restoredCount += await restoreNodeCallback(childId, shell, layers, restoredBefore + restoredCount, totalNodes);
    }

    await finalizeGroupShell(shell, nodeProps, applyPropertiesCallback);
    return restoredCount;
}

export async function finalizeGroupShell(
    shell: FrameNode,
    data: any,
    applyPropertiesCallback: (node: any, data: any) => Promise<void>
) {
    const parent = shell.parent;
    const children = [...shell.children] as SceneNode[];

    // No children, or nowhere to group into: keep the frame as a placeholder.
    if (!parent || !("insertChild" in parent) || children.length < 1) {
        safeSet(shell, "name", data.name);
        return;
    }

    try {
        const parentIndex = parent.children.indexOf(shell);
        const group = figma.group(
            children,
            parent as BaseNode & ChildrenMixin,
            parentIndex >= 0 ? parentIndex : parent.children.length
        );
        safeRemove(shell);
        await applyPropertiesCallback(group as any, data);
    } catch (error) {
        console.warn("Unable to create native group, keeping frame fallback:", data?.name || data?.id || "Untitled", error);
        safeSet(shell, "name", data.name);
    }
}

export async function restoreBooleanOperationTree(
    nodeProps: any,
    parent: PageNode | SceneNode,
    layerRecord: ImportLayerRecord,
    layers: { [id: string]: ImportLayerRecord },
    restoredBefore: number,
    totalNodes: number,
    restoreNodeCallback: (nodeId: string, parent: PageNode | SceneNode, layers: { [id: string]: ImportLayerRecord }, restoredBefore: number, totalNodes: number) => Promise<number>,
    applyPropertiesCallback: (node: any, data: any) => Promise<void>,
    maybeReportProgressCallback: (current: number, total: number, label: string) => Promise<void>
): Promise<number> {
    const shell = figma.createFrame();
    const shellProps = createBooleanFrameFallbackProps(nodeProps);
    let appended = false;

    try {
        if (!appendRestoredNode(parent, shell)) return 0;
        appended = true;
        await applyPropertiesCallback(shell as any, shellProps);
    } catch (error) {
        console.warn("Unable to create boolean restore shell:", nodeProps?.name || layerRecord.name, error);
        if (appended) safeRemove(shell);
        return await restoreBooleanFallbackNode(nodeProps, parent, layerRecord, restoredBefore, totalNodes, applyPropertiesCallback, maybeReportProgressCallback);
    }

    let restoredCount = 1;
    const currentCount = restoredBefore + restoredCount;
    await maybeReportProgressCallback(currentCount, totalNodes, "正在还原：" + (nodeProps.name || layerRecord.name));

    const childIds = nodeProps.omitChildrenOnRestore ? [] : (layerRecord.childIds || []);
    for (const childId of childIds) {
        restoredCount += await restoreNodeCallback(childId, shell, layers, restoredBefore + restoredCount, totalNodes);
    }

    const combined = await combineBooleanShell(shell, nodeProps, applyPropertiesCallback);
    if (!combined) {
        await restoreBooleanFallbackFromShell(shell, nodeProps, applyPropertiesCallback);
    }

    return restoredCount;
}

export async function combineBooleanShell(
    shell: FrameNode,
    data: any,
    applyPropertiesCallback: (node: any, data: any) => Promise<void>
): Promise<BooleanOperationNode | null> {
    const parent = shell.parent;
    if (!parent || !("insertChild" in parent)) return null;

    const children = [...shell.children] as SceneNode[];
    if (children.length < 2) {
        console.warn("Unable to restore boolean operation because it has fewer than two children:", data?.name || data?.id || "Untitled");
        return null;
    }

    const operation = normalizeBooleanOperation(data.booleanOperation);
    if (!operation) {
        console.warn("Unsupported boolean operation:", data?.booleanOperation, data?.name || data?.id || "Untitled");
        return null;
    }

    try {
        const combined = createBooleanOperationNode(operation, children, shell, 0);
        const parentIndex = parent.children.indexOf(shell);
        (parent as any).insertChild(parentIndex >= 0 ? parentIndex : parent.children.length, combined);
        await applyPropertiesCallback(combined as any, data);
        safeRemove(shell);
        return combined;
    } catch (error) {
        console.warn("Unable to combine boolean operation, falling back:", data?.name || data?.id || "Untitled", error);
        return null;
    }
}

export async function restoreBooleanFallbackFromShell(
    shell: FrameNode,
    data: any,
    applyPropertiesCallback: (node: any, data: any) => Promise<void>
) {
    const parent = shell.parent;
    if (!parent || !("insertChild" in parent)) return;

    state.booleanFallbackCount++;
    const svgNode = createSvgFallbackNode(data);
    if (svgNode) {
        const index = parent.children.indexOf(shell);
        try {
            (parent as any).insertChild(index >= 0 ? index : parent.children.length, svgNode);
            await applyPropertiesCallback(svgNode as any, createSvgFallbackProps(data));
            safeRemove(shell);
            return;
        } catch (error) {
            console.warn("Unable to insert boolean SVG fallback:", data?.name || data?.id || "Untitled", error);
            safeRemove(svgNode);
        }
    }

    await applyPropertiesCallback(shell as any, createBooleanFrameFallbackProps(data));
}

export async function restoreBooleanFallbackNode(
    data: any,
    parent: PageNode | SceneNode,
    layerRecord: ImportLayerRecord,
    restoredBefore: number,
    totalNodes: number,
    applyPropertiesCallback: (node: any, data: any) => Promise<void>,
    maybeReportProgressCallback: (current: number, total: number, label: string) => Promise<void>
): Promise<number> {
    state.booleanFallbackCount++;
    const svgNode = createSvgFallbackNode(data);
    const fallbackNode = svgNode || figma.createFrame();
    const fallbackProps = svgNode ? createSvgFallbackProps(data) : createBooleanFrameFallbackProps(data);

    try {
        if (!appendRestoredNode(parent, fallbackNode)) return 0;
        await applyPropertiesCallback(fallbackNode as any, fallbackProps);
    } catch (error) {
        console.warn("Unable to restore boolean fallback:", data?.name || layerRecord.name, error);
        safeRemove(fallbackNode);
        return 0;
    }

    const currentCount = restoredBefore + 1;
    await maybeReportProgressCallback(currentCount, totalNodes, "正在还原：" + (data.name || layerRecord.name));

    return 1;
}
