import { state } from "../state";
import { safeSet, safeResize } from "../../../shared/utils";
import { cloneTransform } from "../../../shared/matrixUtils";
import { deferLayoutRestore, applyAspectRatioLock } from "../deferredLayout";

export function recordRestoredNode(data: any, node: SceneNode) {
    const sourceId = data && typeof data.id === "string" ? data.id : "";
    if (sourceId && node && typeof node.id === "string") {
        state.restoredNodeIdBySourceId[sourceId] = node.id;
    }
}

// Light-gray placeholder shown when an image asset is missing from the package.
// A visible SOLID fill (instead of a near-invisible 1x1 transparent image) makes
// the loss obvious during manual review while preserving the node's dimensions.
export const MISSING_IMAGE_PLACEHOLDER_COLOR = { r: 0.82, g: 0.83, b: 0.85 };

// Resolve a single IMAGE paint into a Figma image paint, or a visible gray
// placeholder SOLID when the asset is missing. Non-IMAGE paints pass through
// unchanged. Used for both fills and strokes (Figma supports image strokes too).
export function normalizeImagePaint(paint: any): any {
    if (!paint || paint.type !== "IMAGE") return paint;

    const assetName = typeof paint.imageRef === "string" ? paint.imageRef : "";
    const imageHash = tryResolveImageHash(paint);

    if (!imageHash) {
        recordMissingImageAsset(assetName || "missing-image.png");
        const placeholder: any = {
            type: "SOLID",
            color: { ...MISSING_IMAGE_PLACEHOLDER_COLOR }
        };
        if (paint.visible !== undefined) placeholder.visible = paint.visible;
        if (paint.opacity !== undefined) placeholder.opacity = paint.opacity;
        if (paint.blendMode) placeholder.blendMode = paint.blendMode;
        return placeholder;
    }

    const result: any = {
        type: "IMAGE",
        scaleMode: paint.scaleMode || "FILL",
        imageHash
    };

    if (paint.visible !== undefined) result.visible = paint.visible;
    if (paint.opacity !== undefined) result.opacity = paint.opacity;
    if (paint.blendMode) result.blendMode = paint.blendMode;
    const filters = normalizeImageFilters(paint.filters);
    if (filters) result.filters = filters;
    if (paint.rotation !== undefined) result.rotation = paint.rotation;
    if (paint.imageTransform) result.imageTransform = paint.imageTransform;
    if (paint.scalingFactor !== undefined) result.scalingFactor = paint.scalingFactor;

    return result;
}

export function normalizeImageFills(fills: any[]): any[] {
    if (!Array.isArray(fills)) return fills;
    return fills.map(normalizeImagePaint);
}

// Strokes mirror fills (image strokes are resolved the same way) but also need
// the paint-level PASS_THROUGH → NORMAL normalization that Figma requires.
export function normalizeImageStrokes(strokes: any[]): any[] {
    if (!Array.isArray(strokes)) return strokes;
    return strokes.map(stroke => {
        const paint = normalizeImagePaint(stroke);
        if (paint && paint.blendMode === "PASS_THROUGH") {
            return { ...paint, blendMode: "NORMAL" };
        }
        return paint;
    });
}

export function normalizeImageFilters(filters: any): any {
    if (!filters || typeof filters !== "object") return null;

    const result: any = {};
    const allowed = ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"];
    for (const key of allowed) {
        if (typeof filters[key] === "number") result[key] = filters[key];
    }

    return Object.keys(result).length > 0 ? result : null;
}

// Resolve a Figma image hash for an image fill, or null when the asset is
// missing/unreadable. No side effects beyond caching successfully created
// images (callers decide how to render a missing asset).
export function tryResolveImageHash(fill: any): string | null {
    const assetName = typeof fill.imageRef === "string" ? fill.imageRef : "";
    if (!assetName || fill.missingAsset) return null;

    const existingHash = state.imageHashByAssetName[assetName];
    if (existingHash) return existingHash;

    const bytes = state.activeImportAssets[assetName];
    if (!bytes) return null;

    try {
        const image = figma.createImage(bytes);
        state.imageHashByAssetName[assetName] = image.hash;
        return image.hash;
    } catch (error) {
        console.warn("Unable to create Figma image from asset:", assetName, error);
        return null;
    }
}

