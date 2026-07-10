import { state } from "../state";
import { 
    resolveAvailableFontName, ensureAvailableFontsLoaded, 
    loadFontCached, getFontKey, getNearbyAvailableFontsForLog,
    normalizeFontFamilyForMatch
} from "../fontLoader";
import { MissingFontTextRestoreResult, MissingFontTextRestoreTarget } from "../../../shared/types";

const MISSING_FONT_NAME_PREFIX_PATTERN = /^\[Font Missing\]\[([^\]]+)\]\[([^\]]+)\]\s*/;

export async function applyTextProperties(node: TextNode, data: any) {
    if (state.activeRestoreStats) {
        state.activeRestoreStats.textNodeCount++;
    }
    await ensureAvailableFontsLoaded();

    const family = data.fontName?.family || "Inter";
    const style = data.fontName?.style || "Regular";
    const requestedFontName = { family, style };
    const resolvedFontName = resolveAvailableFontName(requestedFontName);

    await loadFontCached({ family: "Inter", style: "Regular" });
    if (resolvedFontName) {
        await loadFontCached(resolvedFontName);
    } else {
        node.name = "[Font Missing][" + family + "][" + style + "] " + node.name;
    }

    // Core text state must succeed or the caller can roll back the node.
    node.fontName = resolvedFontName || { family: "Inter", style: "Regular" };
    node.characters = data.characters || "";
    node.fontSize = Number.isFinite(data.fontSize) && data.fontSize > 0 ? data.fontSize : 12;

    // Figma rejects some values depending on the installed font/version. These
    // are formatting refinements, so one bad optional field must not remove the
    // entire text node from an otherwise valid import.
    trySetText(() => { node.textAlignHorizontal = data.textAlignHorizontal || "LEFT"; });
    trySetText(() => { node.textAlignVertical = data.textAlignVertical || "TOP"; });
    trySetText(() => { node.textAutoResize = data.textAutoResize || "NONE"; });
    trySetText(() => { node.paragraphIndent = data.paragraphIndent || 0; });
    trySetText(() => { node.paragraphSpacing = data.paragraphSpacing || 0; });
    trySetText(() => { node.autoRename = data.autoRename || false; });
    if (data.textCase) trySetText(() => { node.textCase = data.textCase; });
    if (data.textDecoration) trySetText(() => { node.textDecoration = data.textDecoration; });
    if (data.letterSpacing !== undefined) trySetText(() => { node.letterSpacing = data.letterSpacing; });
    if (data.lineHeight !== undefined) trySetText(() => { node.lineHeight = data.lineHeight; });

    if (Array.isArray(data.styledTextSegments) && data.styledTextSegments.length > 0) {
        await applyStyledTextSegments(node, data.styledTextSegments);
    }
}

// Apply per-run (mixed-style) formatting via setRange* APIs. Every distinct
// run font is resolved and loaded BEFORE any range setter runs (Figma requires
// the font to be loaded before setRangeFontName). Each setter is guarded so a
// single bad range never aborts the whole text node.
export async function applyStyledTextSegments(node: TextNode, segments: any[]) {
    const charLength = node.characters.length;

    // Resolve + preload every distinct run font first.
    const resolvedByKey: { [key: string]: FontName | null } = {};
    for (const segment of segments) {
        if (!segment || !segment.fontName) continue;
        const key = getFontKey(segment.fontName.family, segment.fontName.style);
        if (key in resolvedByKey) continue;
        const resolved = resolveAvailableFontName(segment.fontName);
        resolvedByKey[key] = resolved;
        if (resolved) {
            try {
                await loadFontCached(resolved);
            } catch (error) {
                resolvedByKey[key] = null;
                console.warn("Unable to load run font for styled text:", segment.fontName, error);
            }
        }
    }

    for (const segment of segments) {
        if (!segment) continue;
        const start = Math.max(0, Math.floor(segment.start ?? 0));
        const end = Math.min(charLength, Math.floor(segment.end ?? 0));
        if (!(end > start)) continue;

        const fontKey = segment.fontName ? getFontKey(segment.fontName.family, segment.fontName.style) : "";
        const resolvedFont = fontKey ? resolvedByKey[fontKey] : null;

        if (resolvedFont) trySetRange(() => node.setRangeFontName(start, end, resolvedFont));
        if (typeof segment.fontSize === "number") trySetRange(() => node.setRangeFontSize(start, end, segment.fontSize));
        if (Array.isArray(segment.fills) && segment.fills.length > 0) {
            trySetRange(() => node.setRangeFills(start, end, segment.fills));
        }
        if (segment.textCase) trySetRange(() => node.setRangeTextCase(start, end, segment.textCase));
        if (segment.textDecoration) trySetRange(() => node.setRangeTextDecoration(start, end, segment.textDecoration));
        if (segment.letterSpacing !== undefined) trySetRange(() => node.setRangeLetterSpacing(start, end, segment.letterSpacing));
        if (segment.lineHeight !== undefined) trySetRange(() => node.setRangeLineHeight(start, end, segment.lineHeight));
    }
}

function trySetRange(fn: () => void) {
    try {
        fn();
    } catch (error) {
        // A single malformed range/value must not abort the rest of the text node.
    }
}

function trySetText(fn: () => void) {
    try {
        fn();
    } catch (_) {
        // Optional text formatting is intentionally best-effort.
    }
}

export function parseMissingFontTextLayerName(name: string) {
    const match = MISSING_FONT_NAME_PREFIX_PATTERN.exec(name);
    if (!match) return null;

    return {
        family: match[1],
        style: match[2],
        restoredName: name.slice(match[0].length)
    };
}

