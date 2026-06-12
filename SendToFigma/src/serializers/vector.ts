import { getUniversalProperty, readNodeProperty, cloneJsonCompatible } from "./universal";
import { normalizeVectorWindingRuleForFigma } from "../../../shared/vectorUtils";
import { normalizeMasterGoStrokeCapForFigma } from "../../../shared/connectorUtils";
import { getRuleRestoreType } from "../layerRules";

export function normalizeVectorRegionLoops(loops: any): number[][] {
    if (!Array.isArray(loops)) return [];

    const result: number[][] = [];
    for (const loop of loops) {
        if (!Array.isArray(loop)) continue;
        const segmentIndexes = loop
            .map((value: any) => Number(value))
            .filter((value: number) => Number.isFinite(value));
        if (segmentIndexes.length > 0) result.push(segmentIndexes);
    }
    return result;
}

export function normalizeVectorRegions(regions: any): any[] {
    if (!Array.isArray(regions)) return [];

    const result: any[] = [];
    for (const region of regions) {
        if (!region || typeof region !== "object") continue;
        const loops = normalizeVectorRegionLoops(region.loops);
        if (loops.length === 0) continue;
        result.push({
            windingRule: normalizeVectorWindingRuleForFigma(region.windingRule),
            loops
        });
    }
    return result;
}

export function cloneVectorNetworkForExport(vectorNetwork: any) {
    if (!vectorNetwork || typeof vectorNetwork !== "object") return undefined;
    return {
        vertices: cloneJsonCompatible(vectorNetwork.vertices, []),
        segments: cloneJsonCompatible(vectorNetwork.segments, []),
        regions: normalizeVectorRegions(vectorNetwork.regions)
    };
}

export function getUniformOpenVectorStrokeCap(vectorNetwork: any): string | null {
    if (!vectorNetwork || !Array.isArray(vectorNetwork.vertices) || !Array.isArray(vectorNetwork.segments)) return null;
    if (Array.isArray(vectorNetwork.regions) && vectorNetwork.regions.length > 0) return null;
    if (vectorNetwork.segments.length < 1) return null;

    const firstSegment = vectorNetwork.segments[0];
    const lastSegment = vectorNetwork.segments[vectorNetwork.segments.length - 1];
    const startVertex = vectorNetwork.vertices[firstSegment && firstSegment.start];
    const endVertex = vectorNetwork.vertices[lastSegment && lastSegment.end];
    const startCap = startVertex && startVertex.strokeCap;
    const endCap = endVertex && endVertex.strokeCap;
    if (!startCap || startCap === "NONE") return null;
    if (endCap && endCap !== "NONE" && endCap !== startCap) return null;
    return normalizeMasterGoStrokeCapForFigma(startCap);
}

export function applyUniformVectorStrokeCap(resultStruct: any, vectorNetwork: any) {
    const strokeCap = getUniformOpenVectorStrokeCap(vectorNetwork);
    if (!strokeCap || !resultStruct.geometry || resultStruct.geometry.strokeCap !== "NONE") return;
    resultStruct.geometry.strokeCap = strokeCap;
}

export function transPenNode(selection: any, sourceType?: string, restoreType?: string) {
    const universalStruct = getUniversalProperty(selection, sourceType, restoreType);
    const originJson = selection.penNetwork;
    if (!originJson || !originJson.ctrlNodes || !originJson.nodes || !originJson.paths) {
        const vectorNetwork = cloneVectorNetworkForExport(selection.vectorNetwork);
        const resultStruct = Object.assign(vectorNetwork ? { vectorNetwork } : {}, universalStruct);
        resultStruct.type = restoreType || getRuleRestoreType(sourceType || selection.type);
        applyUniformVectorStrokeCap(resultStruct, vectorNetwork);
        return resultStruct;
    }

    const originCtrlNodes = originJson.ctrlNodes;
    const originNodes = originJson.nodes;
    const originPaths = originJson.paths;
    const resultSegments: any[] = [];

    for (let j = 0; j < originPaths.length; j++) {
        const tempStart = originPaths[j][0];
        const tempEnd = originPaths[j][3];
        const tempTangentStart = { x: 0, y: 0 };
        const tempTangentEnd = { x: 0, y: 0 };

        if (originPaths[j][1] !== -1 && originCtrlNodes[originPaths[j][1]]) {
            tempTangentStart.x = originCtrlNodes[originPaths[j][1]].x - originNodes[tempStart].x;
            tempTangentStart.y = originCtrlNodes[originPaths[j][1]].y - originNodes[tempStart].y;
        }
        if (originPaths[j][2] !== -1 && originCtrlNodes[originPaths[j][2]]) {
            tempTangentEnd.x = originCtrlNodes[originPaths[j][2]].x - originNodes[tempEnd].x;
            tempTangentEnd.y = originCtrlNodes[originPaths[j][2]].y - originNodes[tempEnd].y;
        }

        resultSegments.push({
            start: tempStart,
            end: tempEnd,
            tangentStart: tempTangentStart,
            tangentEnd: tempTangentEnd
        });
    }

    const finalPathJson = {
        "segments": resultSegments,
        "vertices": cloneJsonCompatible(originNodes, []),
        "regions": normalizeVectorRegions(originJson.regions)
    };

    const otherStruct = {
        "vectorNetwork": finalPathJson
    };

    const resultStruct = Object.assign(otherStruct, universalStruct);
    resultStruct.type = restoreType || getRuleRestoreType(sourceType || selection.type);
    applyUniformVectorStrokeCap(resultStruct, finalPathJson);
    return resultStruct;
}
