import { cloneTransform } from "../../../shared/matrixUtils";
import { 
    cloneJsonCompatible, finiteNumber, safeRead, isOutOfMemoryError, describeError 
} from "../../../shared/utils";
import { state } from "../state";
import { getRestoreType } from "../layerRules";
import { createImageFillJson } from "../imageExporter";

export { safeRead, cloneJsonCompatible, finiteNumber };


export function readNodeProperty<T>(node: any, property: string, fallback: T): T {
    try {
        const value = node ? node[property] : undefined;
        return value === undefined || value === null ? fallback : value;
    } catch (error) {
        if (isOutOfMemoryError(error)) {
            state.logDiagnostic("error", "[MasterGo2Figma] Node property read OOM", {
                property,
                node: getNodeProbe(node),
                error: describeError(error),
                debugState: state.exportDebugState
            });
        }
        return fallback;
    }
}

export function getNodeProbe(node: any): any {
    if (!node) return { id: "", name: "", type: "NULL" };
    return {
        id: String(node.id || ""),
        name: String(node.name || "Untitled"),
        type: String(node.type || "UNKNOWN")
    };
}

export function clamp01(value: any, fallback = 0): number {
    const numberValue = finiteNumber(value, fallback);
    if (numberValue < 0) return 0;
    if (numberValue > 1) return 1;
    return numberValue;
}

export function cloneRgbColor(color: any) {
    return {
        r: finiteNumber(color && color.r, 0),
        g: finiteNumber(color && color.g, 0),
        b: finiteNumber(color && color.b, 0)
    };
}

export function cloneRgbaColor(color: any) {
    return {
        r: finiteNumber(color && color.r, 0),
        g: finiteNumber(color && color.g, 0),
        b: finiteNumber(color && color.b, 0),
        a: clamp01(color && color.a, 1)
    };
}

export function cloneVector2(point: any) {
    return {
        x: finiteNumber(point && point.x, 0),
        y: finiteNumber(point && point.y, 0)
    };
}

export function cloneGradientStops(stops: any) {
    if (!Array.isArray(stops)) return [];
    return stops.map(stop => ({
        position: clamp01(stop && stop.position, 0),
        color: cloneRgbaColor(stop && stop.color)
    }));
}

export function matrixMultiplication(m1: number[][], m2: number[][]): number[][] {
    let res: number[][] = [];
    for (let i = 0; i < m1.length; i++) {
        res[i] = [];
        for (let j = 0; j < m2[0].length; j++) {
            let sum = 0;
            for (let k = 0; k < m2.length; k++) {
                sum += m1[i][k] * m2[k][j];
            }
            res[i][j] = sum;
        }
    }
    return res;
}

export function getResultArrayByTwoPoint(points: readonly any[]) {
    if (points === undefined || points.length < 2) {
        return [[1, 0, 0], [0, 1, 0]];
    }
    const first = cloneVector2(points[0]);
    const second = cloneVector2(points[1]);
    const x3 = first.x, y3 = first.y, x4 = second.x, y4 = second.y;
    const m1 = [[1, 0, 0], [0, 1, 0.5], [0, 0, 1]];
    const len = Math.sqrt((x4 - x3) ** 2 + (y4 - y3) ** 2);
    if (!Number.isFinite(len) || len <= 0) return [[1, 0, 0], [0, 1, 0]];
    const m2 = [[1 / len, 0, 0], [0, 1, 0], [0, 0, 1]];
    const sina = (y3 - y4) / len, cosa = (x4 - x3) / len;
    const m3 = [[cosa, -sina, 0], [sina, cosa, 0], [0, 0, 1]];
    const m4 = [[1, 0, -x3], [0, 1, -y3], [0, 0, 1]];

    const m12 = matrixMultiplication(m2, m1);
    const m123 = matrixMultiplication(m12, m3);
    const m1234 = matrixMultiplication(m123, m4);
    return [m1234[0], m1234[1]];
}

