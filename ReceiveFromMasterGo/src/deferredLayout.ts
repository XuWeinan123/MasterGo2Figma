import { state } from "./state";
import { safeSet, safeResize, isSceneNode, yieldToEventLoop } from "../../shared/utils";

const INTERNAL_PROPS_PREFIX = "[PROPS]";
const SIBLING_PROPS_PREFIX = "[PROPS_SIBLING]";
const POSTPROCESS_BATCH_SIZE = 500;
const POSTPROCESS_YIELD_INTERVAL_MS = 50;

type PostprocessProgressCallback = (done: number, total: number, label: string) => Promise<void> | void;

export function deferLayoutRestore(node: any, layout: any, isGroup: boolean) {
    if (!node || !layout || !isSceneNode(node)) return;
    state.deferredLayoutRestores.push({ node, layout, isGroup });
    if (state.activeRestoreStats) {
        state.activeRestoreStats.deferredLayoutNodeCount++;
    }
}

export async function applyDeferredLayoutRestores(progress?: PostprocessProgressCallback) {
    if (state.deferredLayoutRestores.length === 0) return;

    const records = state.deferredLayoutRestores;
    state.deferredLayoutRestores = [];
    const total = Math.max(1, records.length * 3);
    let done = 0;
    let lastYieldAt = Date.now();

    for (const record of records) {
        applyDeferredNodeAutoLayout(record);
        done++;
        lastYieldAt = await maybeYieldPostprocess(done, total, "正在应用自动布局...", lastYieldAt, progress);
    }
    for (const record of records) {
        applyDeferredParentAutoLayout(record);
        done++;
        lastYieldAt = await maybeYieldPostprocess(done, total, "正在恢复父级自动布局...", lastYieldAt, progress);
    }
    for (const record of records) {
        finalizeDeferredAutoLayout(record);
        done++;
        lastYieldAt = await maybeYieldPostprocess(done, total, "正在完成自动布局...", lastYieldAt, progress);
    }
}

function isRemovedNode(node: any): boolean {
    return !node || !!node.removed;
}

export function normalizeLayoutMode(value: any): string {
    if (value === "ROW") return "HORIZONTAL";
    if (value === "COLUMN") return "VERTICAL";
    return value;
}

export function normalizeAxisAlign(value: any): string {
    if (value === "START" || value === "FLEX_START") return "MIN";
    if (value === "END" || value === "FLEX_END") return "MAX";
    if (value === "SPACING_BETWEEN") return "SPACE_BETWEEN";
    return value;
}

export function normalizeAxisSizingMode(value: any): string {
    if (value === "HUG") return "AUTO";
    if (value === "FILL") return "FIXED";
    return value;
}

export function normalizeLayoutAlign(value: any): string {
    if (value === "STRETCH" || value === "INHERIT") return value;
    return normalizeAxisAlign(value);
}

