import { getUniversalProperty, readNodeProperty, cloneJsonCompatible, fillsAndStrokes2Json } from "./universal";

// MasterGo uses concatenated style names that Figma registers with spaces.
// Mapping covers the most common variants; extend as needed.
const FONT_STYLE_NAME_MAP: { [raw: string]: string } = {
    "SemiBold":   "Semi Bold",
    "ExtraBold":  "Extra Bold",
    "ExtraLight": "Extra Light",
    "ExtraBlack": "Extra Black",
    "DemiBold":   "Demi Bold",
    "UltraLight": "Ultra Light",
    "UltraBold":  "Ultra Bold",
    "UltraBlack": "Ultra Black",
};

export function normalizeExportFontName(fontName: any): any {
    if (!fontName) return fontName;
    let { family, style } = fontName;
    // MasterGo "AlibabaPuHuiTi" is registered in Figma as "Alibaba PuHuiTi".
    if (family === "AlibabaPuHuiTi") family = "Alibaba PuHuiTi";
    if (style && FONT_STYLE_NAME_MAP[style]) style = FONT_STYLE_NAME_MAP[style];
    return family === fontName.family && style === fontName.style
        ? fontName
        : { family, style };
}

// Parse a [start, end) character range from a textStyles[] entry. MasterGo's
// exact field naming is host-defined, so we accept the common shapes and bail
// (return null) when none is recognized — callers then skip the segment, which
// keeps single-style/unknown-shape exports byte-identical to the previous
// behavior. NOTE: confirm the real shape against a live MasterGo mixed-style
// text node before relying on per-run fidelity.
export function parseTextStyleRange(entry: any, charLength: number): { start: number; end: number } | null {
    if (!entry || typeof entry !== "object") return null;

    const range = entry.range && typeof entry.range === "object" ? entry.range : entry;
    let start: number | undefined;
    let end: number | undefined;

    if (typeof range.startIndex === "number" && typeof range.endIndex === "number") {
        start = range.startIndex;
        end = range.endIndex;
    } else if (typeof range.start === "number" && typeof range.end === "number") {
        start = range.start;
        end = range.end;
    } else if (typeof range.start === "number" && typeof range.length === "number") {
        start = range.start;
        end = range.start + range.length;
    }

    if (start === undefined || end === undefined) return null;
    start = Math.max(0, Math.floor(start));
    end = Math.min(charLength, Math.floor(end));
    if (!(end > start)) return null;
    return { start, end };
}

export function buildStyledTextSegment(entry: any, range: { start: number; end: number }): any {
    const style = entry.textStyle || {};
    const segment: any = {
        start: range.start,
        end: range.end,
        fontName: normalizeExportFontName(cloneJsonCompatible(style.fontName, undefined)),
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        textCase: style.textCase,
        textDecoration: style.textDecoration,
        letterSpacing: cloneJsonCompatible(style.letterSpacing, style.letterSpacing),
        lineHeight: cloneJsonCompatible(style.lineHeight, style.lineHeight)
    };

    // Per-run color lives at the textStyles ENTRY level (entry.fills), NOT inside
    // entry.textStyle. Convert MasterGo SOLID fills to Figma Paint[] for setRangeFills.
    // MasterGo defaults run fills to blendMode "PASS_THROUGH" which is only valid
    // on layer fills, not on text-range paints — normalize to "NORMAL".
    const runFills = Array.isArray(entry.fills) ? entry.fills : null;
    if (runFills && runFills.length > 0) {
        const normalized = runFills.map((f: any) =>
            f && f.blendMode === "PASS_THROUGH" ? { ...f, blendMode: "NORMAL" } : f
        );
        const fills = fillsAndStrokes2Json(normalized, []).fills;
        if (fills.length > 0) segment.fills = fills;
    }

    return segment;
}

// Build the per-run style array. Only emitted when there are genuinely multiple
// style entries and at least one resolvable range, so single-style text nodes
// are unaffected.
export function buildStyledTextSegments(textStyles: any[] | undefined, charLength: number): any[] | undefined {
    if (!Array.isArray(textStyles) || textStyles.length < 2 || charLength <= 0) return undefined;

    const segments: any[] = [];
    for (const entry of textStyles) {
        const range = parseTextStyleRange(entry, charLength);
        if (!range) continue;
        segments.push(buildStyledTextSegment(entry, range));
    }

    return segments.length > 0 ? segments : undefined;
}

export function transTextNode(selection: any) {
    const universalStruct = getUniversalProperty(selection);
    const textStyles = readNodeProperty<any[]>(selection, "textStyles", []);
    const tempFontName = normalizeExportFontName(cloneJsonCompatible(textStyles?.[0]?.textStyle?.fontName, undefined));

    const style = textStyles?.[0]?.textStyle || {};
    const characters = readNodeProperty(selection, "characters", "");

    const otherStruct: any = {
        "textAlignHorizontal": readNodeProperty(selection, "textAlignHorizontal", "LEFT"),
        "textAlignVertical": readNodeProperty(selection, "textAlignVertical", "TOP"),
        "textAutoResize": readNodeProperty(selection, "textAutoResize", "NONE"),
        "paragraphIndent": 0,
        "paragraphSpacing": readNodeProperty(selection, "paragraphSpacing", 0),
        "autoRename": false,
        "characters": characters,
        "fontSize": style.fontSize,
        "fontName": tempFontName,
        "fontWeight": style.fontWeight,
        "textCase": style.textCase,
        "textDecoration": style.textDecoration,
        "letterSpacing": cloneJsonCompatible(style.letterSpacing, style.letterSpacing),
        "lineHeight": cloneJsonCompatible(style.lineHeight, style.lineHeight),
    };

    const styledTextSegments = buildStyledTextSegments(textStyles, typeof characters === "string" ? characters.length : 0);
    if (styledTextSegments) otherStruct.styledTextSegments = styledTextSegments;

    return Object.assign(otherStruct, universalStruct);
}
