import { state } from "../state";
import { safeResize, safeSet } from "../../../shared/utils";
import { ImportLayerRecord } from "../../../shared/types";
import { appendRestoredNode, safeRemove, hasUsableVectorNetwork } from "../nodeCreator";

const BOOLEAN_RESTORE_DEBUG_BUILD = "boolean-debug-2026-06-11-01";

export function shouldRestoreBooleanVectorAsFrame(data: any, layerRecord: ImportLayerRecord): boolean {
    if (!data || data.sourceType !== "BOOLEAN_OPERATION") return false;
    if (data.receiveCreateOverride || data.svgFallback) return false;
    if (data.type !== "VECTOR" && data.restoreType !== "VECTOR") return false;
    if (!layerRecord.childIds || layerRecord.childIds.length === 0) return false;
    return !hasUsableVectorNetwork(data.vectorNetwork);
}

export function shouldRestoreBooleanOperationTree(data: any, layerRecord?: ImportLayerRecord): boolean {
    if (!data) return false;
    const hasBooleanChildren = data.sourceType === "BOOLEAN_OPERATION" &&
        !!layerRecord &&
        Array.isArray(layerRecord.childIds) &&
        layerRecord.childIds.length > 0;
    return data.sourceType === "BOOLEAN_OPERATION" &&
        (hasBooleanChildren ||
            data.type === "BOOLEAN_OPERATION" ||
            data.restoreType === "BOOLEAN_OPERATION" ||
            data.receiveCreateOverride === "BOOLEAN_OPERATION");
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

export function createUntransformedContainerShellProps(data: any): any {
    const props = createBooleanFrameFallbackProps(data);
    delete props.layout;
    delete props.constraints;
    return props;
}

export function createContainerShellFrameProps(data: any): any {
    return hasNonTranslationTransform(data?.layout) ?
        createUntransformedContainerShellProps(data) :
        createBooleanFrameFallbackProps(data);
}

export function createFinalizedContainerProps(data: any, preserveLayout = false): any {
    const props = { ...data };
    if (!preserveLayout) {
        delete props.layout;
        delete props.constraints;
    }
    return props;
}

export function hasReflectionTransform(layout: any): boolean {
    const transform = layout && layout.relativeTransform;
    if (!hasFiniteTransform(transform)) return false;

    return getTransformDeterminant(transform) < -0.0001;
}

export function hasNonTranslationTransform(layout: any): boolean {
    const transform = layout && layout.relativeTransform;
    if (!hasFiniteTransform(transform)) return false;

    return Math.abs(transform[0][0] - 1) > 0.0001 ||
        Math.abs(transform[0][1]) > 0.0001 ||
        Math.abs(transform[1][0]) > 0.0001 ||
        Math.abs(transform[1][1] - 1) > 0.0001;
}

export function getTransformDeterminant(transform: any): number {
    if (!hasFiniteTransform(transform)) return 1;
    return transform[0][0] * transform[1][1] - transform[0][1] * transform[1][0];
}

function hasFiniteTransform(transform: any): boolean {
    return Array.isArray(transform) &&
        Array.isArray(transform[0]) &&
        Array.isArray(transform[1]) &&
        Number.isFinite(transform[0][0]) &&
        Number.isFinite(transform[0][1]) &&
        Number.isFinite(transform[0][2]) &&
        Number.isFinite(transform[1][0]) &&
        Number.isFinite(transform[1][1]) &&
        Number.isFinite(transform[1][2]);
}

// ---- Native component-set restoration ----------------------------------------
// Figma creates component sets by combining component children as variants. Use a
// temporary frame so descendants can be restored normally, then replace that shell
// with the native ComponentSetNode.

export function shouldRestoreComponentSetNode(data: any): boolean {
    if (!data) return false;
    if (data.receiveCreateOverride === "SVG" || data.svgFallback) return false;
    return data.sourceType === "COMPONENT_SET" &&
        (data.type === "COMPONENT_SET" || data.restoreType === "COMPONENT_SET" || data.receiveCreateOverride === "COMPONENT_SET");
}

export async function restoreComponentSetNode(
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
    const childIds = nodeProps.omitChildrenOnRestore ? [] : (layerRecord.childIds || []);
    const shellProps = createBooleanFrameFallbackProps(nodeProps);
    let appended = false;

    try {
        if (!appendRestoredNode(parent, shell)) return 0;
        appended = true;
        await applyPropertiesCallback(shell as any, shellProps);
    } catch (error) {
        console.warn("Unable to create component set restore shell:", nodeProps?.name || layerRecord.name, error);
        if (appended) safeRemove(shell);
        return 0;
    }

    let restoredCount = 1;
    await maybeReportProgressCallback(restoredBefore + restoredCount, totalNodes, "正在还原：" + (nodeProps.name || layerRecord.name));

    for (const childId of childIds) {
        restoredCount += await restoreNodeCallback(childId, shell, layers, restoredBefore + restoredCount, totalNodes);
    }

    await finalizeComponentSetShell(shell, nodeProps, applyPropertiesCallback);
    return restoredCount;
}

export async function finalizeComponentSetShell(
    shell: FrameNode,
    data: any,
    applyPropertiesCallback: (node: any, data: any) => Promise<void>
) {
    const parent = shell.parent;
    if (!parent || !("insertChild" in parent)) {
        safeSet(shell, "name", data.name);
        return;
    }

    const components = shell.children.filter((child): child is ComponentNode => child.type === "COMPONENT");
    if (components.length < 1) {
        console.warn("Unable to create component set because it has no component children:", data?.name || data?.id || "Untitled");
        safeSet(shell, "name", data.name);
        return;
    }

    try {
        const parentIndex = parent.children.indexOf(shell);
        for (let index = 0; index < components.length; index++) {
            const component = components[index];
            safeSet(component, "name", createFigmaVariantName(component.name, index));
        }

        const componentSet = figma.combineAsVariants(
            components,
            parent as BaseNode & ChildrenMixin,
            parentIndex >= 0 ? parentIndex : parent.children.length
        );
        safeRemove(shell);
        await applyPropertiesCallback(componentSet as any, data);
        restoreComponentSetChildLayouts(componentSet);
    } catch (error) {
        console.warn("Unable to create native component set, keeping frame fallback:", data?.name || data?.id || "Untitled", error);
        safeSet(shell, "name", data.name);
    }
}

export function createFigmaVariantName(name: string, index: number): string {
    const fallback = `Variant ${index + 1}`;
    if (!name) return `Property 1=${fallback}`;

    const bracketed = name.match(/^(.+?)\[[^\]]+\]=(.+)$/);
    if (bracketed) {
        return `${sanitizeVariantPropertyName(bracketed[1])}=${sanitizeVariantValue(bracketed[2], fallback)}`;
    }

    const equalsIndex = name.indexOf("=");
    if (equalsIndex > 0 && equalsIndex < name.length - 1) {
        return `${sanitizeVariantPropertyName(name.slice(0, equalsIndex))}=${sanitizeVariantValue(name.slice(equalsIndex + 1), fallback)}`;
    }

    return `Property 1=${sanitizeVariantValue(name, fallback)}`;
}

