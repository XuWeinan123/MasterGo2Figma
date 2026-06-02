export function normalizeVectorWindingRule(value: any): "EVENODD" | "NONZERO" {
    if (value === "Evenodd" || value === "EVENODD") return "EVENODD";
    if (value === "Nonzero" || value === "NONZERO") return "NONZERO";
    return "NONZERO";
}

export function normalizeVectorWindingRuleForFigma(value: any): "EVENODD" | "NONZERO" {
    return normalizeVectorWindingRule(value);
}

export function stripVectorNetworkVertexExtras(vectorNetwork: any): any {
    if (!vectorNetwork || typeof vectorNetwork !== "object" || !Array.isArray(vectorNetwork.vertices)) return vectorNetwork;

    const result: any = {};
    for (const key in vectorNetwork) {
        if (Object.prototype.hasOwnProperty.call(vectorNetwork, key)) {
            result[key] = vectorNetwork[key];
        }
    }
    result.vertices = vectorNetwork.vertices.map((vertex: any) => {
        if (!vertex || typeof vertex !== "object") return vertex;
        const next: any = {};
        for (const key in vertex) {
            if (Object.prototype.hasOwnProperty.call(vertex, key)) {
                if (key === "strokeCap" || key === "cornerRadius") {
                    next[key] = vertex[key];
                } else if (key === "x" || key === "y") {
                    next[key] = Number(vertex[key]) || 0;
                }
            }
        }
        return next;
    });

    return result;
}