function applyDeferredNodeAutoLayout(record: { node: SceneNode; layout: any; isGroup: boolean }) {
    const { node, layout, isGroup } = record;
    if (isRemovedNode(node) || isGroup || !("layoutMode" in node)) return;

    let applied = false;
    if (layout.layoutMode) {
        // Explicitly type parameter or read as string to avoid TS literal inference error
        safeSet(node, "layoutMode", normalizeLayoutMode(layout.layoutMode));
        applied = true;
    }

    if (hasAutoLayout(node)) {
        if (layout.primaryAxisSizingMode) {
            safeSet(node, "primaryAxisSizingMode", normalizeAxisSizingMode(layout.primaryAxisSizingMode));
            applied = true;
        }
        if (layout.counterAxisSizingMode) {
            safeSet(node, "counterAxisSizingMode", normalizeAxisSizingMode(layout.counterAxisSizingMode));
            applied = true;
        }
        if (layout.itemSpacing !== undefined) {
            safeSet(node, "itemSpacing", layout.itemSpacing);
            applied = true;
        }
        if (layout.paddingLeft !== undefined) {
            safeSet(node, "paddingLeft", layout.paddingLeft);
            applied = true;
        }
        if (layout.paddingRight !== undefined) {
            safeSet(node, "paddingRight", layout.paddingRight);
            applied = true;
        }
        if (layout.paddingTop !== undefined) {
            safeSet(node, "paddingTop", layout.paddingTop);
            applied = true;
        }
        if (layout.paddingBottom !== undefined) {
            safeSet(node, "paddingBottom", layout.paddingBottom);
            applied = true;
        }
        if (layout.primaryAxisAlignItems) {
            safeSet(node, "primaryAxisAlignItems", normalizeAxisAlign(layout.primaryAxisAlignItems));
            applied = true;
        }
        if (layout.counterAxisAlignItems) {
            safeSet(node, "counterAxisAlignItems", normalizeAxisAlign(layout.counterAxisAlignItems));
            applied = true;
        }
        if (layout.counterAxisAlignContent) {
            safeSet(node, "counterAxisAlignContent", layout.counterAxisAlignContent);
            applied = true;
        }
        if (layout.itemReverseZIndex !== undefined) {
            safeSet(node, "itemReverseZIndex", layout.itemReverseZIndex);
            applied = true;
        }
        if (layout.strokesIncludedInLayout !== undefined) {
            safeSet(node, "strokesIncludedInLayout", layout.strokesIncludedInLayout);
            applied = true;
        }
    }

    if (applied && state.activeRestoreStats) {
        state.activeRestoreStats.deferredLayoutAppliedCount++;
    }
}

function applyDeferredParentAutoLayout(record: { node: SceneNode; layout: any; isGroup: boolean }) {
    const { node, layout } = record;
    if (isRemovedNode(node) || !hasAutoLayoutParent(node)) return;

    let applied = false;
    if (layout.layoutPositioning) {
        safeSet(node, "layoutPositioning", layout.layoutPositioning);
        applied = true;
    }
    if (layout.layoutAlign) {
        safeSet(node, "layoutAlign", normalizeLayoutAlign(layout.layoutAlign));
        applied = true;
    }
    if (layout.layoutGrow !== undefined) {
        safeSet(node, "layoutGrow", layout.layoutGrow);
        applied = true;
    }
    const hasRelativeTransform = hasFiniteRelativeTransform(layout);
    if (hasRelativeTransform) {
        safeSet(node, "relativeTransform", layout.relativeTransform);
        applied = true;
    } else if (layout.x !== undefined) {
        safeSet(node, "x", layout.x);
        applied = true;
    }
    if (!hasRelativeTransform && layout.y !== undefined) {
        safeSet(node, "y", layout.y);
        applied = true;
    }

    if (applied && state.activeRestoreStats) {
        state.activeRestoreStats.deferredLayoutAppliedCount++;
    }
}

function finalizeDeferredAutoLayout(record: { node: SceneNode; layout: any; isGroup: boolean }) {
    const { node, isGroup } = record;
    if (isRemovedNode(node) || isGroup || !hasAutoLayout(node)) return;
    const layout = normalizeDeferredLayoutForNativeGroupParent(node, record.layout);
    if (layout.width === undefined || layout.height === undefined || !shouldRestoreFixedSize(node, layout)) return;

    safeResize(node, layout.width, layout.height);
    if (hasFiniteRelativeTransform(layout)) {
        safeSet(node, "relativeTransform", layout.relativeTransform);
    } else {
        if (layout.x !== undefined) safeSet(node, "x", layout.x);
        if (layout.y !== undefined) safeSet(node, "y", layout.y);
    }
}