function sanitizeVariantPropertyName(value: string): string {
    const trimmed = String(value || "").trim();
    return trimmed || "Property 1";
}

function sanitizeVariantValue(value: string, fallback: string): string {
    const trimmed = String(value || "").trim();
    return trimmed || fallback;
}

function restoreComponentSetChildLayouts(componentSet: ComponentSetNode) {
    for (const child of componentSet.children) {
        if (child.type !== "COMPONENT") continue;

        const layout = state.restoredLayoutByNodeId[child.id];
        if (layout) {
            if (layout.width !== undefined && layout.height !== undefined) {
                safeResize(child, layout.width, layout.height);
            }
            if (hasFiniteRelativeTransform(layout)) {
                safeSet(child, "relativeTransform", layout.relativeTransform);
            } else {
                if (layout.x !== undefined) safeSet(child, "x", layout.x);
                if (layout.y !== undefined) safeSet(child, "y", layout.y);
            }
        }
    }
}

function hasFiniteRelativeTransform(layout: any): boolean {
    return Array.isArray(layout?.relativeTransform) &&
        Array.isArray(layout.relativeTransform[0]) &&
        Array.isArray(layout.relativeTransform[1]) &&
        Number.isFinite(layout.relativeTransform[0][0]) &&
        Number.isFinite(layout.relativeTransform[0][1]) &&
        Number.isFinite(layout.relativeTransform[0][2]) &&
        Number.isFinite(layout.relativeTransform[1][0]) &&
        Number.isFinite(layout.relativeTransform[1][1]) &&
        Number.isFinite(layout.relativeTransform[1][2]);
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
    const childIds = nodeProps.omitChildrenOnRestore ? [] : (layerRecord.childIds || []);
    const shellProps = createContainerShellFrameProps(nodeProps);
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
        await applyPropertiesCallback(group as any, createFinalizedContainerProps(data, hasNonTranslationTransform(data?.layout)));
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
    logBooleanRestoreDebug("restore-start", {
        build: BOOLEAN_RESTORE_DEBUG_BUILD,
        sourceId: nodeProps?.id,
        name: nodeProps?.name || layerRecord.name,
        sourceType: nodeProps?.sourceType,
        type: nodeProps?.type,
        restoreType: nodeProps?.restoreType,
        operation: nodeProps?.booleanOperation,
        childIds: layerRecord.childIds || [],
        omitChildrenOnRestore: !!nodeProps?.omitChildrenOnRestore
    });

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

    logBooleanRestoreDebug("children-restored", {
        build: BOOLEAN_RESTORE_DEBUG_BUILD,
        sourceId: nodeProps?.id,
        name: nodeProps?.name || layerRecord.name,
        shell: summarizeSceneNode(shell),
        children: [...shell.children].map(summarizeSceneNode)
    });

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
): Promise<SceneNode | null> {
    const parent = shell.parent;
    if (!parent || !("insertChild" in parent)) return null;

    const children = [...shell.children] as SceneNode[];
    logBooleanRestoreDebug("combine-start", {
        build: BOOLEAN_RESTORE_DEBUG_BUILD,
        sourceId: data?.id,
        name: data?.name,
        operation: data?.booleanOperation,
        childCount: children.length,
        children: children.map(summarizeSceneNode)
    });

    if (children.length === 1) {
        return await promoteSingleBooleanChild(shell, children[0], data);
    }
    if (children.length < 1) {
        console.warn("Unable to restore boolean operation because it has no children:", data?.name || data?.id || "Untitled");
        return null;
    }

    const operation = normalizeBooleanOperation(data.booleanOperation);
    if (!operation) {
        console.warn("Unsupported boolean operation:", data?.booleanOperation, data?.name || data?.id || "Untitled");
        return null;
    }
    try {
        const booleanChildren = flattenStrokeOnlyBooleanChildren(children, shell);
        logBooleanRestoreDebug("after-flatten", {
            build: BOOLEAN_RESTORE_DEBUG_BUILD,
            sourceId: data?.id,
            name: data?.name,
            operation,
            sourceOperation: data?.booleanOperation,
            children: booleanChildren.map(summarizeSceneNode)
        });
        const combined = createBooleanContainerNode(operation, booleanChildren, shell, parent);
        await applyPropertiesCallback(combined as any, data);
        logBooleanRestoreDebug("combine-complete", {
            build: BOOLEAN_RESTORE_DEBUG_BUILD,
            sourceId: data?.id,
            name: data?.name,
            combined: summarizeSceneNode(combined),
            children: [...combined.children].map(summarizeSceneNode)
        });
        safeRemove(shell);
        return combined;
    } catch (error) {
        console.warn("Unable to combine boolean operation, falling back:", data?.name || data?.id || "Untitled", error);
        return null;
    }
}