// Derive a Figma gradientTransform for radial / angular / diamond gradients
// from the (normally 3) gradient handle positions:
//   p0 = center of the gradient (in node-local 0..1 space)
//   p1 = end of the primary (major) axis
//   p2 = end of the secondary (minor) axis
//
// Figma's gradientTransform T maps node space INTO gradient parameter space
// (same convention getResultArrayByTwoPoint uses for linear, which renders
// correctly). The gradient coordinate system places the center at (0.5, 0.5),
// the primary-axis end at (1, 0.5), and the secondary-axis end at (0.5, 1).
//
// We need T (node → gradient) such that:
//   T * [p0.x, p0.y, 1] = (0.5, 0.5)   (center)
//   T * [p1.x, p1.y, 1] = (1,   0.5)   (primary-axis end)
//   T * [p2.x, p2.y, 1] = (0.5, 1)     (secondary-axis end)
//
// The linear part A satisfies A·[u v] = [[0.5,0],[0,0.5]] (u=p1-p0, v=p2-p0),
// so A = 0.5 · inverse([u v]); translation t = (0.5,0.5) − A·p0.
//
// IMPORTANT: MasterGo only provides TWO handles for radial/angular/diamond
// (center + primary-axis end). We synthesize the secondary axis as the primary
// axis rotated 90° (p2 = p0 + rot90(p1-p0)), which yields the correct centered
// transform. Legacy hardcoded matrix is used for missing/degenerate handles.
export function getResultArrayByThreePoints(points: readonly any[]): number[][] {
    if (points === undefined || points.length < 2) {
        return [[0, 1, 0], [-1, 0, 1]];
    }

    const p0 = cloneVector2(points[0]);
    const p1 = cloneVector2(points[1]);
    // Primary axis vector u = p1 - p0.
    const ux = p1.x - p0.x, uy = p1.y - p0.y;
    // Secondary axis: use a provided 3rd handle if present, else synthesize it as
    // u rotated +90° → (-uy, ux), so p2 = p0 + rot90(u).
    const p2 = points.length >= 3
        ? cloneVector2(points[2])
        : { x: p0.x - uy, y: p0.y + ux };
    const vx = p2.x - p0.x, vy = p2.y - p0.y;

    // Degenerate: axes are collinear, gradient has zero area.
    const det = ux * vy - vx * uy;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-9) {
        return [[0, 1, 0], [-1, 0, 1]];
    }

    // A = 0.5 * inverse([u v]); inverse = (1/det) * [[vy, -vx], [-uy, ux]].
    const inv = 0.5 / det;
    const a00 = vy * inv, a01 = -vx * inv;
    const a10 = -uy * inv, a11 = ux * inv;

    // Translation t = (0.5, 0.5) - A * p0.
    const t0 = 0.5 - (a00 * p0.x + a01 * p0.y);
    const t1 = 0.5 - (a10 * p0.x + a11 * p0.y);

    // Normalize -0 to 0 for clean, deterministic output.
    const nz = (n: number) => (n === 0 ? 0 : n);
    return [[nz(a00), nz(a01), nz(t0)], [nz(a10), nz(a11), nz(t1)]];
}

// A well-formed 2x3 affine matrix with all-finite entries.
export function isFiniteTransform(t: any): boolean {
    return Array.isArray(t) && t.length >= 2 &&
        Array.isArray(t[0]) && t[0].length >= 3 &&
        Array.isArray(t[1]) && t[1].length >= 3 &&
        Number.isFinite(t[0][0]) && Number.isFinite(t[0][1]) && Number.isFinite(t[0][2]) &&
        Number.isFinite(t[1][0]) && Number.isFinite(t[1][1]) && Number.isFinite(t[1][2]);
}

// Apply a 2x3 affine matrix to a point. Returns {x, y}.
function applyAffine(m: number[][], p: { x: number; y: number }) {
    return {
        x: m[0][0] * p.x + m[0][1] * p.y + m[0][2],
        y: m[1][0] * p.x + m[1][1] * p.y + m[1][2]
    };
}