// Backwards-compatible wrapper: resolves a hash, falling back to the legacy
// transparent placeholder image when the asset is missing.
export function getImageHashForFill(fill: any): string {
    const hash = tryResolveImageHash(fill);
    if (hash) return hash;
    const assetName = typeof fill.imageRef === "string" ? fill.imageRef : "";
    recordMissingImageAsset(assetName || "missing-image.png");
    return getPlaceholderImageHash();
}

export function recordMissingImageAsset(assetName: string) {
    if (state.missingImageAssetNames[assetName]) return;
    state.missingImageAssetNames[assetName] = true;
    state.missingImageAssetCount++;
}

export function getPlaceholderImageHash(): string {
    if (state.placeholderImageHash) return state.placeholderImageHash;
    const image = figma.createImage(new Uint8Array([
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
        0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
        0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0,
        5, 0, 1, 13, 10, 42, 180, 0, 0, 0, 0, 73, 69, 78, 68,
        174, 66, 96, 130
    ]));
    state.placeholderImageHash = image.hash;
    return image.hash;
}

export function normalizeEffectsForNode(node: any, effects: any[]): any[] {
    if (!Array.isArray(effects)) return effects;

    return effects.map(effect => {
        if (!effect || typeof effect !== "object") return effect;

        const copy: any = {};
        for (const key in effect) {
            if (key !== "spread" || supportsEffectSpread(node)) copy[key] = effect[key];
        }
        if (copy.visible === undefined && effect.isVisible !== undefined) copy.visible = effect.isVisible;
        if (copy.visible === undefined) copy.visible = true;
        if (copy.blendMode === "PASS_THROUGH") copy.blendMode = "NORMAL";
        if (copy.type === "DROP_SHADOW" || copy.type === "INNER_SHADOW") {
            if (copy.showShadowBehindNode === undefined) copy.showShadowBehindNode = true;
        }
        return copy;
    });
}

export function safeSetEffects(node: any, effects: any[]) {
    if (!("effects" in node)) return;

    const normalized = normalizeEffectsForNode(node, effects);
    try {
        node.effects = normalized;
        return;
    } catch (_) {}

    // Older plugin runtimes can reject effect spread on more node types than the
    // typings suggest. Retry without spread so one unsupported field does not
    // drop the entire shadow.
    const withoutSpread = Array.isArray(normalized) ? normalized.map(effect => {
        if (!effect || typeof effect !== "object") return effect;
        const copy: any = {};
        for (const key in effect) {
            if (key !== "spread") copy[key] = effect[key];
        }
        return copy;
    }) : normalized;
    try {
        node.effects = withoutSpread;
    } catch (_) {}
}

// Figma supports effect spread on these node types. All others have the spread
// property stripped before assignment to avoid a plugin API error.
export function supportsEffectSpread(node: any): boolean {
    return node.type === "FRAME" ||
        node.type === "COMPONENT" ||
        node.type === "COMPONENT_SET" ||
        node.type === "INSTANCE" ||
        node.type === "RECTANGLE" ||
        node.type === "ELLIPSE" ||
        node.type === "POLYGON" ||
        node.type === "STAR" ||
        node.type === "VECTOR" ||
        node.type === "SECTION" ||
        node.type === "TEXT";
}

export function normalizeConstraints(value: any): any {
    if (!value || typeof value !== "object") return value;

    const horizontal = normalizeConstraintType(value.horizontal);
    const vertical = normalizeConstraintType(value.vertical);
    if (!horizontal || !vertical) return undefined;

    return { horizontal, vertical };
}

export function normalizeConstraintType(value: any): string | undefined {
    if (value === "START" || value === "MIN") return "MIN";
    if (value === "END" || value === "MAX") return "MAX";
    if (value === "STARTANDEND" || value === "STRETCH") return "STRETCH";
    if (value === "CENTER" || value === "SCALE") return value;
    return undefined;
}