function normalizeDeferredLayoutForNativeGroupParent(node: SceneNode, layout: any): any {
    const parent = node.parent as any;
    if (!parent || parent.type !== "GROUP") return layout;

    const offset = state.nativeGroupOffsetByNodeId[parent.id];
    if (!offset || (!offset.x && !offset.y)) return layout;

    const normalized: any = { ...layout };
    if (layout.x !== undefined) normalized.x = (layout.x || 0) + offset.x;
    if (layout.y !== undefined) normalized.y = (layout.y || 0) + offset.y;

    if (hasFiniteRelativeTransform(layout)) {
        normalized.relativeTransform = [
            [...layout.relativeTransform[0]],
            [...layout.relativeTransform[1]]
        ];
        normalized.relativeTransform[0][2] += offset.x;
        normalized.relativeTransform[1][2] += offset.y;
    }

    return normalized;
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

export function applySingleChildAutoSpaceAlignmentFix(node: any, layout: any) {
    if (!isAutoSpaceAlongPrimaryAxis(layout)) return;
    if (getRestorableChildCount(node) !== 1) return;

    // Force MIN here so the restored layout preserves MasterGo's visual result for SPACE_BETWEEN.
    safeSet(node, "primaryAxisAlignItems", "MIN");
}

export async function applyDeferredSingleChildAutoSpaceAlignmentFixes(root: BaseNode, progress?: PostprocessProgressCallback) {
    const nodes = collectDescendants(root);
    const total = Math.max(1, nodes.length);
    let done = 0;
    let lastYieldAt = Date.now();

    for (let index = nodes.length - 1; index >= 0; index--) {
        const node = nodes[index];
        if (isSceneNode(node)) {
            const layout = state.restoredLayoutByNodeId[node.id];
            if (layout && hasAutoLayout(node)) applySingleChildAutoSpaceAlignmentFix(node, layout);
        }
        done++;
        lastYieldAt = await maybeYieldPostprocess(done, total, "正在修正自动布局对齐...", lastYieldAt, progress);
    }
}

function collectDescendants(root: BaseNode): BaseNode[] {
    const nodes: BaseNode[] = [];
    const stack: BaseNode[] = [root];
    while (stack.length > 0) {
        const node = stack.pop() as BaseNode;
        nodes.push(node);
        if (!("children" in node)) continue;
        const children = [...(node as any).children] as BaseNode[];
        for (let index = children.length - 1; index >= 0; index--) {
            stack.push(children[index]);
        }
    }
    return nodes;
}

async function maybeYieldPostprocess(
    done: number,
    total: number,
    label: string,
    lastYieldAt: number,
    progress?: PostprocessProgressCallback
): Promise<number> {
    const now = Date.now();
    if (done < total && done % POSTPROCESS_BATCH_SIZE !== 0 && now - lastYieldAt < POSTPROCESS_YIELD_INTERVAL_MS) {
        return lastYieldAt;
    }
    if (progress) await progress(done, total, label);
    await yieldToEventLoop();
    return Date.now();
}

function isAutoSpaceAlongPrimaryAxis(layout: any): boolean {
    return normalizeAxisAlign(layout.primaryAxisAlignItems) === "SPACE_BETWEEN" ||
        normalizeAxisAlign(layout.mainAxisAlignItems) === "SPACE_BETWEEN";
}

export function getRestorableChildCount(node: any): number {
    if (!("children" in node)) return 0;

    return [...node.children].filter((child: BaseNode) => {
        return !child.name.startsWith(INTERNAL_PROPS_PREFIX) && !child.name.startsWith(SIBLING_PROPS_PREFIX);
    }).length;
}

export function hasAutoLayout(node: any): boolean {
    return "layoutMode" in node && node.layoutMode !== "NONE";
}

export function hasAutoLayoutParent(node: any): boolean {
    const parent = node.parent as any;
    return !!parent && "layoutMode" in parent && parent.layoutMode !== "NONE";
}

export function shouldRestoreFixedSize(node: any, layout: any): boolean {
    if (!hasAutoLayout(node)) return true;

    const primarySizing = normalizeAxisSizingMode(layout.primaryAxisSizingMode || node.primaryAxisSizingMode);
    const counterSizing = normalizeAxisSizingMode(layout.counterAxisSizingMode || node.counterAxisSizingMode);
    return primarySizing === "FIXED" || counterSizing === "FIXED";
}

export function applyAspectRatioLock(node: any, shouldLock: boolean) {
    if (typeof node.lockAspectRatio === "function" && typeof node.unlockAspectRatio === "function") {
        try {
            if (shouldLock) {
                node.lockAspectRatio();
            } else if (node.targetAspectRatio) {
                node.unlockAspectRatio();
            }
        } catch (e) {}
    }
}