// Invert a 2x3 affine matrix, or null when its linear part is singular.
function invertAffine(m: number[][]): number[][] | null {
    const a = m[0][0], b = m[0][1], e = m[0][2];
    const c = m[1][0], d = m[1][1], f = m[1][2];
    const det = a * d - b * c;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
    const ia = d / det, ib = -b / det;
    const ic = -c / det, id = a / det;
    return [[ia, ib, -(ia * e + ib * f)], [ic, id, -(ic * e + id * f)]];
}

// Recover the secondary (minor) axis endpoint of a radial/angular/diamond
// gradient in node-normalized space.
//
// MasterGo exposes only TWO handles (center p0 + primary-axis end p1), so the
// minor-axis LENGTH — which controls the gradient's height — is missing from the
// handles and lives only in paint.transform (MasterGo's node→gradient affine M).
// Synthesizing a perpendicular axis of equal length (the previous behaviour)
// forces a circular gradient and loses the height.
//
// In MasterGo's gradient space the primary handle sits at distance D from the
// centre. The minor axis is the perpendicular direction in gradient space at the
// same distance D; mapping that point back through M⁻¹ gives the true minor-axis
// endpoint in node space, from which getResultArrayByThreePoints builds the
// correct (possibly non-circular) Figma transform.
function recoverMinorAxisEnd(p0: { x: number; y: number }, p1: { x: number; y: number }, m: number[][]): { x: number; y: number } | null {
    const mi = invertAffine(m);
    if (!mi) return null;
    const qc = applyAffine(m, p0);          // centre in gradient space
    const q1 = applyAffine(m, p1);          // primary-axis end in gradient space
    const dx = q1.x - qc.x, dy = q1.y - qc.y;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return null;
    // Perpendicular of the primary vector in gradient space, same length D.
    const perp = { x: qc.x - dy, y: qc.y + dx };
    const end = applyAffine(mi, perp);
    if (!Number.isFinite(end.x) || !Number.isFinite(end.y)) return null;
    return end;
}

// Resolve the Figma gradientTransform for a MasterGo gradient paint.
//
// Linear gradients are fully described by their two handles, so the proven
// getResultArrayByTwoPoint reconstruction is exact. Radial/angular/diamond need
// the minor-axis length recovered from paint.transform (see recoverMinorAxisEnd)
// to preserve the gradient's height; the recovered [center, major, minor] triple
// is fed to getResultArrayByThreePoints, which emits a Figma-conforming matrix.
// Falls back to the 2-handle reconstruction (circular) when transform is absent,
// malformed, or degenerate.
export function resolveGradientTransform(paint: any): number[][] {
    const points = (paint && paint.gradientHandlePositions) || [];
    if (paint && paint.type === "GRADIENT_LINEAR") {
        return getResultArrayByTwoPoint(points);
    }
    if (points.length >= 2 && isFiniteTransform(paint && paint.transform)) {
        const p0 = cloneVector2(points[0]);
        const p1 = cloneVector2(points[1]);
        const minorEnd = recoverMinorAxisEnd(p0, p1, paint.transform);
        if (minorEnd) {
            return getResultArrayByThreePoints([p0, p1, minorEnd]);
        }
    }
    return getResultArrayByThreePoints(points);
}

export function processBlendMode(blendMode: any): string {
    if (!blendMode) return "NORMAL";
    const value = String(blendMode).toUpperCase();
    if (value === "PASS_THROUGH") return "PASS_THROUGH";
    if (value === "NORMAL") return "NORMAL";
    if (value === "DARKEN") return "DARKEN";
    if (value === "MULTIPLY") return "MULTIPLY";
    if (value === "COLOR_BURN") return "COLOR_BURN";
    if (value === "LIGHTEN") return "LIGHTEN";
    if (value === "SCREEN") return "SCREEN";
    if (value === "COLOR_DODGE") return "COLOR_DODGE";
    if (value === "OVERLAY") return "OVERLAY";
    if (value === "SOFT_LIGHT") return "SOFT_LIGHT";
    if (value === "HARD_LIGHT") return "HARD_LIGHT";
    if (value === "DIFFERENCE") return "DIFFERENCE";
    if (value === "EXCLUSION") return "EXCLUSION";
    if (value === "HUE") return "HUE";
    if (value === "SATURATION") return "SATURATION";
    if (value === "COLOR") return "COLOR";
    if (value === "LUMINOSITY") return "LUMINOSITY";
    if (value === "PLUS_DARKER") return "PLUS_DARKER";
    if (value === "PLUS_LIGHTER") return "PLUS_LIGHTER";
    return "NORMAL";
}

