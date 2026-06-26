import { MissingImageAssetDetail, state } from "../state";
import { safeSet, safeResize } from "../../../shared/utils";
import { cloneTransform } from "../../../shared/matrixUtils";
import { normalizeMasterGoStrokeCapForFigma } from "../../../shared/connectorUtils";
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
type ImagePaintContext = {
    node?: SceneNode;
    layout?: any;
    paintTarget?: "fill" | "stroke" | "image";
};

export function normalizeImagePaint(paint: any, context?: ImagePaintContext): any {
    if (!paint || paint.type !== "IMAGE") return normalizePaintForFigma(paint);

    const assetName = typeof paint.imageRef === "string" ? paint.imageRef : "";
    const imageHash = tryResolveImageHash(paint);

    if (!imageHash) {
        recordMissingImageAsset(assetName || "missing-image.png", context);
        const placeholder: any = {
            type: "SOLID",
            color: { ...MISSING_IMAGE_PLACEHOLDER_COLOR }
        };
        if (paint.visible !== undefined) placeholder.visible = paint.visible;
        if (paint.opacity !== undefined) placeholder.opacity = paint.opacity;
        if (paint.blendMode) placeholder.blendMode = paint.blendMode;
        return normalizePaintForFigma(placeholder);
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

    return normalizePaintForFigma(result);
}

export function normalizeImageFills(fills: any[], node?: SceneNode, layout?: any): any[] {
    if (!Array.isArray(fills)) return fills;
    return fills.map(paint => normalizeImagePaint(paint, { node, layout, paintTarget: "fill" })).filter(Boolean);
}

// Strokes mirror fills (image strokes are resolved the same way) but also need
// the paint-level PASS_THROUGH → NORMAL normalization that Figma requires.
export function normalizeImageStrokes(strokes: any[], node?: SceneNode, layout?: any): any[] {
    if (!Array.isArray(strokes)) return strokes;
    return strokes.map(paint => normalizeImagePaint(paint, { node, layout, paintTarget: "stroke" })).filter(Boolean);
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

export function recordMissingImageAsset(assetName: string, context?: ImagePaintContext) {
    if (!state.missingImageAssetNames[assetName]) {
        state.missingImageAssetNames[assetName] = true;
        state.missingImageAssetCount++;
    }
    const detail = createMissingImageAssetDetail(assetName, context);
    if (!detail) return;
    const key = [
        detail.assetName,
        detail.nodeId,
        detail.layerPath,
        detail.paintTarget,
        detail.x,
        detail.y,
        detail.width,
        detail.height
    ].join("|");
    if (state.missingImageAssetDetailKeys[key]) return;
    state.missingImageAssetDetailKeys[key] = true;
    state.missingImageAssetDetails.push(detail);
}

function createMissingImageAssetDetail(assetName: string, context?: ImagePaintContext): MissingImageAssetDetail | null {
    const node = context?.node as any;
    if (!node) return null;

    const layout = context?.layout || {};
    const absoluteTransform = node.absoluteTransform || node.relativeTransform;
    const x = toFiniteNumber(layout.x, absoluteTransform && absoluteTransform[0] && absoluteTransform[0][2]);
    const y = toFiniteNumber(layout.y, absoluteTransform && absoluteTransform[1] && absoluteTransform[1][2]);
    const width = toFiniteNumber(layout.width, node.width);
    const height = toFiniteNumber(layout.height, node.height);

    return {
        assetName,
        nodeId: typeof node.id === "string" ? node.id : "",
        nodeName: typeof node.name === "string" ? node.name : "Untitled",
        layerPath: getNodeLayerPath(node),
        nodeType: typeof node.type === "string" ? node.type : "UNKNOWN",
        paintTarget: context?.paintTarget || "image",
        x,
        y,
        width,
        height
    };
}

function getNodeLayerPath(node: any): string {
    const parts: string[] = [];
    let current = node;
    while (current && current.type !== "DOCUMENT") {
        if (typeof current.name === "string" && current.name) {
            parts.unshift(current.name);
        } else if (typeof current.type === "string") {
            parts.unshift(current.type);
        }
        current = current.parent;
    }
    return parts.join(" / ");
}

function toFiniteNumber(...values: any[]): number | null {
    for (const value of values) {
        if (typeof value === "number" && Number.isFinite(value)) {
            return Math.round(value * 100) / 100;
        }
    }
    return null;
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

    const normalized = normalizePaintsForFigma(fills);
    try {
        node.fills = normalized;
    } catch (error) {
        const fallbackFills = stripUnsupportedPaintExtras(normalized);
        try {
            node.fills = fallbackFills;
        } catch (fallbackError) {
            console.warn("Unable to set fills:", node.name, describePaintSetError(fallbackError, fallbackFills));
        }
    }
}

export function safeSetStrokes(node: any, strokes: any[]) {
    if (!("strokes" in node)) return;

    const normalized = normalizePaintsForFigma(strokes);
    try {
        node.strokes = normalized;
    } catch (error) {
        const fallbackStrokes = stripUnsupportedPaintExtras(normalized);
        try {
            node.strokes = fallbackStrokes;
        } catch (fallbackError) {
            console.warn("Unable to set strokes:", node.name, describePaintSetError(fallbackError, fallbackStrokes));
        }
    }
}

export function normalizePaintsForFigma(paints: any[]): any[] {
    if (!Array.isArray(paints)) return paints;
    return paints.map(normalizePaintForFigma).filter(Boolean);
}

export function normalizePaintForFigma(paint: any): any {
    if (!paint || typeof paint !== "object") return paint;

    const copy: any = {};
    for (const key in paint) {
        if (key === "imageRef" || key === "missingAsset" || key === "isVisible") continue;
        if (paint[key] !== undefined) copy[key] = paint[key];
    }

    if (copy.visible === undefined && paint.isVisible !== undefined) copy.visible = paint.isVisible;
    if (copy.visible === undefined) copy.visible = true;
    if (copy.blendMode === "PASS_THROUGH") copy.blendMode = "NORMAL";
    if (typeof copy.opacity === "number") copy.opacity = clamp01(copy.opacity);

    if (copy.type === "SOLID") {
        if (copy.color) copy.color = normalizePaintColor(copy.color);
        return pickDefined(copy, ["type", "visible", "opacity", "blendMode", "color", "boundVariables"]);
    }
    if (copy.type === "GRADIENT_LINEAR" || copy.type === "GRADIENT_RADIAL" || copy.type === "GRADIENT_ANGULAR" || copy.type === "GRADIENT_DIAMOND") {
        if (Array.isArray(copy.gradientStops)) copy.gradientStops = copy.gradientStops.map(normalizeGradientStop).filter(Boolean);
        return pickDefined(copy, ["type", "visible", "opacity", "blendMode", "gradientHandlePositions", "gradientStops", "gradientTransform", "boundVariables"]);
    }
    if (copy.type === "IMAGE") {
        if (!copy.imageHash) return null;
        return pickDefined(copy, ["type", "visible", "opacity", "blendMode", "scaleMode", "imageHash", "imageTransform", "scalingFactor", "rotation", "filters", "gifRef", "boundVariables"]);
    }
    if (copy.type === "VIDEO") {
        return pickDefined(copy, ["type", "visible", "opacity", "blendMode", "scaleMode", "videoHash", "videoTransform", "scalingFactor", "rotation", "filters", "boundVariables"]);
    }
    return copy;
}

export function stripUnsupportedPaintExtras(paints: any[]): any[] {
    if (!Array.isArray(paints)) return paints;
    return paints.map(paint => {
        if (!paint || typeof paint !== "object") return paint;
        if (paint.type === "IMAGE") {
            return pickDefined(paint, ["type", "visible", "opacity", "blendMode", "scaleMode", "imageHash"]);
        }
        if (paint.type === "GRADIENT_LINEAR" || paint.type === "GRADIENT_RADIAL" || paint.type === "GRADIENT_ANGULAR" || paint.type === "GRADIENT_DIAMOND") {
            return pickDefined(paint, ["type", "visible", "opacity", "blendMode", "gradientHandlePositions", "gradientStops"]);
        }
        return normalizePaintForFigma(paint);
    }).filter(Boolean);
}

function pickDefined(value: any, keys: string[]): any {
    const result: any = {};
    for (const key of keys) {
        if (value[key] !== undefined) result[key] = value[key];
    }
    return result;
}

function normalizeGradientStop(stop: any): any {
    if (!stop || typeof stop !== "object") return null;
    const result: any = {};
    result.position = clamp01(typeof stop.position === "number" ? stop.position : 0);
    result.color = normalizePaintColor(stop.color || {});
    if (stop.boundVariables !== undefined) result.boundVariables = stop.boundVariables;
    return result;
}

function normalizePaintColor(color: any): any {
    return {
        r: clamp01(typeof color.r === "number" ? color.r : 0),
        g: clamp01(typeof color.g === "number" ? color.g : 0),
        b: clamp01(typeof color.b === "number" ? color.b : 0),
        a: clamp01(typeof color.a === "number" ? color.a : 1)
    };
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

function describePaintSetError(error: any, paints: any[]): any {
    return {
        message: error instanceof Error ? error.message : String(error || "Unknown error"),
        paintTypes: Array.isArray(paints) ? paints.map(paint => paint && paint.type) : [],
        blendModes: Array.isArray(paints) ? paints.map(paint => paint && paint.blendMode).filter(Boolean) : []
    };
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

export function hasFiniteRelativeTransform(layout: any): boolean {
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

export function getUniformOpenVectorStrokeCap(vectorNetwork: any): string | null {
    if (!vectorNetwork || !Array.isArray(vectorNetwork.vertices) || !Array.isArray(vectorNetwork.segments)) return null;
    if (Array.isArray(vectorNetwork.regions) && vectorNetwork.regions.length > 0) return null;
    if (vectorNetwork.segments.length < 1) return null;

    const firstSegment = vectorNetwork.segments[0];
    const lastSegment = vectorNetwork.segments[vectorNetwork.segments.length - 1];
    const startVertex = vectorNetwork.vertices[firstSegment && firstSegment.start];
    const endVertex = vectorNetwork.vertices[lastSegment && lastSegment.end];
    const startCap = startVertex && startVertex.strokeCap;
    const endCap = endVertex && endVertex.strokeCap;
    if (!startCap || startCap === "NONE") return null;
    if (endCap && endCap !== "NONE" && endCap !== startCap) return null;
    return normalizeMasterGoStrokeCapForFigma(startCap);
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
    const isBooleanOperation = node.type === "BOOLEAN_OPERATION";

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
        if (data.geometry.fills) safeSetFills(node, normalizeImageFills(data.geometry.fills, node, data.layout));
        if (data.geometry.strokes) {
            safeSetStrokes(node, normalizeImageStrokes(data.geometry.strokes, node, data.layout));
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
        if (data.geometry.strokeCap && !data.connectorFallbackPolyline) {
            const vectorCap = data.geometry.strokeCap === "NONE" ? getUniformOpenVectorStrokeCap(data.vectorNetwork) : null;
            safeSet(node, "strokeCap", vectorCap || normalizeMasterGoStrokeCapForFigma(data.geometry.strokeCap));
        }
    }

    if (data.constraints) safeSet(node, "constraints", normalizeConstraints(data.constraints));
    if (data.exportSettings) safeSet(node, "exportSettings", data.exportSettings);

    if (data.layout) {
        const layout = normalizeLayoutForParent(node, data.layout);
        state.restoredLayoutByNodeId[node.id] = layout;

        if (layout.width !== undefined && layout.height !== undefined) {
            if (isGroup || isBooleanOperation) {
                // Group and boolean geometry is derived from children; resizing can shift nested vector bounds.
            } else {
                safeResize(node, layout.width, layout.height);
            }
        }
        const hasRelativeTransform = hasFiniteRelativeTransform(layout);
        if (hasRelativeTransform) {
            safeSet(node, "relativeTransform", layout.relativeTransform);
        } else {
            if (layout.x !== undefined) safeSet(node, "x", layout.x);
            if (layout.y !== undefined) safeSet(node, "y", layout.y);
            if (layout.rotation !== undefined) safeSet(node, "rotation", layout.rotation);
        }
        if (layout.constrainProportions !== undefined) {
            applyAspectRatioLock(node, layout.constrainProportions);
        }
        deferLayoutRestore(node, layout, isGroup);
    }

    if (data.clipsContent !== undefined) safeSet(node, "clipsContent", data.clipsContent);
}
