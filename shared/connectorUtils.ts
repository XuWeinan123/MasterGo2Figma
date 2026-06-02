export type ConnectorMagnet = "TOP" | "BOTTOM" | "LEFT" | "RIGHT";

export type ConnectorEndpoint = {
    magnet: ConnectorMagnet;
};

export type Point2D = {
    x: number;
    y: number;
};

export type ConnectorVectorNetwork = {
    vertices: Array<{
        x: number;
        y: number;
        strokeCap?: string;
        cornerRadius?: number;
    }>;
    segments: Array<{
        start: number;
        end: number;
        tangentStart: Point2D;
        tangentEnd: Point2D;
    }>;
    regions: any[];
};

export function normalizeConnectorPoint(point: any): Point2D {
    return {
        x: Number(point && point.x) || 0,
        y: Number(point && point.y) || 0
    };
}

export function isSameConnectorAxis(start: Point2D, end: Point2D): boolean {
    return Math.abs(start.x - end.x) < 0.01 || Math.abs(start.y - end.y) < 0.01;
}

export function shouldConnectorRouteStartHorizontal(
    start: Point2D,
    end: Point2D,
    startEndpoint: ConnectorEndpoint | null | undefined,
    endEndpoint: ConnectorEndpoint | null | undefined
): boolean {
    const startMagnet = startEndpoint && startEndpoint.magnet;
    if (startMagnet === "LEFT" || startMagnet === "RIGHT") return true;
    if (startMagnet === "TOP" || startMagnet === "BOTTOM") return false;

    const endMagnet = endEndpoint && endEndpoint.magnet;
    if (endMagnet === "TOP" || endMagnet === "BOTTOM") return true;
    if (endMagnet === "LEFT" || endMagnet === "RIGHT") return false;

    return Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
}

export function dedupeConnectorPoints(points: Point2D[]): Point2D[] {
    const result: Point2D[] = [];
    for (const point of points) {
        const previous = result[result.length - 1];
        if (!previous || Math.abs(previous.x - point.x) >= 0.01 || Math.abs(previous.y - point.y) >= 0.01) {
            result.push(point);
        }
    }
    return result.length > 1 ? result : [points[0], points[points.length - 1]];
}

export function getConnectorCornerRadius(
    points: Point2D[],
    index: number,
    requestedRadius: number
): number {
    const radius = Number(requestedRadius) || 0;
    if (radius <= 0) return 0;

    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    const previousLength = Math.abs(current.x - previous.x) + Math.abs(current.y - previous.y);
    const nextLength = Math.abs(next.x - current.x) + Math.abs(next.y - current.y);
    return Math.min(radius, previousLength / 2, nextLength / 2);
}

export function normalizeConnectorVectorStrokeCap(value: any): string {
    if (value === "ARROW_EQUILATERAL" ||
        value === "ARROW_LINES" ||
        value === "TRIANGLE_FILLED" ||
        value === "DIAMOND_FILLED" ||
        value === "CIRCLE_FILLED" ||
        value === "ROUND" ||
        value === "SQUARE" ||
        value === "NONE") {
        return value;
    }

    if (value === "LINE_ARROW" || value === "LINE") return "ARROW_LINES";
    if (value === "TRIANGLE_ARROW") return "ARROW_EQUILATERAL";
    if (value === "DIAMOND") return "DIAMOND_FILLED";
    if (value === "ROUND_ARROW" || value === "RING") return "CIRCLE_FILLED";
    return "NONE";
}

export function createConnectorRoutePoints(
    start: any,
    end: any,
    startEndpoint: ConnectorEndpoint | null | undefined,
    endEndpoint: ConnectorEndpoint | null | undefined,
    lineType: string
): Point2D[] {
    const startPoint = normalizeConnectorPoint(start);
    const endPoint = normalizeConnectorPoint(end);
    if (lineType !== "ELBOWED" || isSameConnectorAxis(startPoint, endPoint)) {
        return dedupeConnectorPoints([startPoint, endPoint]);
    }

    const horizontalFirst = shouldConnectorRouteStartHorizontal(startPoint, endPoint, startEndpoint, endEndpoint);
    const middlePoint = horizontalFirst
        ? { x: endPoint.x, y: startPoint.y }
        : { x: startPoint.x, y: endPoint.y };

    return dedupeConnectorPoints([startPoint, middlePoint, endPoint]);
}

export function createConnectorVectorNetwork(
    start: any,
    end: any,
    startEndpoint: ConnectorEndpoint | null | undefined,
    endEndpoint: ConnectorEndpoint | null | undefined,
    lineType: string,
    cornerRadius: number,
    startStrokeCap: string,
    endStrokeCap: string
): ConnectorVectorNetwork {
    const points = createConnectorRoutePoints(start, end, startEndpoint, endEndpoint, lineType);
    const vertices = points.map((point, index) => {
        const vertex: any = { x: point.x, y: point.y };
        if (index === 0) vertex.strokeCap = normalizeConnectorVectorStrokeCap(startStrokeCap);
        if (index === points.length - 1) vertex.strokeCap = normalizeConnectorVectorStrokeCap(endStrokeCap);
        if (index > 0 && index < points.length - 1) {
            const radius = getConnectorCornerRadius(points, index, cornerRadius);
            if (radius > 0) vertex.cornerRadius = radius;
        }
        return vertex;
    });

    const segments: Array<{ start: number; end: number; tangentStart: Point2D; tangentEnd: Point2D }> = [];
    for (let index = 0; index < points.length - 1; index++) {
        segments.push({
            start: index,
            end: index + 1,
            tangentStart: { x: 0, y: 0 },
            tangentEnd: { x: 0, y: 0 }
        });
    }

    return { vertices, segments, regions: [] };
}