export function flattenStrokeOnlyBooleanChildren(children: SceneNode[], parent: BaseNode & ChildrenMixin): SceneNode[] {
    const result: SceneNode[] = [];

    for (const child of children) {
        if (!shouldFlattenBooleanChild(child)) {
            logBooleanRestoreDebug("flatten-skip", {
                build: BOOLEAN_RESTORE_DEBUG_BUILD,
                child: summarizeSceneNode(child),
                reason: describeFlattenSkipReason(child)
            });
            result.push(child);
            continue;
        }

        try {
            const index = parent.children.indexOf(child);
            const beforeSummary = summarizeSceneNode(child);
            logBooleanRestoreDebug("flatten-before", {
                build: BOOLEAN_RESTORE_DEBUG_BUILD,
                child: beforeSummary,
                parentChildIndex: index
            });
            const flattened = figma.flatten([child], parent, index >= 0 ? index : parent.children.length);
            logBooleanRestoreDebug("flatten-after", {
                build: BOOLEAN_RESTORE_DEBUG_BUILD,
                before: beforeSummary,
                flattened: summarizeSceneNode(flattened)
            });
            result.push(flattened);
        } catch (error) {
            console.warn("Unable to flatten stroked boolean child, keeping original:", child.name, error);
            result.push(child);
        }
    }

    return result;
}

