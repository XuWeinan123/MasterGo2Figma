/// <reference types="@mastergo/plugin-typings" />

let totalNodes = 0;
let processedNodes = 0;
let fontLoaded = false;

processAllPages();

function countNodes(node: any) {
    totalNodes++;
    if (node.children) {
        for (const child of node.children) countNodes(child);
    }
}

async function processAllPages() {
    try {
        totalNodes = 0;
        processedNodes = 0;
        
        const pages = mg.document.children;
        
        for (const page of pages) {
            if (page.name.endsWith("_Process")) continue;
            countNodes(page);
        }
        
        for (const page of pages) {
            if (page.name.endsWith("_Process")) continue;

            const processPage = page.clone();
            processPage.name = page.name + "_Process";

            await transformPageNodes(processPage);
        }
    } catch (error) {
        console.error("Error in processAllPages:", error);
    }
}

async function transformPageNodes(container: any) {
    const children = [...container.children];
    for (const node of children) {
        await transformNodeRecursive(node);
    }
}

async function transformNodeRecursive(node: SceneNode) {
    try {
        processedNodes++;
        if (processedNodes % 50 === 0 || processedNodes === totalNodes) {
            console.log(`Progress: ${Math.round((processedNodes / totalNodes) * 100)}% (${processedNodes}/${totalNodes}) - Current: ${node.name}`);
        }

        // Skip our own generated layers if we rerun or process similar names
        if (node.name.startsWith("[PROPS]")) return;

        const isContainer = node.type === "FRAME" ||
            node.type === "GROUP" ||
            node.type === "INSTANCE" ||
            node.type === "COMPONENT" ||
            node.type === "COMPONENT_SET" ||
            node.type === "SECTION";

        if (isContainer) {
            let containerNode = node as any;
            
            // Only detach instances. Do NOT detach components as it breaks their instances on the same page.
            if (node.type === "INSTANCE") {
                containerNode = (node as InstanceNode).detachInstance();
            }
            
            // Generate PROPS node for container to preserve styles and type
            const nodeJson = analyseNodes(containerNode);
            const jsonString = JSON.stringify([nodeJson, []]);
            const textNode = await initTextNodeByChar(jsonString);
            
            textNode.name = "[PROPS]" + containerNode.name;
            textNode.isVisible = false;
            
            if ('insertChild' in containerNode) {
                containerNode.insertChild(0, textNode);
            } else {
                containerNode.appendChild(textNode);
            }
            
            textNode.width = 1;
            textNode.height = 1;
            textNode.x = 0;
            textNode.y = 0;

            const children = [...containerNode.children];
            for (const child of children) {
                if (child === textNode) continue;
                await transformNodeRecursive(child as SceneNode);
            }
        } else {
            // For leaf nodes, replace with a Text node containing full property JSON.
            const nodeName = node.name;
            const nodeParent = node.parent;
            const nodeWidth = node.width;
            const nodeHeight = node.height;
            const nodeTransform = node.relativeTransform;

            const nodeJson = analyseNodes(node);
            const jsonString = JSON.stringify([nodeJson, []]);
            const textNode = await initTextNodeByChar(jsonString);

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
                    (nodeParent as any).insertChild(index, textNode);
                } else {
                    (nodeParent as any).appendChild(textNode);
                }

                // Set dimensions and position exactly as the original
                textNode.width = nodeWidth;
                textNode.height = nodeHeight;
                textNode.relativeTransform = nodeTransform;

                if (!node.removed) node.remove();
            }
        }
    } catch (error) {
        console.error("Error processing node:", node.name, error);
    }
}

