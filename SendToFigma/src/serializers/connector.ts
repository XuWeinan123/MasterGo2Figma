import { getUniversalProperty, safeRead } from "./universal";
import { createConnectorVectorNetwork } from "../../../shared/connectorUtils";

export function normalizeConnectorEndpoint(endpoint: any) {
    if (!endpoint || typeof endpoint !== "object") return undefined;

    const result: any = {};
    if (endpoint.position) {
        result.position = {
            x: Number(endpoint.position.x) || 0,
            y: Number(endpoint.position.y) || 0
        };
    }
    if (typeof endpoint.endpointNodeId === "string" && endpoint.endpointNodeId) {
        result.endpointNodeId = endpoint.endpointNodeId;
    }
    if (typeof endpoint.magnet === "string" && endpoint.magnet) {
        result.magnet = endpoint.magnet;
    }
    return result.position || result.endpointNodeId ? result : undefined;
}

export function absolutePointToNodeLocal(node: any, point: { x: number; y: number }) {
    const transform = safeRead(() => node.absoluteTransform, null as any);
    if (!transform || !transform[0] || !transform[1]) return { x: Number(point.x) || 0, y: Number(point.y) || 0 };

    const a = Number(transform[0][0]) || 0;
    const c = Number(transform[0][1]) || 0;
    const e = Number(transform[0][2]) || 0;
    const b = Number(transform[1][0]) || 0;
    const d = Number(transform[1][1]) || 0;
    const f = Number(transform[1][2]) || 0;
    const det = a * d - b * c;
    if (Math.abs(det) < 0.000001) return { x: (Number(point.x) || 0) - e, y: (Number(point.y) || 0) - f };

    const dx = (Number(point.x) || 0) - e;
    const dy = (Number(point.y) || 0) - f;
    return {
        x: (d * dx - c * dy) / det,
        y: (-b * dx + a * dy) / det
    };
}

export function connectorEndpointToLocalPoint(selection: any, endpoint: any, isStart: boolean) {
    const point = endpoint && endpoint.position ? endpoint.position : null;
    if (point) return absolutePointToNodeLocal(selection, point);

    const width = Number(safeRead(() => selection.width, 0)) || 0;
    const height = Number(safeRead(() => selection.height, 0)) || 0;
    return isStart ? { x: 0, y: 0 } : { x: width, y: height };
}

export function transConnectorNode(selection: any) {
    const universalStruct = getUniversalProperty(selection, "CONNECTOR", "CONNECTOR");
    const connectorStart = normalizeConnectorEndpoint(selection.connectorStart);
    const connectorEnd = normalizeConnectorEndpoint(selection.connectorEnd);
    const connectorLineType = selection.connectorLineType || "ELBOWED";
    const connectorCornerRadius = selection.cornerRadius || 0;
    const connectorStartStrokeCap = selection.connectorStartStrokeCap || "NONE";
    const connectorEndStrokeCap = selection.connectorEndStrokeCap || "NONE";
    const otherStruct = {
        "connectorStart": connectorStart,
        "connectorEnd": connectorEnd,
        "connectorStartLocal": connectorEndpointToLocalPoint(selection, connectorStart, true),
        "connectorEndLocal": connectorEndpointToLocalPoint(selection, connectorEnd, false),
        "connectorStartStrokeCap": connectorStartStrokeCap,
        "connectorEndStrokeCap": connectorEndStrokeCap,
        "connectorLineType": connectorLineType,
        "connectorCornerRadius": connectorCornerRadius,
        "vectorNetwork": undefined as any
    };
    otherStruct.vectorNetwork = createConnectorVectorNetwork(
        otherStruct.connectorStartLocal,
        otherStruct.connectorEndLocal,
        connectorStart,
        connectorEnd,
        connectorLineType,
        connectorCornerRadius,
        connectorStartStrokeCap,
        connectorEndStrokeCap
    );
    return Object.assign(otherStruct, universalStruct);
}