export function shouldFlattenBooleanChild(node: SceneNode): boolean {
    if (!isStrokeOnlyWithoutVisibleFill(node)) return false;
    return hasClosedVectorRegion(node);
}

function hasClosedVectorRegion(node: SceneNode): boolean {
    const vectorNetwork = (node as any).vectorNetwork;
    return !!vectorNetwork && Array.isArray(vectorNetwork.regions) && vectorNetwork.regions.length > 0;
}

function isStrokeOnlyWithoutVisibleFill(node: SceneNode): boolean {
    if (!("strokes" in node)) return false;
    const strokes = (node as any).strokes;
    if (!Array.isArray(strokes) || strokes.length === 0) return false;
    if (!("fills" in node)) return true;
    const fills = (node as any).fills;
    return !Array.isArray(fills) || fills.length === 0 || fills.every((fill: any) => !fill || fill.visible === false);
}

function describeFlattenSkipReason(node: SceneNode): string {
    if (!("strokes" in node)) return "node-has-no-strokes-property";
    const strokes = (node as any).strokes;
    if (!Array.isArray(strokes) || strokes.length === 0) return "node-has-no-strokes";
    if (!hasClosedVectorRegion(node)) return "node-has-no-closed-region";
    if (!("fills" in node)) return "node-has-strokes-and-no-fills-property";
    const fills = (node as any).fills;
    if (!Array.isArray(fills) || fills.length === 0) return "node-has-strokes-and-no-fills";
    if (fills.every((fill: any) => !fill || fill.visible === false)) return "node-has-only-hidden-fills";
    return "node-has-visible-fill";
}

function summarizeSceneNode(node: SceneNode): any {
    const nodeAny = node as any;
    const fills = "fills" in nodeAny && Array.isArray(nodeAny.fills) ? nodeAny.fills : [];
    const strokes = "strokes" in nodeAny && Array.isArray(nodeAny.strokes) ? nodeAny.strokes : [];
    const vectorNetwork = nodeAny.vectorNetwork;

    return {
        id: node.id,
        name: node.name,
        type: node.type,
        x: "x" in nodeAny ? nodeAny.x : undefined,
        y: "y" in nodeAny ? nodeAny.y : undefined,
        width: "width" in nodeAny ? nodeAny.width : undefined,
        height: "height" in nodeAny ? nodeAny.height : undefined,
        relativeTransform: nodeAny.relativeTransform,
        booleanOperation: nodeAny.booleanOperation,
        fills: fills.map(summarizePaint),
        strokes: strokes.map(summarizePaint),
        strokeWeight: nodeAny.strokeWeight,
        vectorNetwork: vectorNetwork ? {
            vertices: Array.isArray(vectorNetwork.vertices) ? vectorNetwork.vertices.length : undefined,
            segments: Array.isArray(vectorNetwork.segments) ? vectorNetwork.segments.length : undefined,
            regions: Array.isArray(vectorNetwork.regions) ? vectorNetwork.regions.length : undefined
        } : undefined,
        children: "children" in nodeAny ? nodeAny.children.length : undefined
    };
}

