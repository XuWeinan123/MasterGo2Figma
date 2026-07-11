// Render-truth recovery for radial gradients via the node's SVG export.
//
// MasterGo's plugin API exposes radial/angular/diamond gradients as two
// handles plus a transform built from the FOLDED axis ratio
// min(r, 2·|major|/r); whenever r² > 2·|major| that transform disagrees with
// MasterGo's own renderer and the fold is not invertible, so the true ratio
// cannot be recovered from the API paint alone (see docs/MG_DECODER.md).
// The SVG export, however, is produced by the renderer and carries the true
// gradient ellipse in its <radialGradient gradientTransform>.
//
// Only the gradientTransform matrix, the unit mode, and the node's aspect
// ratio matter for the minor/major RATIO: translations (viewBox stroke
// padding) and uniform export scales cancel out, which keeps this robust
// against SVG serialization details. Zero dependencies so tests can compile
// this module standalone.

export interface SvgRadialGradient {
    stops: Array<{ position: number; color: { r: number; g: number; b: number; a: number } }>;
    matrix: number[][]; // 2x3 gradientTransform, identity when absent
    objectBoundingBox: boolean;
    used?: boolean;
}

const IDENTITY: number[][] = [[1, 0, 0], [0, 1, 0]];

function parseSvgColor(raw: string | undefined): { r: number; g: number; b: number } | null {
    if (!raw) return null;
    const text = raw.trim().toLowerCase();
    if (text === "white") return { r: 1, g: 1, b: 1 };
    if (text === "black") return { r: 0, g: 0, b: 0 };
    let m = /^#([0-9a-f]{3})$/.exec(text);
    if (m) {
        const h = m[1];
        return {
            r: parseInt(h[0] + h[0], 16) / 255,
            g: parseInt(h[1] + h[1], 16) / 255,
            b: parseInt(h[2] + h[2], 16) / 255
        };
    }
    m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(text);
    if (m) {
        return {
            r: parseInt(m[1].slice(0, 2), 16) / 255,
            g: parseInt(m[1].slice(2, 4), 16) / 255,
            b: parseInt(m[1].slice(4, 6), 16) / 255
        };
    }
    m = /^rgba?\(([^)]+)\)$/.exec(text);
    if (m) {
        const parts = m[1].split(",").map(part => part.trim());
        if (parts.length >= 3) {
            const channel = (value: string) => value.endsWith("%")
                ? parseFloat(value) / 100
                : parseFloat(value) / 255;
            return { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]) };
        }
    }
    return null;
}

function parseSvgTransform(raw: string | undefined): number[][] | null {
    if (!raw) return IDENTITY;
    let result = IDENTITY;
    const re = /(matrix|translate|scale)\s*\(([^)]*)\)/g;
    let m: RegExpExecArray | null;
    let any = false;
    const mul = (a: number[][], b: number[][]) => [
        [a[0][0] * b[0][0] + a[0][1] * b[1][0], a[0][0] * b[0][1] + a[0][1] * b[1][1], a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2]],
        [a[1][0] * b[0][0] + a[1][1] * b[1][0], a[1][0] * b[0][1] + a[1][1] * b[1][1], a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2]]
    ];
    while ((m = re.exec(raw))) {
        const args = m[2].split(/[\s,]+/).filter(Boolean).map(Number);
        if (args.some(v => !Number.isFinite(v))) return null;
        let step: number[][] | null = null;
        if (m[1] === "matrix" && args.length === 6) {
            step = [[args[0], args[2], args[4]], [args[1], args[3], args[5]]];
        } else if (m[1] === "translate" && args.length >= 1) {
            step = [[1, 0, args[0]], [0, 1, args.length > 1 ? args[1] : 0]];
        } else if (m[1] === "scale" && args.length >= 1) {
            step = [[args[0], 0, 0], [0, args.length > 1 ? args[1] : args[0], 0]];
        }
        if (!step) return null;
        result = mul(result, step);
        any = true;
    }
    return any ? result : IDENTITY;
}

