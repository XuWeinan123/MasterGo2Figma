import { state } from "./state";
import { safeSet, safeResize, isSceneNode } from "../../shared/utils";

const INTERNAL_PROPS_PREFIX = "[PROPS]";
const SIBLING_PROPS_PREFIX = "[PROPS_SIBLING]";

export function deferLayoutRestore(node: any, layout: any, isGroup: boolean) {
    if (!node || !layout || !isSceneNode(node)) return;
    state.deferredLayoutRestores.push({ node, layout, isGroup });
    if (state.activeRestoreStats) {
        state.activeRestoreStats.deferredLayoutNodeCount++;
    }
}

export function applyDeferredLayoutRestores() {
    if (state.deferredLayoutRestores.length === 0) return;

    const records = state.deferredLayoutRestores;
    state.deferredLayoutRestores = [];

    for (const record of records) applyDeferredNodeAutoLayout(record);
    for (const record of records) applyDeferredParentAutoLayout(record);
    for (const record of records) finalizeDeferredAutoLayout(record);
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
    if (layout.relativeTransform) {
        safeSet(node, "relativeTransform", layout.relativeTransform);
        applied = true;
    }
    if (layout.x !== undefined) {
        safeSet(node, "x", layout.x);
        applied = true;
    }
    if (layout.y !== undefined) {
        safeSet(node, "y", layout.y);
        applied = true;
    }

    if (applied && state.activeRestoreStats) {
        state.activeRestoreStats.deferredLayoutAppliedCount++;
    }
}

function finalizeDeferredAutoLayout(record: { node: SceneNode; layout: any; isGroup: boolean }) {
    const { node, layout, isGroup } = record;
    if (isRemovedNode(node) || isGroup || !hasAutoLayout(node)) return;
    if (layout.width === undefined || layout.height === undefined || !shouldRestoreFixedSize(node, layout)) return;

    safeResize(node, layout.width, layout.height);
    if (layout.relativeTransform) safeSet(node, "relativeTransform", layout.relativeTransform);
    if (layout.x !== undefined) safeSet(node, "x", layout.x);
    if (layout.y !== undefined) safeSet(node, "y", layout.y);
}

export function applySingleChildAutoSpaceAlignmentFix(node: any, layout: any) {
    if (!isAutoSpaceAlongPrimaryAxis(layout)) return;
    if (getRestorableChildCount(node) !== 1) return;

    // Force MIN here so the restored layout preserves MasterGo's visual result for SPACE_BETWEEN.
    safeSet(node, "primaryAxisAlignItems", "MIN");
}

export function applyDeferredSingleChildAutoSpaceAlignmentFixes(root: BaseNode) {
    if (!("children" in root)) return;

    const children = [...(root as any).children];
    for (const child of children) {
        applyDeferredSingleChildAutoSpaceAlignmentFixes(child);
    }

    if (!isSceneNode(root)) return;

    const layout = state.restoredLayoutByNodeId[root.id];
    if (!layout || !hasAutoLayout(root)) return;
    applySingleChildAutoSpaceAlignmentFix(root, layout);
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