function summarizePaint(paint: any): any {
    if (!paint || typeof paint !== "object") return paint;
    return {
        type: paint.type,
        visible: paint.visible,
        opacity: paint.opacity,
        blendMode: paint.blendMode
    };
}

function logBooleanRestoreDebug(stage: string, payload: any) {
    console.log(`[MasterGo2Figma][BooleanRestore][${stage}]`, payload);
}

export function createBooleanContainerNode(
    operation: "UNION" | "SUBTRACT" | "INTERSECT" | "EXCLUDE",
    children: SceneNode[],
    shell: FrameNode,
    parent: BaseNode & ChildrenMixin
): BooleanOperationNode {
    const parentIndex = parent.children.indexOf(shell);
    const operationNode = figma.createBooleanOperation();
    safeSet(operationNode, "booleanOperation", operation);
    (parent as any).insertChild(parentIndex >= 0 ? parentIndex : parent.children.length, operationNode);

    for (const child of children) {
        operationNode.appendChild(child);
    }

    return operationNode;
}

export async function promoteSingleBooleanChild(
    shell: FrameNode,
    child: SceneNode,
    data: any
): Promise<SceneNode | null> {
    const parent = shell.parent;
    if (!parent || !("insertChild" in parent)) return null;

    try {
        const parentIndex = parent.children.indexOf(shell);
        const transform = composeSingleBooleanChildTransform(shell, child, data);
        (parent as any).insertChild(parentIndex >= 0 ? parentIndex : parent.children.length, child);
        if (transform) safeSet(child, "relativeTransform", transform);
        safeSet(child, "name", data?.name || child.name);
        safeRemove(shell);
        return child;
    } catch (error) {
        console.warn("Unable to promote single-child boolean operation:", data?.name || data?.id || "Untitled", error);
        return null;
    }
}

export function composeSingleBooleanChildTransform(shell: FrameNode, child: SceneNode, data: any): Transform | null {
    const parentTransform = data?.layout?.relativeTransform || (shell as any).relativeTransform;
    const childTransform = (child as any).relativeTransform;
    if (!hasFiniteTransform(parentTransform) || !hasFiniteTransform(childTransform)) return null;
    return multiplyTransforms(parentTransform, childTransform);
}

type Transform = [[number, number, number], [number, number, number]];

export function multiplyTransforms(parent: Transform, child: Transform): Transform {
    return [
        [
            parent[0][0] * child[0][0] + parent[0][1] * child[1][0],
            parent[0][0] * child[0][1] + parent[0][1] * child[1][1],
            parent[0][0] * child[0][2] + parent[0][1] * child[1][2] + parent[0][2]
        ],
        [
            parent[1][0] * child[0][0] + parent[1][1] * child[1][0],
            parent[1][0] * child[0][1] + parent[1][1] * child[1][1],
            parent[1][0] * child[0][2] + parent[1][1] * child[1][2] + parent[1][2]
        ]
    ];
}

export async function restoreBooleanFallbackFromShell(
    shell: FrameNode,
    data: any,
    applyPropertiesCallback: (node: any, data: any) => Promise<void>
) {
    const parent = shell.parent;
    if (!parent || !("insertChild" in parent)) return;

    state.booleanFallbackCount++;
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
    const fallbackNode = figma.createFrame();
    const fallbackProps = createBooleanFrameFallbackProps(data);

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
