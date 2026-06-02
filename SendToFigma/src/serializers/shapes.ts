import { getUniversalProperty, cloneJsonCompatible } from "./universal";

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