function parseAttributes(tag: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const re = /([A-Za-z_][\w:-]*)\s*=\s*"([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tag))) attrs[m[1].toLowerCase()] = m[2];
    return attrs;
}

function parseStops(body: string): SvgRadialGradient["stops"] {
    const stops: SvgRadialGradient["stops"] = [];
    const re = /<stop\b[^>]*>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
        const attrs = parseAttributes(m[0]);
        const style = attrs["style"] || "";
        const styleGet = (key: string) => {
            const sm = new RegExp(key + "\\s*:\\s*([^;\"]+)").exec(style);
            return sm ? sm[1].trim() : undefined;
        };
        const rawOffset = attrs["offset"] || styleGet("offset") || "0";
        const offset = rawOffset.endsWith("%") ? parseFloat(rawOffset) / 100 : parseFloat(rawOffset);
        const color = parseSvgColor(attrs["stop-color"] || styleGet("stop-color"));
        const rawOpacity = attrs["stop-opacity"] || styleGet("stop-opacity");
        const opacity = rawOpacity === undefined ? 1 : parseFloat(rawOpacity);
        if (!color || !Number.isFinite(offset)) continue;
        stops.push({
            position: Math.min(1, Math.max(0, offset)),
            color: { r: color.r, g: color.g, b: color.b, a: Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1 }
        });
    }
    return stops;
}

export function parseSvgRadialGradients(svg: string): SvgRadialGradient[] {
    if (!svg || typeof svg !== "string") return [];
    const results: SvgRadialGradient[] = [];
    const stopsById: Record<string, SvgRadialGradient["stops"]> = {};
    // Linear gradients can host shared stop lists referenced via href.
    const anyGradRe = /<(radialGradient|linearGradient)\b([^>]*)>([\s\S]*?)<\/\1>/g;
    let m: RegExpExecArray | null;
    interface Pending { attrs: Record<string, string>; stops: SvgRadialGradient["stops"]; }
    const pendingRadials: Pending[] = [];
    while ((m = anyGradRe.exec(svg))) {
        const attrs = parseAttributes(m[2]);
        const stops = parseStops(m[3]);
        if (attrs["id"] && stops.length) stopsById[attrs["id"]] = stops;
        if (m[1] === "radialGradient") pendingRadials.push({ attrs, stops });
    }
    // Self-closing radialGradients (stops via href only).
    const selfClosedRe = /<radialGradient\b([^>]*)\/>/g;
    while ((m = selfClosedRe.exec(svg))) {
        pendingRadials.push({ attrs: parseAttributes(m[1]), stops: [] });
    }
    for (const pending of pendingRadials) {
        let stops = pending.stops;
        if (!stops.length) {
            const href = pending.attrs["href"] || pending.attrs["xlink:href"];
            const refId = href && href.charAt(0) === "#" ? href.slice(1) : null;
            if (refId && stopsById[refId]) stops = stopsById[refId];
        }
        if (stops.length < 2) continue;
        const matrix = parseSvgTransform(pending.attrs["gradienttransform"]);
        if (!matrix) continue;
        // SVG default is objectBoundingBox when the attribute is absent.
        const units = (pending.attrs["gradientunits"] || "objectBoundingBox").toLowerCase();
        results.push({
            stops: stops,
            matrix: matrix,
            objectBoundingBox: units !== "userspaceonuse"
        });
    }
    return results;
}

export function svgStopsMatchPaintStops(
    svgStops: SvgRadialGradient["stops"],
    paintStops: Array<{ position: number; color: { r: number; g: number; b: number; a?: number } }>
): boolean {
    if (!Array.isArray(paintStops) || svgStops.length !== paintStops.length) return false;
    for (let i = 0; i < svgStops.length; i++) {
        const a = svgStops[i], b = paintStops[i];
        if (!b || !b.color) return false;
        if (Math.abs(a.position - (b.position || 0)) > 0.015) return false;
        if (Math.abs(a.color.r - b.color.r) > 0.02 ||
            Math.abs(a.color.g - b.color.g) > 0.02 ||
            Math.abs(a.color.b - b.color.b) > 0.02 ||
            Math.abs(a.color.a - (b.color.a === undefined ? 1 : b.color.a)) > 0.02) return false;
    }
    return true;
}

