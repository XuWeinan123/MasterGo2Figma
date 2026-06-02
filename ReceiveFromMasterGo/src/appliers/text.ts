import { state } from "../state";
import { 
    resolveAvailableFontName, ensureAvailableFontsLoaded, 
    loadFontCached, getFontKey, getNearbyAvailableFontsForLog 
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

    node.textAlignHorizontal = data.textAlignHorizontal || "LEFT";
    node.textAlignVertical = data.textAlignVertical || "TOP";
    node.textAutoResize = data.textAutoResize || "NONE";
    node.paragraphIndent = data.paragraphIndent || 0;
    node.paragraphSpacing = data.paragraphSpacing || 0;
    node.autoRename = data.autoRename || false;
    node.fontSize = data.fontSize || 12;
    node.fontName = resolvedFontName || { family: "Inter", style: "Regular" };
    node.characters = data.characters || "";
    if (data.textCase) node.textCase = data.textCase;
    if (data.textDecoration) node.textDecoration = data.textDecoration;
    if (data.letterSpacing !== undefined) node.letterSpacing = data.letterSpacing;
    if (data.lineHeight !== undefined) node.lineHeight = data.lineHeight;
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
    console.log("[MasterGo2Figma] Missing font restore targets", resolutions);

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
        restoredTextNodeCount: 0,
        failedTextNodeCount: 0,
        loadedFontCount: 0,
        failedFontCount: 0
    };
    const targets: MissingFontTextRestoreTarget[] = [];
    await ensureAvailableFontsLoaded();

    for (const page of pages) {
        const textNodes = page.findAll(node => node.type === "TEXT") as TextNode[];
        result.scannedTextNodeCount += textNodes.length;

        for (const node of textNodes) {
            const parsed = parseMissingFontTextLayerName(node.name);
            if (!parsed) continue;
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

    result.candidateTextNodeCount = targets.length;
    if (targets.length === 0) return result;

    logMissingFontRestoreTargets(targets);

    const fontLoadState = new Map<string, boolean>();
    for (const target of targets) {
        if (!target.resolvedFontName) {
            result.failedTextNodeCount++;
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
            continue;
        }

        try {
            target.node.fontName = target.resolvedFontName;
            target.node.name = target.restoredName;
            result.restoredTextNodeCount++;
        } catch (error) {
            result.failedTextNodeCount++;
            console.warn("Unable to apply restored font:", target.node.name, {
                requested: target.requestedFontName,
                resolved: target.resolvedFontName
            }, error);
        }
    }

    console.log("[MasterGo2Figma] Missing font restore", result);
    return result;
}
