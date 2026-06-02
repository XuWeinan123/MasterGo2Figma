import { getUniversalProperty, safeRead } from "./universal";
import { getRuleRestoreType } from "../layerRules";
import { transPenNode } from "./vector";

export function transFrameNode(selection: any, sourceType?: string) {
    const universalStruct = getUniversalProperty(selection, sourceType);
    const otherStruct = { "clipsContent": selection.clipsContent };
    return Object.assign(otherStruct, universalStruct);
}

export function transSectionNode(selection: any) {
    const universalStruct = getUniversalProperty(selection, "SECTION", "SECTION");
    const otherStruct = { "clipsContent": selection.clipsContent };
    return Object.assign(otherStruct, universalStruct);
}

export function transGroupNode(selection: any) {
    const universalStruct = getUniversalProperty(selection, "GROUP", "GROUP");
    const otherStruct = { "clipsContent": false };
    return Object.assign(otherStruct, universalStruct);
}

export function transBONode(node: any) {
    // Avoid clone + flatten here. Complex boolean operations can crash the
    // MasterGo host runtime during large exports; direct network data is safer.
    const json: any = transPenNode(node, "BOOLEAN_OPERATION", getRuleRestoreType("BOOLEAN_OPERATION"));
    json.booleanOperation = safeRead(() => node.booleanOperation, "UNION");
    return json;
}

export function transBooleanTreeNode(node: any, restoreType: string) {
    const json: any = getUniversalProperty(node, "BOOLEAN_OPERATION", restoreType);
    json.booleanOperation = safeRead(() => node.booleanOperation, "UNION");
    return json;
}
