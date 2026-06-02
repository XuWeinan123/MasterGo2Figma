import { normalizeVectorWindingRule, stripVectorNetworkVertexExtras } from "../../../shared/vectorUtils";
import { normalizeConnectorVectorStrokeCap } from "../../../shared/connectorUtils";

export function normalizeVectorStrokeCap(value: any): string {
    return normalizeConnectorVectorStrokeCap(value);
}

export function applyVectorNetwork(node: VectorNode, vectorNetwork: any, data: any) {
    const normalized = normalizeVectorNetworkForFigma(vectorNetwork);
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

    if (Array.isArray(vectorNetwork.segments)) {
        result.segments = vectorNetwork.segments.map((segment: any) => {
            if (!segment || typeof segment !== "object") return segment;
            const next: any = {};
            for (const key in segment) {
                if (Object.prototype.hasOwnProperty.call(segment, key)) {
                    next[key] = segment[key];
                }
            }
            return next;
        });
    }

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