export function fillsAndStrokes2Json(fills: readonly any[] | any, strokes: readonly any[]) {
    const resultFills: any[] = [];
    if (Array.isArray(fills)) {
        for (const fill of fills) {
            let tempResultFill: any = {};
            if (fill.type === "SOLID") {
                tempResultFill = {
                    "type": fill.type,
                    "visible": fill.isVisible,
                    "opacity": clamp01(fill.color && fill.color.a, 1),
                    "blendMode": processBlendMode(fill.blendMode),
                    "color": cloneRgbColor(fill.color)
                };
            } else if (fill.type === "GRADIENT_LINEAR") {
                tempResultFill = {
                    "type": fill.type,
                    "visible": fill.isVisible,
                    "opacity": clamp01(fill.alpha, 1),
                    "blendMode": processBlendMode(fill.blendMode),
                    "gradientStops": cloneGradientStops(fill.gradientStops),
                    "gradientTransform": resolveGradientTransform(fill)
                };
            } else if (fill.type === "GRADIENT_RADIAL" || fill.type === "GRADIENT_ANGULAR" || fill.type === "GRADIENT_DIAMOND") {
                tempResultFill = {
                    "type": fill.type,
                    "visible": fill.isVisible,
                    "opacity": clamp01(fill.alpha, 1),
                    "blendMode": processBlendMode(fill.blendMode),
                    "gradientStops": cloneGradientStops(fill.gradientStops),
                    "gradientTransform": resolveGradientTransform(fill)
                };
            } else if (fill.type === "IMAGE") {
                tempResultFill = createImageFillJson(fill);
            }
            if (tempResultFill.type) resultFills.push(tempResultFill);
        }
    }

    const resultStrokes: any[] = [];
    if (Array.isArray(strokes)) {
        for (const stroke of strokes) {
            let tempResultStroke: any = {};
            if (stroke.type === "SOLID") {
                tempResultStroke = {
                    "type": stroke.type,
                    "visible": stroke.isVisible,
                    "opacity": clamp01(stroke.color && stroke.color.a, 1),
                    "blendMode": processBlendMode(stroke.blendMode),
                    "color": cloneRgbColor(stroke.color)
                };
            } else if (stroke.type === "GRADIENT_LINEAR") {
                tempResultStroke = {
                    "type": stroke.type,
                    "visible": stroke.isVisible,
                    "opacity": clamp01(stroke.alpha, 1),
                    "blendMode": processBlendMode(stroke.blendMode),
                    "gradientStops": cloneGradientStops(stroke.gradientStops),
                    "gradientTransform": resolveGradientTransform(stroke)
                };
            } else if (stroke.type === "GRADIENT_RADIAL" || stroke.type === "GRADIENT_ANGULAR" || stroke.type === "GRADIENT_DIAMOND") {
                tempResultStroke = {
                    "type": stroke.type,
                    "visible": stroke.isVisible,
                    "opacity": clamp01(stroke.alpha, 1),
                    "blendMode": processBlendMode(stroke.blendMode),
                    "gradientStops": cloneGradientStops(stroke.gradientStops),
                    "gradientTransform": resolveGradientTransform(stroke)
                };
            } else if (stroke.type === "IMAGE") {
                tempResultStroke = createImageFillJson(stroke);
            }
            if (tempResultStroke.type) resultStrokes.push(tempResultStroke);
        }
    }

    return { fills: resultFills, strokes: resultStrokes };
}

export function getLayoutMode(node: any): string {
    const mode = readNodeProperty<string>(node, "layoutMode", "NONE");
    if (mode === "HORIZONTAL" || mode === "VERTICAL" || mode === "NONE") return mode;
    return "NONE";
}

