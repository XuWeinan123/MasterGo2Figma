import { state } from "./state";

export function getFontKey(family: string, style: string): string {
    return `${family}\n${style}`;
}

export async function ensureAvailableFontsLoaded(): Promise<void> {
    if (state.documentFonts.length === 0) {
        if (state.activeRestoreStats) {
            state.activeRestoreStats.fontListLoadCount++;
        }
        state.documentFonts = await figma.listAvailableFontsAsync();
        rebuildAvailableFontIndex();
        return;
    }

    if (Object.keys(state.availableFontKeys).length === 0) {
        rebuildAvailableFontIndex();
    }
}

export function rebuildAvailableFontIndex(): void {
    state.availableFontKeys = {};
    for (const font of state.documentFonts) {
        state.availableFontKeys[getFontKey(font.fontName.family, font.fontName.style)] = true;
    }
}

export async function loadFontCached(fontName: FontName): Promise<void> {
    const key = getFontKey(fontName.family, fontName.style);
    const existing = state.fontLoadPromises[key];
    if (existing) {
        if (state.activeRestoreStats) {
            state.activeRestoreStats.fontLoadCacheHitCount++;
        }
        await existing;
        return;
    }

    if (state.activeRestoreStats) {
        state.activeRestoreStats.fontLoadRequestCount++;
    }
    const promise = figma.loadFontAsync(fontName).catch(error => {
        delete state.fontLoadPromises[key];
        if (state.activeRestoreStats) {
            state.activeRestoreStats.fontLoadFailureCount++;
        }
        throw error;
    });
    state.fontLoadPromises[key] = promise;
    await promise;
}

export function resolveAvailableFontName(requested: FontName): FontName | null {
    if (state.availableFontKeys[getFontKey(requested.family, requested.style)]) {
        return requested;
    }

    let bestMatch: { fontName: FontName; score: number } | null = null;
    for (const font of state.documentFonts) {
        const fontName = font.fontName;
        const familyScore = getFontFamilyMatchScore(requested.family, fontName.family);
        if (familyScore <= 0) continue;

        const styleScore = getFontStyleMatchScore(requested.style, fontName.style);
        if (styleScore <= 0) continue;

        const score = familyScore + styleScore;
        if (!bestMatch || score > bestMatch.score) {
            bestMatch = { fontName, score };
        }
    }

    return bestMatch ? bestMatch.fontName : null;
}

export function getFontFamilyMatchScore(requestedFamily: string, availableFamily: string): number {
    const requested = normalizeFontFamilyForMatch(requestedFamily);
    const available = normalizeFontFamilyForMatch(availableFamily);
    if (!requested || !available) return 0;
    if (requested === available) return 100;
    if (available.indexOf(requested) === 0 || requested.indexOf(available) === 0) return 80;
    return 0;
}

export function getFontStyleMatchScore(requestedStyle: string, availableStyle: string): number {
    const requested = normalizeFontStyleForMatch(requestedStyle);
    const available = normalizeFontStyleForMatch(availableStyle);
    if (!requested || !available) return 0;
    if (requested === available) return 50;
    return 0;
}

export function normalizeFontFamilyForMatch(value: string): string {
    return String(value || "")
        .toLowerCase()
        .replace(/[\s_-]+/g, "")
        .replace(/[^a-z0-9]/g, "");
}

export function normalizeFontStyleForMatch(value: string): string {
    const normalized = String(value || "")
        .toLowerCase()
        .replace(/[\s_-]+/g, "")
        .replace(/[^a-z0-9]/g, "");

    const aliases: { [style: string]: string } = {
        normal: "regular",
        book: "regular",
        roman: "regular",
        regular: "regular",
        400: "regular",
        medium: "medium",
        500: "medium",
        semibold: "semibold",
        demibold: "semibold",
        600: "semibold",
        bold: "bold",
        700: "bold",
        heavy: "heavy",
        black: "black",
        900: "black",
        light: "light",
        300: "light",
        extralight: "extralight",
        ultralight: "extralight",
        200: "extralight",
        thin: "thin",
        100: "thin"
    };

    return aliases[normalized] || normalized;
}

export function getNearbyAvailableFontsForLog(requested: FontName): FontName[] {
    const requestedFamily = normalizeFontFamilyForMatch(requested.family);
    const nearby: FontName[] = [];

    for (const font of state.documentFonts) {
        const family = normalizeFontFamilyForMatch(font.fontName.family);
        if (
            family.indexOf(requestedFamily) !== -1 ||
            requestedFamily.indexOf(family) !== -1 ||
            familiesShareWords(requested.family, font.fontName.family)
        ) {
            nearby.push(font.fontName);
        }
        if (nearby.length >= 20) break;
    }

    return nearby;
}

export function familiesShareWords(left: string, right: string): boolean {
    const leftWords = splitFontFamilyWords(left);
    const rightWords = splitFontFamilyWords(right);
    let sharedCount = 0;

    for (const word of leftWords) {
        if (rightWords.indexOf(word) !== -1) sharedCount++;
    }

    return sharedCount >= Math.min(2, leftWords.length, rightWords.length);
}

export function splitFontFamilyWords(value: string): string[] {
    return String(value || "")
        .toLowerCase()
        .split(/[\s_-]+/)
        .filter(Boolean);
}