function analyseNodes(node: SceneNode): any {
    var finalNodeJson: any = ""
    if (node.type == "BOOLEAN_OPERATION") {
        finalNodeJson = transBONode(node)
    } else if (node.type == "COMPONENT") {
        finalNodeJson = transFrameNode(node as ComponentNode)
    } else if (node.type == "COMPONENT_SET") {
        finalNodeJson = transFrameNode(node as any)
    } else if (node.type == "ELLIPSE") {
        finalNodeJson = transEllipseNode(node as EllipseNode)
    } else if (node.type == "PEN") {
        finalNodeJson = transPenNode(node as PenNode)
    } else if (node.type == "RECTANGLE") {
        finalNodeJson = transRectangleNode(node as RectangleNode)
    } else if (node.type == "TEXT") {
        finalNodeJson = transTextNode(node as TextNode)
    } else if (node.type == "STAR") {
        finalNodeJson = transStarNode(node as StarNode)
    } else if (node.type == "LINE") {
        finalNodeJson = transLineNode(node as LineNode)
    } else if (node.type == "POLYGON") {
        finalNodeJson = transPolygonNode(node as PolygonNode)
    } else if (node.type == "FRAME") {
        finalNodeJson = transFrameNode(node as FrameNode)
    } else if (node.type == "GROUP") {
        finalNodeJson = transGroupNode(node as GroupNode)
    } else if (node.type == "INSTANCE") {
        finalNodeJson = transFrameNode(node as InstanceNode)
    } else {
        finalNodeJson = {}
    }
    return finalNodeJson
}

function transBONode(node: BooleanOperationNode) {
    const clone = node.clone();
    const flattedShapeNode = mg.flatten([clone]);
    
    if (!flattedShapeNode) {
        if (!clone.removed) clone.remove();
        return transBooleanNode(node);
    }

    const json = transPenNode(flattedShapeNode as PenNode);
    flattedShapeNode.remove();
    return json;
}

function transPenNode(selection: PenNode) {
    const universalStruct = getUniversalProperty(selection)
    const originJson = selection.penNetwork
    const originCtrlNodes = originJson.ctrlNodes
    const originNodes = originJson.nodes
    const originPaths = originJson.paths
    const resultSegments = new Array()

    for (var j = 0; j < originPaths.length; j++) {
        var tempStart = originPaths[j][0]
        var tempEnd = originPaths[j][3]
        var tempTangentStart = { x: 0, y: 0 }
        var tempTangentEnd = { x: 0, y: 0 }

        if (originPaths[j][1] != -1) {
            tempTangentStart.x = originCtrlNodes[originPaths[j][1]].x - originNodes[tempStart].x
            tempTangentStart.y = originCtrlNodes[originPaths[j][1]].y - originNodes[tempStart].y
        }
        if (originPaths[j][2] != -1) {
            tempTangentEnd.x = originCtrlNodes[originPaths[j][2]].x - originNodes[tempEnd].x
            tempTangentEnd.y = originCtrlNodes[originPaths[j][2]].y - originNodes[tempEnd].y
        }

        resultSegments.push({
            start: tempStart,
            end: tempEnd,
            tangentStart: tempTangentStart,
            tangentEnd: tempTangentEnd
        })
    }
    const finalPathJson = {
        "segments": resultSegments,
        "vertices": originNodes,
        "regions": []
    }

    const otherStruct = {
        "vectorNetwork": finalPathJson
    }

    const resultStruct = Object.assign(otherStruct, universalStruct)
    resultStruct.type = "PEN";
    return resultStruct
}

function transEllipseNode(selection: EllipseNode) {
    const universalStruct = getUniversalProperty(selection)
    const otherStruct = { "arcData": selection.arcData }
    return Object.assign(otherStruct, universalStruct)
}

function transRectangleNode(selection: RectangleNode) {
    const universalStruct = getUniversalProperty(selection)
    return Object.assign({}, universalStruct)
}

function transStarNode(selection: StarNode) {
    const universalStruct = getUniversalProperty(selection)
    const otherStruct = {
        "pointCount": selection.pointCount,
        "innerRadius": selection.innerRadius
    }
    return Object.assign(otherStruct, universalStruct)
}