export function logMissingFontRestoreTargets(targets: MissingFontTextRestoreTarget[]) {
    const requestedToResolved: { [key: string]: { requested: FontName; resolved: FontName | null; count: number } } = {};
    for (const target of targets) {
        if (!requestedToResolved[target.requestedFontKey]) {
            requestedToResolved[target.requestedFontKey] = {
                requested: target.requestedFontName,
                resolved: target.resolvedFontName,
                count: 0
            };
        }
        requestedToResolved[target.requestedFontKey].count++;
    }

    const resolutions = Object.keys(requestedToResolved).map(key => requestedToResolved[key]);

    for (const item of resolutions) {
        if (item.resolved) continue;
        console.warn("[MasterGo2Figma] No available font match for missing font", {
            requested: item.requested,
            nearbyAvailableFonts: getNearbyAvailableFontsForLog(item.requested)
        });
    }
}

export async function restoreMissingFontTextLayers(pages: PageNode[]): Promise<MissingFontTextRestoreResult> {
    const result: MissingFontTextRestoreResult = {
        scannedTextNodeCount: 0,
        candidateTextNodeCount: 0,
        manuallyResolvedTextNodeCount: 0,
        restoredTextNodeCount: 0,
        failedTextNodeCount: 0,
        loadedFontCount: 0,
        failedFontCount: 0,
        missingFonts: []
    };
    const targets: MissingFontTextRestoreTarget[] = [];
    await ensureAvailableFontsLoaded();

    for (const page of pages) {
        const textNodes = page.findAll(node => node.type === "TEXT") as TextNode[];
        result.scannedTextNodeCount += textNodes.length;

        for (const node of textNodes) {
            const parsed = parseMissingFontTextLayerName(node.name);
            if (!parsed) continue;
            result.candidateTextNodeCount++;

            if (textNodeUsesNonInterFont(node)) {
                node.name = parsed.restoredName;
                result.manuallyResolvedTextNodeCount++;
                continue;
            }

            const requestedFontName = { family: parsed.family, style: parsed.style };
            const resolvedFontName = resolveAvailableFontName(requestedFontName);
            targets.push({
                node,
                requestedFontName,
                resolvedFontName,
                restoredName: parsed.restoredName,
                requestedFontKey: getFontKey(parsed.family, parsed.style),
                resolvedFontKey: resolvedFontName ? getFontKey(resolvedFontName.family, resolvedFontName.style) : ""
            });
        }
    }

    if (targets.length === 0) return result;

    logMissingFontRestoreTargets(targets);

    const fontLoadState = new Map<string, boolean>();
    const failedFontsByKey: { [key: string]: { family: string; style: string; count: number } } = {};
    for (const target of targets) {
        if (!target.resolvedFontName) {
            result.failedTextNodeCount++;
            recordFailedMissingFont(failedFontsByKey, target.requestedFontName);
            continue;
        }

        if (!fontLoadState.has(target.resolvedFontKey)) {
            try {
                await loadFontCached(target.resolvedFontName);
                fontLoadState.set(target.resolvedFontKey, true);
                result.loadedFontCount++;
            } catch (error) {
                fontLoadState.set(target.resolvedFontKey, false);
                result.failedFontCount++;
                console.warn("Unable to restore missing font:", {
                    requested: target.requestedFontName,
                    resolved: target.resolvedFontName
                }, error);
            }
        }

        if (!fontLoadState.get(target.resolvedFontKey)) {
            result.failedTextNodeCount++;
            recordFailedMissingFont(failedFontsByKey, target.requestedFontName);
            continue;
        }

        try {
            target.node.fontName = target.resolvedFontName;
            target.node.name = target.restoredName;
            result.restoredTextNodeCount++;
        } catch (error) {
            result.failedTextNodeCount++;
            recordFailedMissingFont(failedFontsByKey, target.requestedFontName);
            console.warn("Unable to apply restored font:", target.node.name, {
                requested: target.requestedFontName,
                resolved: target.resolvedFontName
            }, error);
        }
    }

    result.missingFonts = Object.keys(failedFontsByKey)
        .map(key => failedFontsByKey[key])
        .sort((a, b) => `${a.family} ${a.style}`.localeCompare(`${b.family} ${b.style}`));
    return result;
}

function textNodeUsesNonInterFont(node: TextNode): boolean {
    const fontName = node.fontName;
    if (isNonInterFontName(fontName)) return true;

    const textLength = node.characters.length;
    const getRangeAllFontNames = (node as any).getRangeAllFontNames;
    if (textLength <= 0 || typeof getRangeAllFontNames !== "function") return false;

    try {
        const rangeFonts = getRangeAllFontNames.call(node, 0, textLength) as FontName[];
        return Array.isArray(rangeFonts) && rangeFonts.some(isNonInterFontName);
    } catch (_) {
        return false;
    }
}

function isNonInterFontName(fontName: FontName | typeof figma.mixed): boolean {
    if (!fontName || fontName === figma.mixed) return false;
    return normalizeFontFamilyForMatch(fontName.family) !== "inter";
}

function recordFailedMissingFont(
    failedFontsByKey: { [key: string]: { family: string; style: string; count: number } },
    fontName: { family: string; style: string }
) {
    const key = getFontKey(fontName.family, fontName.style);
    if (!failedFontsByKey[key]) {
        failedFontsByKey[key] = {
            family: fontName.family,
            style: fontName.style,
            count: 0
        };
    }
    failedFontsByKey[key].count++;
}
