import { state } from "../state";
import { safeSet, isSceneNode } from "../../../shared/utils";
import { 
    createConnectorRoutePoints, getConnectorCornerRadius, 
    normalizeConnectorVectorStrokeCap 
} from "../../../shared/connectorUtils";

export function normalizeConnectorMagnet(value: any) {
    if (value === "TOP" || value === "LEFT" || value === "BOTTOM" || value === "RIGHT" || value === "NONE" || value === "AUTO") {
        return value;
    }
    return null;
}

export function resolveConnectorEndpointNodeId(sourceId: any, allowExistingFallback: boolean): string | null {
    if (typeof sourceId !== "string" || !sourceId) return null;
    if (state.restoredNodeIdBySourceId[sourceId]) {
        return state.restoredNodeIdBySourceId[sourceId];
    }
    if (!allowExistingFallback) return null;

    try {
        const existing = figma.getNodeById(sourceId);
        if (existing && isSceneNode(existing)) return existing.id;
    } catch (error) {}

    return null;
}

export function hasUnresolvedConnectorEndpoint(endpoint: any): boolean {
    return !!(endpoint && endpoint.endpointNodeId && !resolveConnectorEndpointNodeId(endpoint.endpointNodeId, false));
}

export function normalizeConnectorStrokeCap(value: any) {
    if (value === "ARROW_EQUILATERAL" ||
        value === "ARROW_LINES" ||
        value === "TRIANGLE_FILLED" ||
        value === "DIAMOND_FILLED" ||
        value === "CIRCLE_FILLED" ||
        value === "NONE") {
        return value;
    }

    if (value === "LINE_ARROW" || value === "LINE") return "ARROW_LINES";
    if (value === "TRIANGLE_ARROW") return "ARROW_EQUILATERAL";
    if (value === "DIAMOND") return "DIAMOND_FILLED";
    if (value === "ROUND_ARROW" || value === "RING") return "CIRCLE_FILLED";
    return "NONE";
}

export function normalizeConnectorPosition(position: any) {
    if (!position || typeof position !== "object") return null;
    return {
        x: Number(position.x) || 0,
        y: Number(position.y) || 0
    };
}

export function getParentAbsoluteOrigin(parent: PageNode | SceneNode) {
    if (!parent || parent.type === "PAGE") return { x: 0, y: 0 };
    const transform = (parent as any).absoluteTransform;
    if (transform && transform[0] && transform[1]) {
        return {
            x: Number(transform[0][2]) || 0,
            y: Number(transform[1][2]) || 0
        };
    }
    return {
        x: Number((parent as any).x) || 0,
        y: Number((parent as any).y) || 0
    };
}

export function getConnectorLocalPoint(data: any, parent: PageNode | SceneNode | null, isStart: boolean) {
    const localKey = isStart ? "connectorStartLocal" : "connectorEndLocal";
    const localPoint = normalizeConnectorPosition(data[localKey]);
    if (localPoint) return localPoint;

    const endpoint = isStart ? data.connectorStart : data.connectorEnd;
    const absolutePoint = normalizeConnectorPosition(endpoint && endpoint.position);
    if (absolutePoint && parent && data.layout) {
        const parentOrigin = getParentAbsoluteOrigin(parent);
        return {
            x: absolutePoint.x - parentOrigin.x - (Number(data.layout.x) || 0),
            y: absolutePoint.y - parentOrigin.y - (Number(data.layout.y) || 0)
        };
    }

    const layout = data.layout || {};
    return isStart
        ? { x: 0, y: 0 }
        : { x: Number(layout.width) || 0, y: Number(layout.height) || 0 };
}

export function createConnectorVectorNetworkFromData(data: any, parent: PageNode | SceneNode | null) {
    const start = getConnectorLocalPoint(data, parent, true);
    const end = getConnectorLocalPoint(data, parent, false);
    const points = createConnectorRoutePoints(
        start,
        end,
        data.connectorStart,
        data.connectorEnd,
        data.connectorLineType || "ELBOWED"
    );

    const vertices = points.map((point, index) => {
        const vertex: any = { x: point.x, y: point.y };
        if (index === 0) {
            vertex.strokeCap = normalizeConnectorVectorStrokeCap(data.connectorStartStrokeCap || "NONE");
        }
        if (index === points.length - 1) {
            vertex.strokeCap = normalizeConnectorVectorStrokeCap(data.connectorEndStrokeCap || "NONE");
        }
        if (index > 0 && index < points.length - 1) {
            const radius = getConnectorCornerRadius(points, index, data.connectorCornerRadius ?? data.corner?.cornerRadius ?? 0);
            if (radius > 0) vertex.cornerRadius = radius;
        }
        return vertex;
    });

    const segments: any[] = [];
    for (let index = 0; index < points.length - 1; index++) {
        segments.push({ start: index, end: index + 1, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } });
    }

    return { vertices, segments, regions: [] };
}

export function normalizeConnectorEndpointForFigma(endpoint: any, allowExistingFallback: boolean) {
    if (!endpoint || typeof endpoint !== "object") return null;

    const endpointNodeId = resolveConnectorEndpointNodeId(endpoint.endpointNodeId, allowExistingFallback);
    const position = normalizeConnectorPosition(endpoint.position);
    if (endpointNodeId) {
        const magnet = normalizeConnectorMagnet(endpoint.magnet);
        if (magnet) return { endpointNodeId, magnet };
        if (position) return { endpointNodeId, position };
        return { endpointNodeId, magnet: "AUTO" };
    }

    if (position) return { position };
    return null;
}

export function applyConnectorProperties(node: ConnectorNode, data: any, deferUnresolved: boolean) {
    safeSet(node, "connectorLineType", data.connectorLineType || "ELBOWED");
    safeSet(node, "cornerRadius", data.connectorCornerRadius ?? data.corner?.cornerRadius);

    if (data.connectorStartStrokeCap) {
        safeSet(node, "connectorStartStrokeCap", normalizeConnectorStrokeCap(data.connectorStartStrokeCap));
    }
    if (data.connectorEndStrokeCap) {
        safeSet(node, "connectorEndStrokeCap", normalizeConnectorStrokeCap(data.connectorEndStrokeCap));
    }

    const start = normalizeConnectorEndpointForFigma(data.connectorStart, !deferUnresolved);
    const end = normalizeConnectorEndpointForFigma(data.connectorEnd, !deferUnresolved);
    if (start) safeSet(node, "connectorStart", start);
    if (end) safeSet(node, "connectorEnd", end);

    if (deferUnresolved && (hasUnresolvedConnectorEndpoint(data.connectorStart) || hasUnresolvedConnectorEndpoint(data.connectorEnd))) {
        state.deferredConnectorRestores.push({ node, data });
    }
}

export function applyDeferredConnectorRestores() {
    if (state.deferredConnectorRestores.length === 0) return;

    const deferred = state.deferredConnectorRestores;
    state.deferredConnectorRestores = [];
    for (const item of deferred) {
        if (!item.node || (item.node as any).removed) continue;
        applyConnectorProperties(item.node, item.data, false);
    }
}