// Minor/major ratio of the gradient ellipse relative to the handle axis, in
// node-normalized space. `u` is the major-axis handle vector p1 − p0
// (normalized coordinates). Returns null when the SVG matrix is singular or
// the ellipse is inconsistent with the handles.
//
// MasterGo's SVG exporter writes the two ellipse radii into SWAPPED slots
// (the along-handle radius lands on the perpendicular axis and vice versa) —
// verified on the 0711-1 Tesla fixture where the as-written reading yields
// 0.2006 while the swapped reading yields the render-true 3.5696 (and 1.1976
// for Rectangle 5, matching the .mg scalar exactly). Rather than hard-coding
// the swap, both readings are computed and arbitrated by the gradient-model
// invariant "along-axis radius == |p1 − p0|": whichever reading satisfies it
// wins, so a spec-conforming SVG (should MasterGo ever fix their exporter)
// resolves identically. If neither reading is consistent (e.g. a scaled
// viewport), return null and let the caller keep the folded API transform.
export function svgRadialAxisRatio(
    gradient: SvgRadialGradient,
    nodeWidth: number,
    nodeHeight: number,
    u: { x: number; y: number }
): number | null {
    const uLen = Math.sqrt(u.x * u.x + u.y * u.y);
    if (!(uLen > 0) || !(nodeWidth > 0) || !(nodeHeight > 0)) return null;
    const g = gradient.matrix;
    const det = g[0][0] * g[1][1] - g[0][1] * g[1][0];
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
    // A = inv(G_lin) maps gradient-viewport space → unit-circle space.
    // userSpaceOnUse coordinates are node pixels, objectBoundingBox
    // coordinates are already bbox fractions (== node-normalized for a leaf
    // shape), so the viewport axis scales are (w,h) or (1,1) respectively.
    const ia = g[1][1] / det, ib = -g[0][1] / det;
    const ic = -g[1][0] / det, id = g[0][0] / det;
    const w = gradient.objectBoundingBox ? 1 : nodeWidth;
    const h = gradient.objectBoundingBox ? 1 : nodeHeight;
    // Handle direction in viewport space (handles are normalized coords).
    let dx = u.x * w, dy = u.y * h;
    const dLen = Math.sqrt(dx * dx + dy * dy);
    if (!(dLen > 0)) return null;
    dx /= dLen; dy /= dLen;
    const px = -dy, py = dx; // perpendicular unit direction (viewport space)
    // Ellipse radius along a viewport unit direction: 1 / |A·d̂|. This is the
    // principal radius when d̂ is a principal axis — true for consistent
    // emissions and for the swapped emission (the axes stay put, only the
    // radii trade places).
    const radiusAlong = (vx: number, vy: number) => {
        const qx = ia * vx + ib * vy;
        const qy = ic * vx + id * vy;
        const q = Math.sqrt(qx * qx + qy * qy);
        return q > 0 ? 1 / q : NaN;
    };
    // Normalized length of a viewport-space radius along direction (vx,vy).
    const normalizedLength = (radius: number, vx: number, vy: number) => {
        return radius * Math.sqrt((vx / w) * (vx / w) + (vy / h) * (vy / h));
    };
    const alongRadius = radiusAlong(dx, dy);
    const perpRadius = radiusAlong(px, py);
    if (!Number.isFinite(alongRadius) || !Number.isFinite(perpRadius)) return null;
    const candidates = [
        { along: normalizedLength(alongRadius, dx, dy), perp: normalizedLength(perpRadius, px, py) },
        { along: normalizedLength(perpRadius, dx, dy), perp: normalizedLength(alongRadius, px, py) } // swapped slots
    ];
    for (const candidate of candidates) {
        if (!(candidate.along > 0) || !Number.isFinite(candidate.perp)) continue;
        if (Math.abs(candidate.along - uLen) <= 0.05 * uLen) {
            const ratio = candidate.perp / candidate.along;
            return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
        }
    }
    return null;
}