export function safeSetFills(node: any, fills: any[]) {
    if (!("fills" in node)) return;

    try {
        node.fills = fills;
    } catch (error) {
        console.warn("Unable to set fills:", node.name, error, fills);
        const fallbackFills = stripImageFillExtras(fills);
        try {
            node.fills = fallbackFills;
        } catch (fallbackError) {
            console.warn("Unable to set fallback fills:", node.name, fallbackError, fallbackFills);
        }
    }
}

export function safeSetStrokes(node: any, strokes: any[]) {
    if (!("strokes" in node)) return;

    try {
        node.strokes = strokes;
    } catch (error) {
        console.warn("Unable to set strokes:", node.name, error, strokes);
        const fallbackStrokes = stripImageFillExtras(strokes);
        try {
            node.strokes = fallbackStrokes;
        } catch (fallbackError) {
            console.warn("Unable to set fallback strokes:", node.name, fallbackError, fallbackStrokes);
        }
    }
}

export function stripImageFillExtras(fills: any[]): any[] {
    if (!Array.isArray(fills)) return fills;

    return fills.map(fill => {
        if (!fill || fill.type !== "IMAGE") return fill;
        return {
            type: "IMAGE",
            scaleMode: fill.scaleMode || "FILL",
            imageHash: fill.imageHash,
            visible: fill.visible,
            opacity: fill.opacity,
            blendMode: fill.blendMode
        };
    });
}

export function isNearlyZero(value: number): boolean {
    return Math.abs(value) < 0.01;
}

export function isNearlyEqual(a: number, b: number): boolean {
    return Math.abs(a - b) < 0.01;
}

export function copyLayout(layout: any): any {
    const copy: any = {};
    for (const key in layout) copy[key] = layout[key];
    return copy;
}

export function axisBoundsDistance(value: number, size: number): number {
    if (value < -size) return -size - value;
    if (value > size * 2) return value - size * 2;
    return 0;
}

export function groupChildBoundsDistance(x: number, y: number, width: number, height: number): number {
    return axisBoundsDistance(x, width) + axisBoundsDistance(y, height);
}

export function isGroupChildOffsetImprovement(parent: any, x: number, y: number, normalizedX: number, normalizedY: number): boolean {
    const restoredLayout = state.restoredLayoutByNodeId[parent.id] || {};
    const width = Math.max(restoredLayout.width || parent.width || 0, 1);
    const height = Math.max(restoredLayout.height || parent.height || 0, 1);
    const currentScore = groupChildBoundsDistance(x, y, width, height);
    const normalizedScore = groupChildBoundsDistance(normalizedX, normalizedY, width, height);

    return normalizedScore < currentScore && currentScore > 0;
}

export function findNearestPositionedAncestor(group: any): any {
    let ancestor = group.parent as any;
    while (ancestor && ancestor.type !== "PAGE" && ancestor.type !== "DOCUMENT") {
        if (ancestor.type !== "GROUP") return ancestor;
        ancestor = ancestor.parent;
    }
    return null;
}

export function getGroupChildCanvasOffset(node: any, layout: any): { x: number; y: number } | null {
    const parent = node.parent as any;
    if (!parent || parent.type !== "GROUP" || !layout) return null;
    if (layout.x === undefined || layout.y === undefined) return null;

    const ancestor = findNearestPositionedAncestor(parent);
    if (!ancestor) return null;

    const ancestorTransform = (ancestor as any).absoluteTransform || (ancestor as any).relativeTransform;
    if (!ancestorTransform) return null;

    const offset = { x: ancestorTransform[0][2] || 0, y: ancestorTransform[1][2] || 0 };
    if (isNearlyZero(offset.x) && isNearlyZero(offset.y)) return null;

    const normalizedX = layout.x - offset.x;
    const normalizedY = layout.y - offset.y;
    if (!isGroupChildOffsetImprovement(parent, layout.x, layout.y, normalizedX, normalizedY)) return null;

    return offset;
}

export function normalizeLayoutForParent(node: any, layout: any): any {
    const offset = getGroupChildCanvasOffset(node, layout);
    if (!offset) return layout;

    const normalized = copyLayout(layout);
    normalized.x = (layout.x || 0) - offset.x;
    normalized.y = (layout.y || 0) - offset.y;

    if (layout.relativeTransform) {
        normalized.relativeTransform = cloneTransform(layout.relativeTransform);
        normalized.relativeTransform[0][2] -= offset.x;
        normalized.relativeTransform[1][2] -= offset.y;
    }

    return normalized;
}

