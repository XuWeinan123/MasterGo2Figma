"use strict";
/// <reference types="@mastergo/plugin-typings" />
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
let totalNodes = 0;
let processedNodes = 0;
let fontLoaded = false;
const INTERNAL_PROPS_PREFIX = "[PROPS]";
const SIBLING_PROPS_PREFIX = "[PROPS_SIBLING]";
const VISUAL_FRAME_SOURCE_TYPES = ["COMPONENT", "COMPONENT_SET", "INSTANCE"];
processAllPages();
function countNodes(node) {
    totalNodes++;
    if (node.children) {
        for (const child of node.children)
            countNodes(child);
    }
}
function processAllPages() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            totalNodes = 0;
            processedNodes = 0;
            const pages = mg.document.children;
            for (const page of pages) {
                if (page.name.endsWith("_Process"))
                    continue;
                countNodes(page);
            }
            for (const page of pages) {
                if (page.name.endsWith("_Process"))
                    continue;
                const processPage = page.clone();
                processPage.name = page.name + "_Process";
                yield transformPageNodes(processPage);
            }
        }
        catch (error) {
            console.error("Error in processAllPages:", error);
        }
    });
}
function transformPageNodes(container) {
    return __awaiter(this, void 0, void 0, function* () {
        const children = [...container.children];
        for (const node of children) {
            yield transformNodeRecursive(node);
        }
    });
}
function transformNodeRecursive(node) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            processedNodes++;
            if (processedNodes % 50 === 0 || processedNodes === totalNodes) {
                console.log(`Progress: ${Math.round((processedNodes / totalNodes) * 100)}% (${processedNodes}/${totalNodes}) - Current: ${node.name}`);
            }
            // Skip our own generated layers if we rerun or process similar names
            if (node.name.startsWith(INTERNAL_PROPS_PREFIX) || node.name.startsWith(SIBLING_PROPS_PREFIX))
                return;
            const isContainer = node.type === "FRAME" ||
                node.type === "GROUP" ||
                node.type === "INSTANCE" ||
                node.type === "COMPONENT" ||
                node.type === "COMPONENT_SET" ||
                node.type === "SECTION";
            if (isContainer) {
                const sourceType = node.type;
                let containerNode = node;
                let nodeJson = null;
                // Instances are intentionally downgraded to visual frames in this iteration.
                if (node.type === "INSTANCE") {
                    containerNode = node.detachInstance();
                }
                else if (sourceType === "COMPONENT_SET") {
                    nodeJson = analyseNodes(node, sourceType);
                    containerNode = replaceComponentSetWithFrame(node);
                }
                // Generate PROPS node for container to preserve styles and type
                if (!nodeJson)
                    nodeJson = analyseNodes(containerNode, sourceType);
                if (shouldUseSiblingProps(sourceType, containerNode)) {
                    yield insertSiblingPropsMarker(containerNode, nodeJson);
                }
                else {
                    const jsonString = JSON.stringify([nodeJson, []]);
                    const textNode = yield initTextNodeByChar(jsonString);
                    textNode.name = INTERNAL_PROPS_PREFIX + containerNode.name;
                    textNode.isVisible = false;
                    if ('insertChild' in containerNode) {
                        containerNode.insertChild(0, textNode);
                    }
                    else {
                        containerNode.appendChild(textNode);
                    }
                    textNode.width = 1;
                    textNode.height = 1;
                    textNode.x = 0;
                    textNode.y = 0;
                }
                const children = [...containerNode.children];
                for (const child of children) {
                    if (child.name.startsWith(INTERNAL_PROPS_PREFIX) || child.name.startsWith(SIBLING_PROPS_PREFIX))
                        continue;
                    yield transformNodeRecursive(child);
                }
            }
            else {
                // For leaf nodes, replace with a Text node containing full property JSON.
                const nodeName = node.name;
                const nodeParent = node.parent;
                const nodeWidth = node.width;
                const nodeHeight = node.height;
                const nodeTransform = node.relativeTransform;
                const nodeJson = analyseNodes(node);
                const jsonString = JSON.stringify([nodeJson, []]);
                const textNode = yield initTextNodeByChar(jsonString);
                textNode.name = nodeName;
                if (nodeParent && 'insertChild' in nodeParent) {
                    const childrenList = nodeParent.children;
                    let index = -1;
                    for (let i = 0; i < childrenList.length; i++) {
                        if (childrenList[i].id === node.id) {
                            index = i;
                            break;
                        }
                    }
                    if (index !== -1) {
                        nodeParent.insertChild(index, textNode);
                    }
                    else {
                        nodeParent.appendChild(textNode);
                    }
                    // Set dimensions and position exactly as the original
                    textNode.width = nodeWidth;
                    textNode.height = nodeHeight;
                    textNode.relativeTransform = nodeTransform;
                    if (!node.removed)
                        node.remove();
                }
            }
        }
        catch (error) {
            console.error("Error processing node:", node.name, error);
        }
    });
}
function insertSiblingPropsMarker(node, nodeJson) {
    return __awaiter(this, void 0, void 0, function* () {
        const nodeParent = node.parent;
        if (!nodeParent || !('insertChild' in nodeParent))
            return;
        const textNode = yield initTextNodeByChar(JSON.stringify([nodeJson, []]));
        textNode.name = SIBLING_PROPS_PREFIX + node.name;
        textNode.isVisible = false;
        const childrenList = nodeParent.children;
        let index = -1;
        for (let i = 0; i < childrenList.length; i++) {
            if (childrenList[i].id === node.id) {
                index = i;
                break;
            }
        }
        if (index !== -1) {
            nodeParent.insertChild(index, textNode);
        }
        else {
            nodeParent.appendChild(textNode);
        }
        textNode.width = 1;
        textNode.height = 1;
        textNode.relativeTransform = node.relativeTransform;
    });
}
function shouldUseSiblingProps(sourceType, node) {
    return !('insertChild' in node);
}
function replaceComponentSetWithFrame(node) {
    const parent = node.parent;
    if (!parent || !('insertChild' in parent))
        return node;
    const frame = mg.createFrame();
    frame.name = node.name;
    frame.isVisible = node.isVisible;
    frame.isLocked = node.isLocked;
    frame.relativeTransform = node.relativeTransform;
    frame.x = node.x;
    frame.y = node.y;
    frame.width = node.width;
    frame.height = node.height;
    const childrenList = parent.children;
    let index = -1;
    for (let i = 0; i < childrenList.length; i++) {
        if (childrenList[i].id === node.id) {
            index = i;
            break;
        }
    }
    parent.insertChild(index !== -1 ? index : childrenList.length, frame);
    const nodeAbsoluteTransform = cloneTransform(node.absoluteTransform);
    const nodeInverseTransform = invertTransform(nodeAbsoluteTransform);
    const children = [...(node.children || [])].map((child) => ({
        node: child,
        originalX: child.x,
        originalY: child.y,
        relativeTransform: multiplyTransform(nodeInverseTransform, cloneTransform(child.absoluteTransform))
    }));
    let movedChildren = 0;
    for (const child of children) {
        try {
            frame.appendChild(child.node);
            child.node.relativeTransform = cloneTransform(child.relativeTransform);
            child.node.x = child.relativeTransform[0][2];
            child.node.y = child.relativeTransform[1][2];
            console.log(`[Component->Frame] ${node.name} / ${child.node.name}: ` +
                `before=(${child.originalX}, ${child.originalY}) ` +
                `after=(${child.node.x}, ${child.node.y}) ` +
                `target=(${child.relativeTransform[0][2]}, ${child.relativeTransform[1][2]})`);
            movedChildren++;
        }
        catch (error) {
            console.error("Unable to move component child into visual frame:", child.node.name, error);
        }
    }
    if (children.length > 0 && movedChildren === 0) {
        if (!frame.removed)
            frame.remove();
        return node;
    }
    if (!node.removed)
        node.remove();
    return frame;
}
function analyseNodes(node, sourceType) {
    const resolvedSourceType = sourceType || node.type;
    var finalNodeJson = "";
    if (resolvedSourceType == "BOOLEAN_OPERATION" && node.type == "BOOLEAN_OPERATION") {
        finalNodeJson = transBONode(node);
    }
    else if (resolvedSourceType == "COMPONENT") {
        finalNodeJson = transFrameNode(node, resolvedSourceType);
    }
    else if (resolvedSourceType == "COMPONENT_SET") {
        finalNodeJson = transFrameNode(node, resolvedSourceType);
    }
    else if (node.type == "ELLIPSE") {
        finalNodeJson = transEllipseNode(node);
    }
    else if (node.type == "PEN") {
        finalNodeJson = transPenNode(node);
    }
    else if (node.type == "RECTANGLE") {
        finalNodeJson = transRectangleNode(node);
    }
    else if (node.type == "TEXT") {
        finalNodeJson = transTextNode(node);
    }
    else if (node.type == "STAR") {
        finalNodeJson = transStarNode(node);
    }
    else if (node.type == "LINE") {
        finalNodeJson = transLineNode(node);
    }
    else if (node.type == "POLYGON") {
        finalNodeJson = transPolygonNode(node);
    }
    else if (node.type == "FRAME") {
        finalNodeJson = transFrameNode(node, resolvedSourceType);
    }
    else if (node.type == "GROUP") {
        finalNodeJson = transGroupNode(node);
    }
    else if (resolvedSourceType == "INSTANCE") {
        finalNodeJson = transFrameNode(node, resolvedSourceType);
    }
    else if (node.type == "SECTION") {
        finalNodeJson = transSectionNode(node);
    }
    else if (node.type == "SLICE") {
        finalNodeJson = transSliceNode(node);
    }
    else {
        finalNodeJson = {};
    }
    return finalNodeJson;
}
function transBONode(node) {
    const clone = node.clone();
    const flattedShapeNode = mg.flatten([clone]);
    if (!flattedShapeNode) {
        if (!clone.removed)
            clone.remove();
        return transBooleanNode(node);
    }
    // Boolean source children are intentionally not serialized in this iteration.
    const json = transPenNode(flattedShapeNode, "BOOLEAN_OPERATION", "PEN");
    json.booleanOperation = node.booleanOperation;
    flattedShapeNode.remove();
    return json;
}
function transPenNode(selection, sourceType, restoreType) {
    const universalStruct = getUniversalProperty(selection, sourceType, restoreType);
    const originJson = selection.penNetwork;
    const originCtrlNodes = originJson.ctrlNodes;
    const originNodes = originJson.nodes;
    const originPaths = originJson.paths;
    const resultSegments = new Array();
    for (var j = 0; j < originPaths.length; j++) {
        var tempStart = originPaths[j][0];
        var tempEnd = originPaths[j][3];
        var tempTangentStart = { x: 0, y: 0 };
        var tempTangentEnd = { x: 0, y: 0 };
        if (originPaths[j][1] != -1) {
            tempTangentStart.x = originCtrlNodes[originPaths[j][1]].x - originNodes[tempStart].x;
            tempTangentStart.y = originCtrlNodes[originPaths[j][1]].y - originNodes[tempStart].y;
        }
        if (originPaths[j][2] != -1) {
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
        "vertices": originNodes,
        "regions": []
    };
    const otherStruct = {
        "vectorNetwork": finalPathJson
    };
    const resultStruct = Object.assign(otherStruct, universalStruct);
    resultStruct.type = "PEN";
    return resultStruct;
}
function transEllipseNode(selection) {
    const universalStruct = getUniversalProperty(selection);
    const otherStruct = { "arcData": selection.arcData };
    return Object.assign(otherStruct, universalStruct);
}
function transRectangleNode(selection) {
    const universalStruct = getUniversalProperty(selection);
    return Object.assign({}, universalStruct);
}
function transStarNode(selection) {
    const universalStruct = getUniversalProperty(selection);
    const otherStruct = {
        "pointCount": selection.pointCount,
        "innerRadius": selection.innerRadius
    };
    return Object.assign(otherStruct, universalStruct);
}
function transLineNode(selection) {
    const universalStruct = getUniversalProperty(selection);
    return Object.assign({}, universalStruct);
}
function transPolygonNode(selection) {
    const universalStruct = getUniversalProperty(selection);
    const otherStruct = { "pointCount": selection.pointCount };
    return Object.assign(otherStruct, universalStruct);
}
function transFrameNode(selection, sourceType) {
    const universalStruct = getUniversalProperty(selection, sourceType);
    const otherStruct = { "clipsContent": selection.clipsContent };
    return Object.assign(otherStruct, universalStruct);
}
function transSectionNode(selection) {
    const universalStruct = getUniversalProperty(selection, "SECTION", "SECTION");
    const otherStruct = { "clipsContent": selection.clipsContent };
    return Object.assign(otherStruct, universalStruct);
}
function transGroupNode(selection) {
    const universalStruct = getUniversalProperty(selection, "GROUP", "GROUP");
    const otherStruct = { "clipsContent": false };
    return Object.assign(otherStruct, universalStruct);
}
function transSliceNode(selection) {
    return getUniversalProperty(selection, "SLICE", "SLICE");
}
function transTextNode(selection) {
    var _a, _b, _c, _d, _e;
    const universalStruct = getUniversalProperty(selection);
    let tempFontName = (_c = (_b = (_a = selection.textStyles) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.textStyle) === null || _c === void 0 ? void 0 : _c.fontName;
    if (tempFontName && tempFontName.family == "AlibabaPuHuiTi") {
        tempFontName = {
            family: "Alibaba PuHuiTi",
            style: tempFontName.style
        };
    }
    const style = ((_e = (_d = selection.textStyles) === null || _d === void 0 ? void 0 : _d[0]) === null || _e === void 0 ? void 0 : _e.textStyle) || {};
    const otherStruct = {
        "textAlignHorizontal": selection.textAlignHorizontal,
        "textAlignVertical": selection.textAlignVertical,
        "textAutoResize": selection.textAutoResize,
        "paragraphIndent": 0,
        "paragraphSpacing": selection.paragraphSpacing,
        "autoRename": false,
        "characters": selection.characters,
        "fontSize": style.fontSize,
        "fontName": tempFontName,
        "fontWeight": style.fontWeight,
        "textCase": style.textCase,
        "textDecoration": style.textDecoration,
        "letterSpacing": style.letterSpacing,
        "lineHeight": style.lineHeight,
    };
    return Object.assign(otherStruct, universalStruct);
}
function transBooleanNode(selection) {
    const universalStruct = getUniversalProperty(selection);
    const otherStruct = { "booleanOperation": selection.booleanOperation };
    return Object.assign(otherStruct, universalStruct);
}
function fillsAndStrokes2Json(fills, strokes) {
    const resultFills = [];
    if (Array.isArray(fills)) {
        for (const fill of fills) {
            let tempResultFill = {};
            if (fill.type == "SOLID") {
                tempResultFill = {
                    "type": fill.type,
                    "visible": fill.isVisible,
                    "opacity": fill.color.a,
                    "blendMode": processBlendMode(fill.blendMode),
                    "color": { "r": fill.color.r, "g": fill.color.g, "b": fill.color.b }
                };
            }
            else if (fill.type == "GRADIENT_LINEAR") {
                tempResultFill = {
                    "type": fill.type,
                    "visible": fill.isVisible,
                    "opacity": fill.alpha,
                    "blendMode": processBlendMode(fill.blendMode),
                    "gradientStops": rountGradientStops([...fill.gradientStops]),
                    "gradientTransform": getResultArrayByTwoPoint(fill.gradientHandlePositions || [])
                };
            }
            else if (fill.type == "GRADIENT_RADIAL" || fill.type == "GRADIENT_ANGULAR" || fill.type == "GRADIENT_DIAMOND") {
                tempResultFill = {
                    "type": fill.type,
                    "visible": fill.isVisible,
                    "opacity": fill.alpha,
                    "blendMode": processBlendMode(fill.blendMode),
                    "gradientStops": rountGradientStops([...fill.gradientStops]),
                    "gradientTransform": [[0, 1, 0], [-1, 0, 1]]
                };
            }
            else if (fill.type == "IMAGE") {
                tempResultFill = {
                    "blendMode": processBlendMode(fill.blendMode),
                    "imageHash": "eae313a48883a46e7a2a60ee806e73a8052191be",
                    "opacity": fill.alpha,
                    "type": "IMAGE",
                    "scaleMode": fill.scaleMode,
                    "visible": fill.isVisible
                };
            }
            if (tempResultFill.type)
                resultFills.push(tempResultFill);
        }
    }
    const resultStrokes = [];
    if (Array.isArray(strokes)) {
        for (const stroke of strokes) {
            let tempResultStroke = {};
            if (stroke.type == "SOLID") {
                tempResultStroke = {
                    "type": stroke.type,
                    "visible": stroke.isVisible,
                    "opacity": stroke.color.a,
                    "blendMode": stroke.blendMode,
                    "color": { "r": stroke.color.r, "g": stroke.color.g, "b": stroke.color.b }
                };
            }
            else if (stroke.type == "GRADIENT_LINEAR") {
                tempResultStroke = {
                    "type": stroke.type,
                    "visible": stroke.isVisible,
                    "opacity": stroke.alpha,
                    "blendMode": stroke.blendMode,
                    "gradientStops": rountGradientStops([...stroke.gradientStops]),
                    "gradientTransform": getResultArrayByTwoPoint(stroke.gradientHandlePositions || [])
                };
            }
            else if (stroke.type == "GRADIENT_RADIAL" || stroke.type == "GRADIENT_ANGULAR" || stroke.type == "GRADIENT_DIAMOND") {
                tempResultStroke = {
                    "type": stroke.type,
                    "visible": stroke.isVisible,
                    "opacity": stroke.alpha,
                    "blendMode": stroke.blendMode,
                    "gradientStops": rountGradientStops([...stroke.gradientStops]),
                    "gradientTransform": [[0, 1, 0], [-1, 0, 1]]
                };
            }
            if (tempResultStroke.type)
                resultStrokes.push(tempResultStroke);
        }
    }
    return { fills: resultFills, strokes: resultStrokes };
}
function rountGradientStops(gradientStops) {
    return gradientStops.map(stop => ({
        position: stop.position > 1 ? 1 : stop.position,
        color: Object.assign(Object.assign({}, stop.color), { a: stop.color.a > 1 ? 1 : stop.color.a })
    }));
}
function getResultArrayByTwoPoint(points) {
    if (points == undefined || points.length < 2) {
        return [[1, 0, 0], [0, 1, 0]];
    }
    var x3 = points[0].x, y3 = points[0].y, x4 = points[1].x, y4 = points[1].y;
    const m1 = [[1, 0, 0], [0, 1, 0.5], [0, 0, 1]];
    const len = Math.sqrt(Math.pow((x4 - x3), 2) + Math.pow((y4 - y3), 2));
    const m2 = [[1 / len, 0, 0], [0, 1, 0], [0, 0, 1]];
    const sina = (y3 - y4) / len, cosa = (x4 - x3) / len;
    const m3 = [[cosa, -sina, 0], [sina, cosa, 0], [0, 0, 1]];
    const m4 = [[1, 0, -x3], [0, 1, -y3], [0, 0, 1]];
    const m12 = matrixMultiplication(m2, m1);
    const m123 = matrixMultiplication(m12, m3);
    const m1234 = matrixMultiplication(m123, m4);
    return [m1234[0], m1234[1]];
    function matrixMultiplication(m1, m2) {
        let res = [];
        for (let i = 0; i < m1.length; i++) {
            res[i] = [];
            for (let j = 0; j < m2[0].length; j++) {
                let sum = 0;
                for (let k = 0; k < m2.length; k++)
                    sum += m1[i][k] * m2[k][j];
                res[i][j] = sum;
            }
        }
        return res;
    }
}
function getUniversalProperty(selection, sourceType, restoreType) {
    var _a, _b, _c, _d;
    const resolvedSourceType = sourceType || selection.type;
    const resolvedRestoreType = restoreType || getRestoreType(resolvedSourceType);
    const layoutTransform = getRelativeLayoutTransform(selection);
    const fills = selection.fills || [];
    const strokes = selection.strokes || [];
    var tFS = fillsAndStrokes2Json(fills, strokes);
    var fourCR = {
        tl: selection.topLeftRadius || 0,
        tr: selection.topRightRadius || 0,
        bl: selection.bottomLeftRadius || 0,
        br: selection.bottomRightRadius || 0
    };
    var resCR = selection.cornerRadius || 0;
    if (resCR === "Symbol(mg.mixed)")
        resCR = -1;
    var resCS = selection.cornerSmooth || 0;
    var effectsArray = [];
    const effects = selection.effects || [];
    for (const tE of effects) {
        if (tE.type == "DROP_SHADOW" || tE.type == "INNER_SHADOW") {
            effectsArray.push({
                "type": tE.type, "color": tE.color, "offset": tE.offset, "radius": tE.radius,
                "spread": tE.spread, "visible": tE.isVisible, "blendMode": processBlendMode(tE.blendMode)
            });
        }
        else if (tE.type == 'LAYER_BLUR' || tE.type == 'BACKGROUND_BLUR') {
            effectsArray.push({ "type": tE.type, "radius": tE.radius, "visible": tE.isVisible });
        }
    }
    return {
        "type": resolvedRestoreType,
        "sourceType": resolvedSourceType,
        "restoreType": resolvedRestoreType,
        "id": selection.id,
        "name": selection.name,
        "parentID": (selection.parent && selection.parent.type == "PAGE" ? null : (_a = selection.parent) === null || _a === void 0 ? void 0 : _a.id),
        "constraints": selection.constraints,
        "exportSettings": selection.exportSettings || [],
        "scence": { "visible": selection.isVisible, "locked": selection.isLocked },
        "blend": {
            "opacity": (_b = selection.opacity) !== null && _b !== void 0 ? _b : 1,
            "isMask": selection.isMask || false,
            "blendMode": processBlendMode(selection.blendMode || 'NORMAL'),
            "effects": effectsArray
        },
        "corner": {
            "topLeftRadius": fourCR.tl, "topRightRadius": fourCR.tr,
            "bottomLeftRadius": fourCR.bl, "bottomRightRadius": fourCR.br,
            "cornerRadius": resCR, "cornerSmoothing": resCS
        },
        "geometry": {
            "fills": tFS.fills, "strokes": tFS.strokes,
            "strokeWeight": selection.strokeWeight || 0,
            "strokeAlign": selection.strokeAlign || 'CENTER',
            "strokeJoin": selection.strokeJoin || 'MITER',
            "dashPattern": selection.strokeDashes || [],
            "strokeCap": selection.strokeCap || 'NONE',
        },
        "layout": {
            "relativeTransform": layoutTransform,
            "x": layoutTransform[0][2], "y": layoutTransform[1][2],
            "rotation": -selection.rotation || 0,
            "width": selection.width, "height": selection.height,
            "constrainProportions": selection.constrainProportions || false,
            "layoutMode": getLayoutMode(selection),
            "itemSpacing": selection.itemSpacing || 0,
            "paddingLeft": selection.paddingLeft || 0,
            "paddingRight": selection.paddingRight || 0,
            "paddingTop": selection.paddingTop || 0,
            "paddingBottom": selection.paddingBottom || 0,
            "primaryAxisAlignItems": getAxisAlign(selection.primaryAxisAlignItems || selection.mainAxisAlignItems || "MIN"),
            "counterAxisAlignItems": getAxisAlign(selection.counterAxisAlignItems || selection.crossAxisAlignItems || "MIN"),
            "primaryAxisSizingMode": selection.primaryAxisSizingMode || selection.mainAxisSizingMode || "FIXED",
            "counterAxisSizingMode": selection.counterAxisSizingMode || selection.crossAxisSizingMode || "FIXED",
            "itemReverseZIndex": selection.itemReverseZIndex || false,
            "strokesIncludedInLayout": selection.strokesIncludedInLayout || false,
            "layoutAlign": getLayoutAlign(selection.layoutAlign || selection.alignSelf || "INHERIT"),
            "layoutGrow": (_d = (_c = selection.layoutGrow) !== null && _c !== void 0 ? _c : selection.flexGrow) !== null && _d !== void 0 ? _d : 0,
            "layoutPositioning": selection.layoutPositioning || "AUTO"
        }
    };
}
function getRelativeLayoutTransform(selection) {
    const parent = selection.parent;
    if (parent && parent.type !== "PAGE" && selection.absoluteTransform && parent.absoluteTransform) {
        return multiplyTransform(invertTransform(parent.absoluteTransform), selection.absoluteTransform);
    }
    return selection.relativeTransform;
}
function cloneTransform(transform) {
    return [
        [transform[0][0], transform[0][1], transform[0][2]],
        [transform[1][0], transform[1][1], transform[1][2]]
    ];
}
function getRestoreType(sourceType) {
    if (VISUAL_FRAME_SOURCE_TYPES.indexOf(sourceType) !== -1)
        return "FRAME";
    if (sourceType === "BOOLEAN_OPERATION")
        return "VECTOR";
    return sourceType;
}
function getLayoutMode(selection) {
    const layoutMode = selection.layoutMode || selection.flexMode || "NONE";
    if (layoutMode === "ROW")
        return "HORIZONTAL";
    if (layoutMode === "COLUMN")
        return "VERTICAL";
    return layoutMode;
}
function getAxisAlign(value) {
    if (value === "FLEX_START")
        return "MIN";
    if (value === "FLEX_END")
        return "MAX";
    if (value === "SPACING_BETWEEN")
        return "SPACE_BETWEEN";
    return value;
}
function getLayoutAlign(value) {
    if (value === "STRETCH" || value === "INHERIT")
        return value;
    return getAxisAlign(value);
}
function multiplyTransform(a, b) {
    return [
        [
            a[0][0] * b[0][0] + a[0][1] * b[1][0],
            a[0][0] * b[0][1] + a[0][1] * b[1][1],
            a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2]
        ],
        [
            a[1][0] * b[0][0] + a[1][1] * b[1][0],
            a[1][0] * b[0][1] + a[1][1] * b[1][1],
            a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2]
        ]
    ];
}
function invertTransform(transform) {
    const a = transform[0][0];
    const b = transform[0][1];
    const c = transform[0][2];
    const d = transform[1][0];
    const e = transform[1][1];
    const f = transform[1][2];
    const det = a * e - b * d;
    if (Math.abs(det) < 0.000001)
        return [[1, 0, 0], [0, 1, 0]];
    return [
        [e / det, -b / det, (b * f - e * c) / det],
        [-d / det, a / det, (d * c - a * f) / det]
    ];
}
function initTextNodeByChar(characters) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!fontLoaded) {
            yield mg.loadFontAsync({ family: "Source Han Sans", style: "Regular" });
            fontLoaded = true;
        }
        const tempNode = mg.createText();
        tempNode.setRangeFontName(0, tempNode.characters.length, { family: "Source Han Sans", style: "Regular" });
        tempNode.characters = characters;
        tempNode.textAutoResize = "TRUNCATE";
        return tempNode;
    });
}
function processBlendMode(blendMode) {
    var resultBlenderMode = blendMode;
    if (resultBlenderMode == "PLUS_DARKER" || resultBlenderMode == "PASS_THROUGH")
        resultBlenderMode = "NORMAL";
    return resultBlenderMode;
}
