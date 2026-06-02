export function formatDurationMs(ms: number): string {
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
}

export function describeError(error: any): any {
    if (!error) return "Unknown error";
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack ? error.stack.split("\n").slice(0, 5).join("\n") : undefined
        };
    }
    if (typeof error === "object") {
        try {
            return JSON.parse(JSON.stringify(error));
        } catch (_) {
            return String(error);
        }
    }
    return String(error);
}

export function finiteNumber(value: any, fallback = 0): number {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallback;
}


export function safeRead<T>(reader: () => T, fallback: T): T {
    try {
        const value = reader();
        return value !== undefined ? value : fallback;
    } catch (_) {
        return fallback;
    }
}

export function safeSet(node: any, key: string, value: any): boolean {
    try {
        if (node[key] === value) return false;
        node[key] = value;
        return true;
    } catch (e) {
        // Log locally if in debugging or silently ignore to allow fallback restoration
        return false;
    }
}

export function safeResize(node: any, width: number, height: number): boolean {
    try {
        if (node.width === width && node.height === height) return false;
        node.resize(width, height);
        return true;
    } catch (e) {
        return false;
    }
}

export function yieldToEventLoop(): Promise<void> {
    return new Promise<void>(resolve => setTimeout(resolve, 0));
}

export function isOutOfMemoryError(error: any): boolean {
    if (!error) return false;
    const msg = String(error.message || error || "").toLowerCase();
    return msg.includes("out of memory") || msg.includes("oom") || msg.includes("allocation failed");
}

export function cloneJsonCompatible<T>(value: T, fallback: T): T {
    if (value === undefined || value === null) return fallback;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (_) {
        return fallback;
    }
}

export function isSceneNode(node: any): boolean {
    return !!(node && typeof node === "object" && typeof node.type === "string" && node.type !== "DOCUMENT" && node.type !== "PAGE");
}