function transLineNode(selection: LineNode) {
    const universalStruct = getUniversalProperty(selection)
    return Object.assign({}, universalStruct)
}

function transPolygonNode(selection: PolygonNode) {
    const universalStruct = getUniversalProperty(selection)
    const otherStruct = { "pointCount": selection.pointCount }
    return Object.assign(otherStruct, universalStruct)
}

function transFrameNode(selection: FrameNode | InstanceNode | ComponentNode) {
    const universalStruct = getUniversalProperty(selection)
    const otherStruct = { "clipsContent": selection.clipsContent }
    return Object.assign(otherStruct, universalStruct)
}

function transGroupNode(selection: GroupNode) {
    const universalStruct = getUniversalProperty(selection)
    universalStruct.type = "GROUP"
    const otherStruct = { "clipsContent": false }
    return Object.assign(otherStruct, universalStruct)
}

function transTextNode(selection: TextNode) {
    const universalStruct = getUniversalProperty(selection)
    let tempFontName = (selection as any).textStyles?.[0]?.textStyle?.fontName;

    if (tempFontName && tempFontName.family == "AlibabaPuHuiTi") {
        tempFontName = {
            family: "Alibaba PuHuiTi",
            style: tempFontName.style
        }
    }

    const style = (selection as any).textStyles?.[0]?.textStyle || {};

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
    }

    return Object.assign(otherStruct, universalStruct)
}

function transBooleanNode(selection: BooleanOperationNode) {
    const universalStruct = getUniversalProperty(selection)
    const otherStruct = { "booleanOperation": selection.booleanOperation }
    return Object.assign(otherStruct, universalStruct)
}

function fillsAndStrokes2Json(fills: readonly Paint[] | typeof mg.mixed, strokes: readonly Paint[]) {
    const resultFills: any[] = []
    if (Array.isArray(fills)) {
        for (const fill of fills) {
            let tempResultFill: any = {}
            if (fill.type == "SOLID") {
                tempResultFill = {
                    "type": fill.type,
                    "visible": fill.isVisible,
                    "opacity": fill.color.a,
                    "blendMode": processBlendMode(fill.blendMode),
                    "color": { "r": fill.color.r, "g": fill.color.g, "b": fill.color.b }
                }
            } else if (fill.type == "GRADIENT_LINEAR") {
                tempResultFill = {
                    "type": fill.type,
                    "visible": fill.isVisible,
                    "opacity": fill.alpha,
                    "blendMode": processBlendMode(fill.blendMode),
                    "gradientStops": rountGradientStops([...fill.gradientStops]),
                    "gradientTransform": getResultArrayByTwoPoint(fill.gradientHandlePositions || [])
                }
            } else if (fill.type == "GRADIENT_RADIAL" || fill.type == "GRADIENT_ANGULAR" || fill.type == "GRADIENT_DIAMOND") {
                tempResultFill = {
                    "type": fill.type,
                    "visible": fill.isVisible,
                    "opacity": fill.alpha,
                    "blendMode": processBlendMode(fill.blendMode),
                    "gradientStops": rountGradientStops([...fill.gradientStops]),
                    "gradientTransform": [[0, 1, 0], [-1, 0, 1]]
                }
            } else if (fill.type == "IMAGE") {
                tempResultFill = {
                    "blendMode": processBlendMode(fill.blendMode),
                    "imageHash": "eae313a48883a46e7a2a60ee806e73a8052191be",
                    "opacity": fill.alpha,
                    "type": "IMAGE",
                    "scaleMode": fill.scaleMode,
                    "visible": fill.isVisible
                }
            }
            resultFills.push(tempResultFill)
        }
    }

    const resultStrokes: any[] = []
    if (Array.isArray(strokes)) {
        for (const stroke of strokes) {
            let tempResultStroke: any = {}
            if (stroke.type == "SOLID") {
                tempResultStroke = {
                    "type": stroke.type,
                    "visible": stroke.isVisible,
                    "opacity": stroke.color.a,
                    "blendMode": stroke.blendMode,
                    "color": { "r": stroke.color.r, "g": stroke.color.g, "b": stroke.color.b }
                }
            } else if (stroke.type == "GRADIENT_LINEAR") {
                tempResultStroke = {
                    "type": stroke.type,
                    "visible": stroke.isVisible,
                    "opacity": stroke.alpha,
                    "blendMode": stroke.blendMode,
                    "gradientStops": rountGradientStops([...stroke.gradientStops]),
                    "gradientTransform": getResultArrayByTwoPoint(stroke.gradientHandlePositions || [])
                }
            } else if (stroke.type == "GRADIENT_RADIAL" || stroke.type == "GRADIENT_ANGULAR" || stroke.type == "GRADIENT_DIAMOND") {
                tempResultStroke = {
                    "type": stroke.type,
                    "visible": stroke.isVisible,
                    "opacity": stroke.alpha,
                    "blendMode": stroke.blendMode,
                    "gradientStops": rountGradientStops([...stroke.gradientStops]),
                    "gradientTransform": [[0, 1, 0], [-1, 0, 1]]
                }
            }
            resultStrokes.push(tempResultStroke)
        }
    }

    return { fills: resultFills, strokes: resultStrokes }
}

