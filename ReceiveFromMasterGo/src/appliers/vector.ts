import { normalizeVectorWindingRule, stripVectorNetworkVertexExtras } from "../../../shared/vectorUtils";
import { normalizeConnectorVectorStrokeCap } from "../../../shared/connectorUtils";

export function normalizeVectorStrokeCap(value: any): string {
    return normalizeConnectorVectorStrokeCap(value);
}

export function applyVectorNetwork(node: VectorNode, vectorNetwork: any, data: any) {
    const normalized = normalizeVectorNetworkForFigma(createVectorNetworkWithLayoutBoxAnchors(vectorNetwork, data));
    try {
        node.vectorNetwork = normalized;
        return;
    } catch (error) {
        console.warn("Unable to set vectorNetwork, retrying without vertex stroke caps/corner radii:", data?.name || data?.id || "Untitled", error);
    }

    try {
        node.vectorNetwork = stripVectorNetworkVertexExtras(normalized);
    } catch (fallbackError) {
        console.warn("Unable to set fallback vectorNetwork:", data?.name || data?.id || "Untitled", fallbackError);
    }
}

export function createVectorNetworkWithLayoutBoxAnchors(vectorNetwork: any, data: any): any {
    if (!data?.vectorAutoLayoutBox || !vectorNetwork || typeof vectorNetwork !== "object") return vectorNetwork;
    const width = Number(data?.layout?.width);
    const height = Number(data?.layout?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return vectorNetwork;

    const vertices = Array.isArray(vectorNetwork.vertices) ? vectorNetwork.vertices.slice() : [];
    const segments = Array.isArray(vectorNetwork.segments) ? vectorNetwork.segments.slice() : [];
    const startIndex = vertices.length;
    vertices.push(
        { x: 0, y: 0, strokeCap: "NONE" },
        { x: width, y: height, strokeCap: "NONE" }
    );
    segments.push(
        { start: startIndex, end: startIndex, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } },
        { start: startIndex + 1, end: startIndex + 1, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } }
    );

    return {
        ...vectorNetwork,
        vertices,
        segments
    };
}

export function normalizeVectorNetworkForFigma(vectorNetwork: any): any {
    if (!vectorNetwork || typeof vectorNetwork !== "object") return vectorNetwork;

    const result: any = {};
    for (const key in vectorNetwork) {
        if (Object.prototype.hasOwnProperty.call(vectorNetwork, key)) {
            result[key] = vectorNetwork[key];
        }
    }

    if (Array.isArray(vectorNetwork.vertices)) {
        result.vertices = vectorNetwork.vertices.map((vertex: any) => {
            if (!vertex || typeof vertex !== "object") return vertex;
            const next: any = {};
            for (const key in vertex) {
                if (Object.prototype.hasOwnProperty.call(vertex, key)) {
                    next[key] = vertex[key];
                }
            }
            if (next.strokeCap !== undefined) {
                next.strokeCap = normalizeVectorStrokeCap(next.strokeCap);
            }
            return next;
        });
    }

    // segments need no normalization — the previous per-segment shallow copy
    // changed nothing (input is plain parsed JSON, and the vectorNetwork setter
    // copies internally), so the reference from the top-level copy is kept.

    if (Array.isArray(vectorNetwork.regions)) {
        result.regions = vectorNetwork.regions.map((region: any) => {
            if (!region || typeof region !== "object") return region;
            const next: any = {};
            for (const key in region) {
                if (Object.prototype.hasOwnProperty.call(region, key)) {
                    next[key] = region[key];
                }
            }
            next.windingRule = normalizeVectorWindingRule(next.windingRule);
            if (Array.isArray(region.loops)) {
                next.loops = region.loops.map((loop: any) => {
                    if (!Array.isArray(loop)) return loop;
                    return loop
                        .map((value: any) => Number(value))
                        .filter((value: number) => Number.isFinite(value));
                });
            }
            return next;
        });
    }

    return result;
}