export async function applyUniversalProperties(node: any, data: any) {
    if (!node || !data) return;

    safeSet(node, "name", data.name);
    recordRestoredNode(data, node);

    // Enforce reading the typo key "scence"
    if (data.scence) {
        safeSet(node, "visible", data.scence.visible ?? true);
        safeSet(node, "locked", data.scence.locked ?? false);
    }

    if (data.blend) {
        safeSet(node, "opacity", data.blend.opacity ?? 1);
        safeSet(node, "isMask", data.blend.isMask ?? false);
        safeSet(node, "blendMode", data.blend.blendMode || "NORMAL");
        if (data.blend.effects) {
            safeSetEffects(node, data.blend.effects);
        }
    }

    const isGroup = node.type === "GROUP";

    if (!isGroup && data.corner && node.type !== "LINE" && node.type !== "TEXT") {
        if (data.corner.cornerRadius === -1) {
            if ("topLeftRadius" in node) {
                safeSet(node, "topLeftRadius", data.corner.topLeftRadius || 0);
                safeSet(node, "topRightRadius", data.corner.topRightRadius || 0);
                safeSet(node, "bottomLeftRadius", data.corner.bottomLeftRadius || 0);
                safeSet(node, "bottomRightRadius", data.corner.bottomRightRadius || 0);
            }
        } else {
            safeSet(node, "cornerRadius", data.corner.cornerRadius || 0);
        }
        safeSet(node, "cornerSmoothing", data.corner.cornerSmoothing || 0);
    }

    if (!isGroup && data.geometry && !data.svgFallback) {
        if (data.geometry.fills) safeSetFills(node, normalizeImageFills(data.geometry.fills));
        if (data.geometry.strokes) {
            safeSetStrokes(node, normalizeImageStrokes(data.geometry.strokes));
        }

        if (data.geometry.strokeWeight !== undefined) {
            safeSet(node, "strokeWeight", data.geometry.strokeWeight);
        }

        if (node.strokeTopWeight !== undefined) {
            if (data.geometry.strokeTopWeight !== undefined) {
                try {
                    node.strokeTopWeight = data.geometry.strokeTopWeight;
                    node.strokeBottomWeight = data.geometry.strokeBottomWeight;
                    node.strokeLeftWeight = data.geometry.strokeLeftWeight;
                    node.strokeRightWeight = data.geometry.strokeRightWeight;
                } catch (e: any) {}
            }
        }

        if (data.geometry.strokeAlign) safeSet(node, "strokeAlign", data.geometry.strokeAlign);
        if (data.geometry.strokeJoin) safeSet(node, "strokeJoin", data.geometry.strokeJoin);
        if (data.geometry.dashPattern !== undefined) safeSet(node, "dashPattern", data.geometry.dashPattern);
        if (data.geometry.strokeCap && !data.connectorFallbackPolyline) safeSet(node, "strokeCap", data.geometry.strokeCap);
    }

    if (data.constraints) safeSet(node, "constraints", normalizeConstraints(data.constraints));
    if (data.exportSettings) safeSet(node, "exportSettings", data.exportSettings);

    if (data.layout) {
        const layout = normalizeLayoutForParent(node, data.layout);
        state.restoredLayoutByNodeId[node.id] = layout;

        if (layout.relativeTransform) safeSet(node, "relativeTransform", layout.relativeTransform);
        if (layout.x !== undefined) safeSet(node, "x", layout.x);
        if (layout.y !== undefined) safeSet(node, "y", layout.y);
        if (layout.rotation !== undefined) safeSet(node, "rotation", layout.rotation);
        if (layout.width !== undefined && layout.height !== undefined) {
            if (isGroup) {
                // Group resize is different, but for now we trust relativeTransform
            } else {
                safeResize(node, layout.width, layout.height);
            }
        }
        if (layout.constrainProportions !== undefined) {
            applyAspectRatioLock(node, layout.constrainProportions);
        }
        deferLayoutRestore(node, layout, isGroup);
    }

    if (data.clipsContent !== undefined) safeSet(node, "clipsContent", data.clipsContent);
}