function rountGradientStops(gradientStops: ColorStop[]) {
    return gradientStops.map(stop => ({
        position: stop.position > 1 ? 1 : stop.position,
        color: { ...stop.color, a: stop.color.a > 1 ? 1 : stop.color.a }
    }));
}

function getResultArrayByTwoPoint(points: readonly Vector[]) {
    if (points == undefined || points.length < 2) {
        return [[1, 0, 0], [0, 1, 0]]
    }
    var x3 = points[0].x, y3 = points[0].y, x4 = points[1].x, y4 = points[1].y;
    const m1 = [[1, 0, 0], [0, 1, 0.5], [0, 0, 1]]
    const len = Math.sqrt((x4 - x3) ** 2 + (y4 - y3) ** 2)
    const m2 = [[1 / len, 0, 0], [0, 1, 0], [0, 0, 1]]
    const sina = (y3 - y4) / len, cosa = (x4 - x3) / len
    const m3 = [[cosa, -sina, 0], [sina, cosa, 0], [0, 0, 1]]
    const m4 = [[1, 0, -x3], [0, 1, -y3], [0, 0, 1]]

    const m12 = matrixMultiplication(m2, m1)
    const m123 = matrixMultiplication(m12, m3)
    const m1234 = matrixMultiplication(m123, m4)
    return [m1234[0], m1234[1]]

    function matrixMultiplication(m1: number[][], m2: number[][]) {
        let res: number[][] = [];
        for (let i = 0; i < m1.length; i++) {
            res[i] = [];
            for (let j = 0; j < m2[0].length; j++) {
                let sum = 0;
                for (let k = 0; k < m2.length; k++) sum += m1[i][k] * m2[k][j];
                res[i][j] = sum;
            }
        }
        return res;
    }
}