export function getAxisAlign(value: any): string {
    if (value === "MIN" || value === "CENTER" || value === "MAX" || value === "SPACE_BETWEEN") return value;
    return "MIN";
}

export function getCounterAxisAlignContent(node: any): string {
    const value = readNodeProperty(node, "counterAxisAlignContent", "AUTO");
    if (value === "AUTO" || value === "SPACE_BETWEEN") return value;
    return "AUTO";
}

export function getLayoutAlign(value: any): string {
    if (value === "INHERIT" || value === "MIN" || value === "CENTER" || value === "MAX" || value === "STRETCH") return value;
    return "INHERIT";
}

export function getRelativeLayoutTransform(selection: any) {
    return cloneTransform(readNodeProperty(selection, "relativeTransform", [[1, 0, 0], [0, 1, 0]]));
}

export function overrideLayoutTransform(nodeJson: any, transform: any) {
    if (!nodeJson || !nodeJson.layout || !transform) return;

    const layoutTransform = cloneTransform(transform);
    nodeJson.layout.relativeTransform = layoutTransform;
    nodeJson.layout.x = layoutTransform[0][2];
    nodeJson.layout.y = layoutTransform[1][2];
}

export function getUniversalProperty(selection: any, sourceType?: string, restoreType?: string) {
    const resolvedSourceType = sourceType || readNodeProperty(selection, "type", "UNKNOWN");
    const resolvedRestoreType = restoreType || getRestoreType(resolvedSourceType);
    const layoutTransform = getRelativeLayoutTransform(selection);
    const fills = readNodeProperty<any[]>(selection, "fills", []);
    const strokes = readNodeProperty<any[]>(selection, "strokes", []);
    const tFS = fillsAndStrokes2Json(fills, strokes);

    const fourCR = {
        tl: readNodeProperty(selection, "topLeftRadius", 0) || 0,
        tr: readNodeProperty(selection, "topRightRadius", 0) || 0,
        bl: readNodeProperty(selection, "bottomLeftRadius", 0) || 0,
        br: readNodeProperty(selection, "bottomRightRadius", 0) || 0
    };

    let resCR: number = readNodeProperty(selection, "cornerRadius", 0) || 0;
    if (String(resCR) === "Symbol(mg.mixed)") resCR = -1;

    const resCS = readNodeProperty(selection, "cornerSmooth", 0) || 0;

    const effectsArray: any[] = [];
    const effects = readNodeProperty<any[]>(selection, "effects", []);
    for (const tE of effects) {
        if (tE.type === "DROP_SHADOW" || tE.type === "INNER_SHADOW") {
            effectsArray.push({
                "type": tE.type,
                "color": cloneRgbaColor(tE.color),
                "offset": cloneVector2(tE.offset),
                "radius": finiteNumber(tE.radius, 0),
                "spread": finiteNumber(tE.spread, 0),
                "visible": tE.isVisible,
                "blendMode": processBlendMode(tE.blendMode)
            });
        } else if (tE.type === 'LAYER_BLUR' || tE.type === 'BACKGROUND_BLUR') {
            effectsArray.push({
                "type": tE.type,
                "radius": finiteNumber(tE.radius, 0),
                "visible": tE.isVisible
            });
        }
    }

    return {
        "type": resolvedRestoreType,
        "sourceType": resolvedSourceType,
        "restoreType": resolvedRestoreType,
        "id": readNodeProperty(selection, "id", ""),
        "name": readNodeProperty(selection, "name", "Untitled"),
        "parentID": safeRead(() => selection.parent && selection.parent.type === "PAGE" ? null : selection.parent?.id, null),
        "constraints": cloneJsonCompatible(readNodeProperty(selection, "constraints", undefined), undefined),
        "exportSettings": cloneJsonCompatible(readNodeProperty<any[]>(selection, "exportSettings", []), []),
        // NOTE: "scence" is a historical typo in the schema that cannot be changed to maintain backwards compatibility
        "scence": {
            "visible": readNodeProperty(selection, "isVisible", true),
            "locked": readNodeProperty(selection, "isLocked", false)
        },
        "blend": {
            "opacity": readNodeProperty(selection, "opacity", 1),
            "isMask": readNodeProperty(selection, "isMask", false) || false,
            "blendMode": processBlendMode(readNodeProperty(selection, "blendMode", "NORMAL")),
            "effects": effectsArray
        },
        "corner": {
            "topLeftRadius": fourCR.tl, "topRightRadius": fourCR.tr,
            "bottomLeftRadius": fourCR.bl, "bottomRightRadius": fourCR.br,
            "cornerRadius": resCR, "cornerSmoothing": resCS
        },
        "geometry": {
            "fills": tFS.fills, "strokes": tFS.strokes,
            "strokeWeight": readNodeProperty(selection, "strokeWeight", 0) || 0,
            "strokeAlign": readNodeProperty(selection, "strokeAlign", "CENTER"),
            "strokeJoin": readNodeProperty(selection, "strokeJoin", "MITER"),
            "dashPattern": cloneJsonCompatible(readNodeProperty<any[]>(selection, "strokeDashes", []), []),
            "strokeCap": readNodeProperty(selection, "strokeCap", "NONE"),
            "strokeTopWeight": ((selection as any).strokeTopWeight !== undefined) ? readNodeProperty(selection, "strokeTopWeight", 0) : undefined,
            "strokeBottomWeight": ((selection as any).strokeBottomWeight !== undefined) ? readNodeProperty(selection, "strokeBottomWeight", 0) : undefined,
            "strokeLeftWeight": ((selection as any).strokeLeftWeight !== undefined) ? readNodeProperty(selection, "strokeLeftWeight", 0) : undefined,
            "strokeRightWeight": ((selection as any).strokeRightWeight !== undefined) ? readNodeProperty(selection, "strokeRightWeight", 0) : undefined,
        },
        "layout": {
            "relativeTransform": layoutTransform,
            "x": layoutTransform[0][2], "y": layoutTransform[1][2],
            "rotation": -readNodeProperty(selection, "rotation", 0) || 0,
            "width": readNodeProperty(selection, "width", 0),
            "height": readNodeProperty(selection, "height", 0),
            "constrainProportions": readNodeProperty(selection, "constrainProportions", false) || false,
            "layoutMode": getLayoutMode(selection as any),
            "itemSpacing": readNodeProperty(selection, "itemSpacing", 0) || 0,
            "paddingLeft": readNodeProperty(selection, "paddingLeft", 0) || 0,
            "paddingRight": readNodeProperty(selection, "paddingRight", 0) || 0,
            "paddingTop": readNodeProperty(selection, "paddingTop", 0) || 0,
            "paddingBottom": readNodeProperty(selection, "paddingBottom", 0) || 0,
            "primaryAxisAlignItems": getAxisAlign(readNodeProperty(selection, "primaryAxisAlignItems", readNodeProperty(selection, "mainAxisAlignItems", "MIN"))),
            "counterAxisAlignItems": getAxisAlign(readNodeProperty(selection, "counterAxisAlignItems", readNodeProperty(selection, "crossAxisAlignItems", "MIN"))),
            "counterAxisAlignContent": getCounterAxisAlignContent(selection as any),
            "primaryAxisSizingMode": readNodeProperty(selection, "primaryAxisSizingMode", readNodeProperty(selection, "mainAxisSizingMode", "FIXED")),
            "counterAxisSizingMode": readNodeProperty(selection, "counterAxisSizingMode", readNodeProperty(selection, "crossAxisSizingMode", "FIXED")),
            "itemReverseZIndex": readNodeProperty(selection, "itemReverseZIndex", false) || false,
            "strokesIncludedInLayout": readNodeProperty(selection, "strokesIncludedInLayout", false) || false,
            "layoutAlign": getLayoutAlign(readNodeProperty(selection, "layoutAlign", readNodeProperty(selection, "alignSelf", "INHERIT"))),
            "layoutGrow": readNodeProperty(selection, "layoutGrow", readNodeProperty(selection, "flexGrow", 0)),
            "layoutPositioning": readNodeProperty(selection, "layoutPositioning", "AUTO")
        }
    };
}
