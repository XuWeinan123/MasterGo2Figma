import { getUniversalProperty, cloneJsonCompatible } from "./universal";
import {
    normalizeConnectorVectorStrokeCap,
    shouldRestoreStrokeCapAsVector
} from "../../../shared/connectorUtils";

export function transEllipseNode(selection: any) {
    const universalStruct = getUniversalProperty(selection);
    const otherStruct = { "arcData": cloneJsonCompatible(selection.arcData, undefined) };
    return Object.assign(otherStruct, universalStruct);
}

export function transRectangleNode(selection: any) {
    const universalStruct = getUniversalProperty(selection);
    return Object.assign({}, universalStruct);
}

export function transStarNode(selection: any) {
    const universalStruct = getUniversalProperty(selection);
    const otherStruct = {
        "pointCount": selection.pointCount,
        "innerRadius": selection.innerRadius
    };
    return Object.assign(otherStruct, universalStruct);
}

export function transLineNode(selection: any) {
    const universalStruct = getUniversalProperty(selection);
    const rawStrokeCap = selection.strokeCap;
    if (shouldRestoreStrokeCapAsVector(rawStrokeCap)) {
        const width = Number(selection.width) || 0;
        const strokeCap = normalizeConnectorVectorStrokeCap(rawStrokeCap);
        return Object.assign({}, universalStruct, {
            vectorNetwork: {
                vertices: [
                    { x: 0, y: 0, cornerRadius: 0, strokeCap },
                    { x: width, y: 0, cornerRadius: 0, strokeCap }
                ],
                segments: [{
                    start: 0,
                    end: 1,
                    tangentStart: { x: 0, y: 0 },
                    tangentEnd: { x: 0, y: 0 }
                }],
                regions: []
            },
            type: "VECTOR",
            restoreType: "VECTOR",
            sourceType: "LINE",
            lineFallbackVector: true
        });
    }
    return Object.assign({}, universalStruct);
}

export function transPolygonNode(selection: any) {
    const universalStruct = getUniversalProperty(selection);
    const otherStruct = { "pointCount": selection.pointCount };
    return Object.assign(otherStruct, universalStruct);
}

export function transSliceNode(selection: any) {
    return getUniversalProperty(selection, "SLICE", "SLICE");
}