function getUniversalProperty(selection: SceneNode) {
    const fills = (selection as any).fills || []
    const strokes = (selection as any).strokes || []
    var tFS = fillsAndStrokes2Json(fills, strokes)

    var fourCR = {
        tl: (selection as any).topLeftRadius || 0,
        tr: (selection as any).topRightRadius || 0,
        bl: (selection as any).bottomLeftRadius || 0,
        br: (selection as any).bottomRightRadius || 0
    }

    var resCR: number = (selection as any).cornerRadius || 0
    if (resCR as any === "Symbol(mg.mixed)") resCR = -1

    var resCS = (selection as any).cornerSmooth || 0

    var effectsArray: any[] = []
    const effects = (selection as any).effects || []
    for (const tE of effects) {
        if (tE.type == "DROP_SHADOW" || tE.type == "INNER_SHADOW") {
            effectsArray.push({
                "type": tE.type, "color": tE.color, "offset": tE.offset, "radius": tE.radius,
                "spread": tE.spread, "visible": tE.isVisible, "blendMode": processBlendMode(tE.blendMode)
            })
        } else if (tE.type == 'LAYER_BLUR' || tE.type == 'BACKGROUND_BLUR') {
            effectsArray.push({ "type": tE.type, "radius": tE.radius, "visible": tE.isVisible })
        }
    }

    return {
        "type": selection.type,
        "id": selection.id,
        "name": selection.name,
        "parentID": (selection.parent && selection.parent.type == "PAGE" ? null : selection.parent?.id),
        "scence": { "visible": selection.isVisible, "locked": selection.isLocked },
        "blend": {
            "opacity": (selection as any).opacity ?? 1,
            "isMask": (selection as any).isMask || false,
            "blendMode": processBlendMode((selection as any).blendMode || 'NORMAL'),
            "effects": effectsArray
        },
        "corner": {
            "topLeftRadius": fourCR.tl, "topRightRadius": fourCR.tr,
            "bottomLeftRadius": fourCR.bl, "bottomRightRadius": fourCR.br,
            "cornerRadius": resCR, "cornerSmoothing": resCS
        },
        "geometry": {
            "fills": tFS.fills, "strokes": tFS.strokes,
            "strokeWeight": (selection as any).strokeWeight || 0,
            "strokeAlign": (selection as any).strokeAlign || 'CENTER',
            "strokeJoin": (selection as any).strokeJoin || 'MITER',
            "dashPattern": (selection as any).strokeDashes || [],
            "strokeCap": (selection as any).strokeCap || 'NONE',
        },
        "layout": {
            "relativeTransform": selection.relativeTransform,
            "x": selection.x, "y": selection.y,
            "rotation": -(selection as any).rotation || 0,
            "width": selection.width, "height": selection.height,
            "layoutMode": (selection as any).layoutMode || "NONE",
            "itemSpacing": (selection as any).itemSpacing || 0,
            "paddingLeft": (selection as any).paddingLeft || 0,
            "paddingRight": (selection as any).paddingRight || 0,
            "paddingTop": (selection as any).paddingTop || 0,
            "paddingBottom": (selection as any).paddingBottom || 0,
            "primaryAxisAlignItems": (selection as any).primaryAxisAlignItems || "MIN",
            "counterAxisAlignItems": (selection as any).counterAxisAlignItems || "MIN",
            "primaryAxisSizingMode": (selection as any).primaryAxisSizingMode || "FIXED",
            "counterAxisSizingMode": (selection as any).counterAxisSizingMode || "FIXED",
            "itemReverseZIndex": (selection as any).itemReverseZIndex || false,
            "strokesIncludedInLayout": (selection as any).strokesIncludedInLayout || false,
            "layoutAlign": (selection as any).layoutAlign || "INHERIT",
            "layoutGrow": (selection as any).layoutGrow || 0,
            "layoutPositioning": (selection as any).layoutPositioning || "AUTO"
        }
    }
}

async function initTextNodeByChar(characters: string) {
    if (!fontLoaded) {
        await mg.loadFontAsync({ family: "Source Han Sans", style: "Regular" });
        fontLoaded = true;
    }
    const tempNode = mg.createText()
    tempNode.setRangeFontName(0, tempNode.characters.length, { family: "Source Han Sans", style: "Regular" })
    tempNode.characters = characters
    tempNode.textAutoResize = "TRUNCATE";
    return tempNode
}

function processBlendMode(blendMode: BlendMode | string) {
    var resultBlenderMode = blendMode
    if (resultBlenderMode == "PLUS_DARKER" || resultBlenderMode == "PASS_THROUGH") resultBlenderMode = "NORMAL"
    return resultBlenderMode
}