/// <reference types="@mastergo/plugin-typings" />

let totalNodes = 0;
let processedNodes = 0;
let loadingNotify: NotificationHandler | null = null;
let lastNotifyAt = 0;

const INTERNAL_PROPS_PREFIX = "[PROPS]";
const SIBLING_PROPS_PREFIX = "[PROPS_SIBLING]";
const VISUAL_FRAME_SOURCE_TYPES = ["COMPONENT", "COMPONENT_SET", "INSTANCE"];

const COMMAND_ALL_PAGES = "all-pages";
const COMMAND_SELECTED = "selected";

processByCommand(mg.command);

function countNodes(node: any) {
    totalNodes++;
    if (node.children) {
        for (const child of node.children) countNodes(child);
    }
}

async function processByCommand(command: string) {
    if (command === COMMAND_ALL_PAGES) {
        await processPages([...mg.document.children], "all pages");
        return;
    }

    if (command === COMMAND_SELECTED) {
        await processSelectedNodes();
        return;
    }

    await processPages([mg.document.currentPage], "current page");
}

async function processSelectedNodes() {
    try {
        totalNodes = 0;
        processedNodes = 0;

        const selectedNodes = getTopLevelSelectedNodes(mg.document.currentPage.selection as SceneNode[]);
        if (selectedNodes.length === 0) {
            mg.notify("请先选择要转换的图层", {
                position: "bottom",
                timeout: 3000,
                type: "warning"
            });
            return;
        }

        setLoading(`准备转换已选中图层 (${selectedNodes.length})...`, true);
        for (const node of selectedNodes) countNodes(node);

        const processPage = mg.createPage();
        processPage.name = `${mg.document.currentPage.name}_Process_Selected_${selectedNodes.length}`;
        copyPageProperties(mg.document.currentPage, processPage);

        await transformSelectedNodesIncrementally(selectedNodes, processPage);
        finishLoading("转换完成", "success");
    } catch (error) {
        console.error("Error processing selected nodes:", error);
        finishLoading("转换失败，请查看控制台", "error");
    }
}

async function processPages(pages: any[], label: string) {
    try {
        totalNodes = 0;
        processedNodes = 0;
        setLoading(`准备转换 ${label === "all pages" ? "所有页面" : "当前页"}...`, true);

        for (const page of pages) {
            if (page.name.endsWith("_Process")) continue;
            countNodes(page);
        }

        const sourcePages = pages.filter(page => !page.name.endsWith("_Process"));
        for (let pageIndex = 0; pageIndex < sourcePages.length; pageIndex++) {
            const page = sourcePages[pageIndex];
            if (page.name.endsWith("_Process")) continue;

            setLoading(`正在创建处理页 ${pageIndex + 1}/${sourcePages.length}: ${page.name}`, true);

            const processPage = mg.createPage();
            processPage.name = page.name + "_Process";
            copyPageProperties(page, processPage);

            await transformPageNodesIncrementally(page, processPage, pageIndex + 1, sourcePages.length);
        }
        finishLoading("转换完成", "success");
    } catch (error) {
        console.error(`Error processing ${label}:`, error);
        finishLoading("转换失败，请查看控制台", "error");
    }
}

async function transformPageNodesIncrementally(sourcePage: any, processPage: any, pageIndex: number, pageCount: number) {
    const children = [...sourcePage.children];
    for (let nodeIndex = 0; nodeIndex < children.length; nodeIndex++) {
        const sourceNode = children[nodeIndex];
        if (sourceNode.name.startsWith(INTERNAL_PROPS_PREFIX) || sourceNode.name.startsWith(SIBLING_PROPS_PREFIX)) continue;

        setLoading(`转换页面 ${pageIndex}/${pageCount}：${sourcePage.name} (${nodeIndex + 1}/${children.length})`);

        const clonedNode = sourceNode.clone();
        processPage.appendChild(clonedNode);
        await transformNodeRecursive(clonedNode);
        await yieldToEventLoop();
    }
}

async function transformSelectedNodesIncrementally(selectedNodes: SceneNode[], processPage: any) {
    for (let nodeIndex = 0; nodeIndex < selectedNodes.length; nodeIndex++) {
        const sourceNode = selectedNodes[nodeIndex];
        if (sourceNode.name.startsWith(INTERNAL_PROPS_PREFIX) || sourceNode.name.startsWith(SIBLING_PROPS_PREFIX)) continue;

        setLoading(`转换已选中图层 (${nodeIndex + 1}/${selectedNodes.length})：${sourceNode.name}`);

        const sourceTransform = cloneTransform(sourceNode.absoluteTransform || sourceNode.relativeTransform);
        const clonedNode = sourceNode.clone();
        processPage.appendChild(clonedNode);
        (clonedNode as any).relativeTransform = sourceTransform;
        (clonedNode as any).x = sourceTransform[0][2];
        (clonedNode as any).y = sourceTransform[1][2];

        await transformNodeRecursive(clonedNode);
        await yieldToEventLoop();
    }
}

async function transformNodeRecursive(node: SceneNode) {
    try {
        processedNodes++;
        if (processedNodes % 50 === 0 || processedNodes === totalNodes) {
            const progress = Math.round((processedNodes / totalNodes) * 100);
            setLoading(`转换中 ${progress}% (${processedNodes}/${totalNodes})`);
            await yieldToEventLoop();
        }

        // Skip our own generated layers if we rerun or process similar names
        if (node.name.startsWith(INTERNAL_PROPS_PREFIX) || node.name.startsWith(SIBLING_PROPS_PREFIX)) return;

        const isContainer = node.type === "FRAME" ||
            node.type === "GROUP" ||
            node.type === "INSTANCE" ||
            node.type === "COMPONENT" ||
            node.type === "COMPONENT_SET" ||
            node.type === "SECTION";

        if (isContainer) {
            const sourceType = node.type;
            let containerNode = node as any;
            let nodeJson: any = null;

            // Instances are intentionally downgraded to visual frames in this iteration.
            if (node.type === "INSTANCE") {
                containerNode = (node as InstanceNode).detachInstance();
            } else if (sourceType === "GROUP") {
                nodeJson = analyseNodes(node, sourceType);
                containerNode = replaceGroupWithFrame(node as any);
            } else if (sourceType === "COMPONENT_SET") {
                nodeJson = analyseNodes(node, sourceType);
                containerNode = replaceComponentSetWithFrame(node as any);
            }

            // Generate PROPS node for container to preserve styles and type
            if (!nodeJson) nodeJson = analyseNodes(containerNode, sourceType);

            if (shouldUseSiblingProps(containerNode)) {
                await insertSiblingPropsMarker(containerNode, nodeJson);
            } else {
                const carrierFrame = createJsonCarrierFrame(INTERNAL_PROPS_PREFIX + JSON.stringify([nodeJson, []]));

                if ('insertChild' in containerNode) {
                    containerNode.insertChild(0, carrierFrame);
                } else {
                    containerNode.appendChild(carrierFrame);
                }

                (carrierFrame as any).width = 1;
                (carrierFrame as any).height = 1;
                carrierFrame.x = 0;
                carrierFrame.y = 0;
            }

            const children = [...containerNode.children];
            for (const child of children) {
                if (child.name.startsWith(INTERNAL_PROPS_PREFIX) || child.name.startsWith(SIBLING_PROPS_PREFIX)) continue;
                await transformNodeRecursive(child as SceneNode);
            }
        } else {
            // For leaf nodes, replace with a Frame node whose name contains full property JSON.
            const nodeParent = node.parent;
            const nodeWidth = node.width;
            const nodeHeight = node.height;
            const nodeTransform = node.relativeTransform;

            const nodeJson = analyseNodes(node);
            overrideLayoutTransform(nodeJson, nodeTransform);
            const carrierFrame = createJsonCarrierFrame(JSON.stringify([nodeJson, []]));

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
                    (nodeParent as any).insertChild(index, carrierFrame);
                } else {
                    (nodeParent as any).appendChild(carrierFrame);
                }

                // Set dimensions and position exactly as the original
                (carrierFrame as any).width = nodeWidth;
                (carrierFrame as any).height = nodeHeight;
                carrierFrame.relativeTransform = nodeTransform;

                if (!node.removed) node.remove();
            }
        }
    } catch (error) {
        console.error("Error processing node:", node.name, error);
    }
}

function copyPageProperties(sourcePage: any, processPage: any) {
    try {
        processPage.bgColor = sourcePage.bgColor;
    } catch (error) {
        console.warn("Unable to copy page background:", sourcePage.name, error);
    }

    try {
        processPage.label = sourcePage.label;
    } catch (error) {
        console.warn("Unable to copy page label:", sourcePage.name, error);
    }
}

function setLoading(message: string, force = false) {
    const now = Date.now();
    if (!force && now - lastNotifyAt < 500) return;

    lastNotifyAt = now;
    if (loadingNotify) loadingNotify.cancel();
    loadingNotify = mg.notify(message, {
        position: "bottom",
        timeout: 30 * 1000,
        isLoading: true
    });
}

function finishLoading(message: string, type: "success" | "error") {
    if (loadingNotify) {
        loadingNotify.cancel();
        loadingNotify = null;
    }

    mg.notify(message, {
        position: "bottom",
        timeout: 3000,
        type
    });
}

function yieldToEventLoop() {
    return new Promise<void>(resolve => setTimeout(resolve, 0));
}

function getTopLevelSelectedNodes(selection: SceneNode[]) {
    const selectedSet = new Set(selection.map(node => node.id));
    return selection.filter(node => !hasSelectedAncestor(node, selectedSet));
}

function hasSelectedAncestor(node: SceneNode, selectedSet: Set<string>) {
    let parent = node.parent as any;
    while (parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT") {
        if (selectedSet.has(parent.id)) return true;
        parent = parent.parent;
    }
    return false;
}

async function insertSiblingPropsMarker(node: SceneNode, nodeJson: any) {
    const nodeParent = node.parent;
    if (!nodeParent || !('insertChild' in nodeParent)) return;

    const carrierFrame = createJsonCarrierFrame(SIBLING_PROPS_PREFIX + JSON.stringify([nodeJson, []]));

    const childrenList = nodeParent.children;
    let index = -1;
    for (let i = 0; i < childrenList.length; i++) {
        if (childrenList[i].id === node.id) {
            index = i;
            break;
        }
    }

    if (index !== -1) {
        (nodeParent as any).insertChild(index, carrierFrame);
    } else {
        (nodeParent as any).appendChild(carrierFrame);
    }

    (carrierFrame as any).width = 1;
    (carrierFrame as any).height = 1;
    carrierFrame.relativeTransform = node.relativeTransform;
}

function shouldUseSiblingProps(node: any) {
    return !('insertChild' in node);
}

function replaceGroupWithFrame(node: SceneNode) {
    const parent = node.parent as any;
    if (!parent || !('insertChild' in parent)) return node as any;

    const frame = createVisualFrameFromContainer(node);
    const childrenList = parent.children;
    const index = getChildIndex(parent, node);
    parent.insertChild(index !== -1 ? index : childrenList.length, frame);

    const children = [...((node as any).children || [])].map((child: SceneNode) => ({
        node: child,
        relativeTransform: cloneTransform(child.relativeTransform),
        x: (child as any).x,
        y: (child as any).y
    }));

    let movedChildren = 0;
    for (const child of children) {
        try {
            frame.appendChild(child.node);
            restoreLocalTransform(child.node, child.relativeTransform, child.x, child.y);
            movedChildren++;
        } catch (error) {
            console.error("Unable to move group child into visual frame:", child.node.name, error);
        }
    }

    if (children.length > 0 && movedChildren === 0) {
        if (!frame.removed) frame.remove();
        return node as any;
    }

    if (!node.removed) node.remove();
    return frame;
}

function replaceComponentSetWithFrame(node: SceneNode) {
    const parent = node.parent as any;
    if (!parent || !('insertChild' in parent)) return node as any;

    const frame = createVisualFrameFromContainer(node);
    const childrenList = parent.children;
    const index = getChildIndex(parent, node);

    parent.insertChild(index !== -1 ? index : childrenList.length, frame);

    const nodeAbsoluteTransform = cloneTransform(node.absoluteTransform);
    const nodeInverseTransform = invertTransform(nodeAbsoluteTransform);
    const children = [...((node as any).children || [])].map((child: SceneNode) => ({
        node: child,
        relativeTransform: multiplyTransform(nodeInverseTransform, cloneTransform(child.absoluteTransform))
    }));
    let movedChildren = 0;
    for (const child of children) {
        try {
            frame.appendChild(child.node);
            restoreLocalTransform(child.node, child.relativeTransform, child.relativeTransform[0][2], child.relativeTransform[1][2]);
            movedChildren++;
        } catch (error) {
            console.error("Unable to move component child into visual frame:", child.node.name, error);
        }
    }

    if (children.length > 0 && movedChildren === 0) {
        if (!frame.removed) frame.remove();
        return node as any;
    }

    if (!node.removed) node.remove();
    return frame;
}

function createVisualFrameFromContainer(node: SceneNode) {
    const frame = mg.createFrame();
    frame.name = node.name;
    frame.isVisible = node.isVisible;
    frame.isLocked = node.isLocked;
    (frame as any).fills = [];
    frame.relativeTransform = cloneTransform(node.relativeTransform);
    (frame as any).x = (node as any).x;
    (frame as any).y = (node as any).y;
    (frame as any).width = node.width;
    (frame as any).height = node.height;
    return frame;
}

function getChildIndex(parent: any, node: SceneNode) {
    const childrenList = parent.children || [];
    for (let i = 0; i < childrenList.length; i++) {
        if (childrenList[i].id === node.id) return i;
    }
    return -1;
}

function restoreLocalTransform(node: SceneNode, transform: Transform, x?: number, y?: number) {
    (node as any).relativeTransform = cloneTransform(transform);
    (node as any).x = x ?? transform[0][2];
    (node as any).y = y ?? transform[1][2];
}

function analyseNodes(node: SceneNode, sourceType?: string): any {
    const resolvedSourceType = sourceType || node.type;
    var finalNodeJson: any = ""
    if (resolvedSourceType == "BOOLEAN_OPERATION" && node.type == "BOOLEAN_OPERATION") {
        finalNodeJson = transBONode(node)
    } else if (resolvedSourceType == "COMPONENT") {
        finalNodeJson = transFrameNode(node as ComponentNode, resolvedSourceType)
    } else if (resolvedSourceType == "COMPONENT_SET") {
        finalNodeJson = transFrameNode(node as any, resolvedSourceType)
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
        finalNodeJson = transFrameNode(node as FrameNode, resolvedSourceType)
    } else if (node.type == "GROUP") {
        finalNodeJson = transGroupNode(node as GroupNode)
    } else if (resolvedSourceType == "INSTANCE") {
        finalNodeJson = transFrameNode(node as InstanceNode, resolvedSourceType)
    } else if (node.type == "SECTION") {
        finalNodeJson = transSectionNode(node as SectionNode)
    } else if (node.type == "SLICE") {
        finalNodeJson = transSliceNode(node as SliceNode)
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

    // Boolean source children are intentionally not serialized in this iteration.
    const json: any = transPenNode(flattedShapeNode as PenNode, "BOOLEAN_OPERATION", "PEN");
    json.booleanOperation = node.booleanOperation;
    flattedShapeNode.remove();
    return json;
}

function transPenNode(selection: PenNode, sourceType?: string, restoreType?: string) {
    const universalStruct = getUniversalProperty(selection, sourceType, restoreType)
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

function transFrameNode(selection: FrameNode | InstanceNode | ComponentNode, sourceType?: string) {
    const universalStruct = getUniversalProperty(selection, sourceType)
    const otherStruct = { "clipsContent": (selection as any).clipsContent }
    return Object.assign(otherStruct, universalStruct)
}

function transSectionNode(selection: SectionNode) {
    const universalStruct = getUniversalProperty(selection, "SECTION", "SECTION")
    const otherStruct = { "clipsContent": (selection as any).clipsContent }
    return Object.assign(otherStruct, universalStruct)
}

function transGroupNode(selection: GroupNode) {
    const universalStruct = getUniversalProperty(selection, "GROUP", "GROUP")
    const otherStruct = { "clipsContent": false }
    return Object.assign(otherStruct, universalStruct)
}

function transSliceNode(selection: SliceNode) {
    return getUniversalProperty(selection, "SLICE", "SLICE")
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
            if (tempResultFill.type) resultFills.push(tempResultFill)
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
            if (tempResultStroke.type) resultStrokes.push(tempResultStroke)
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

function getUniversalProperty(selection: SceneNode, sourceType?: string, restoreType?: string) {
    const resolvedSourceType = sourceType || selection.type
    const resolvedRestoreType = restoreType || getRestoreType(resolvedSourceType)
    const layoutTransform = getRelativeLayoutTransform(selection)
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
        "type": resolvedRestoreType,
        "sourceType": resolvedSourceType,
        "restoreType": resolvedRestoreType,
        "id": selection.id,
        "name": selection.name,
        "parentID": (selection.parent && selection.parent.type == "PAGE" ? null : selection.parent?.id),
        "constraints": (selection as any).constraints,
        "exportSettings": (selection as any).exportSettings || [],
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
            "relativeTransform": layoutTransform,
            "x": layoutTransform[0][2], "y": layoutTransform[1][2],
            "rotation": -(selection as any).rotation || 0,
            "width": selection.width, "height": selection.height,
            "constrainProportions": (selection as any).constrainProportions || false,
            "layoutMode": getLayoutMode(selection as any),
            "itemSpacing": (selection as any).itemSpacing || 0,
            "paddingLeft": (selection as any).paddingLeft || 0,
            "paddingRight": (selection as any).paddingRight || 0,
            "paddingTop": (selection as any).paddingTop || 0,
            "paddingBottom": (selection as any).paddingBottom || 0,
            "primaryAxisAlignItems": getAxisAlign((selection as any).primaryAxisAlignItems || (selection as any).mainAxisAlignItems || "MIN"),
            "counterAxisAlignItems": getAxisAlign((selection as any).counterAxisAlignItems || (selection as any).crossAxisAlignItems || "MIN"),
            "counterAxisAlignContent": getCounterAxisAlignContent(selection as any),
            "primaryAxisSizingMode": (selection as any).primaryAxisSizingMode || (selection as any).mainAxisSizingMode || "FIXED",
            "counterAxisSizingMode": (selection as any).counterAxisSizingMode || (selection as any).crossAxisSizingMode || "FIXED",
            "itemReverseZIndex": (selection as any).itemReverseZIndex || false,
            "strokesIncludedInLayout": (selection as any).strokesIncludedInLayout || false,
            "layoutAlign": getLayoutAlign((selection as any).layoutAlign || (selection as any).alignSelf || "INHERIT"),
            "layoutGrow": (selection as any).layoutGrow ?? (selection as any).flexGrow ?? 0,
            "layoutPositioning": (selection as any).layoutPositioning || "AUTO"
        }
    }
}

function getRelativeLayoutTransform(selection: SceneNode) {
    // MasterGo reports absoluteTransform inconsistently for some grouped node
    // types. The node's own relativeTransform is the reliable local transform
    // and is also what we use when replacing the layer with a JSON text marker.
    return cloneTransform(selection.relativeTransform);
}

function overrideLayoutTransform(nodeJson: any, transform: Transform) {
    if (!nodeJson || !nodeJson.layout || !transform) return;

    const layoutTransform = cloneTransform(transform);
    nodeJson.layout.relativeTransform = layoutTransform;
    nodeJson.layout.x = layoutTransform[0][2];
    nodeJson.layout.y = layoutTransform[1][2];
}

function cloneTransform(transform: Transform): Transform {
    return [
        [transform[0][0], transform[0][1], transform[0][2]],
        [transform[1][0], transform[1][1], transform[1][2]]
    ];
}

function getRestoreType(sourceType: string) {
    if (VISUAL_FRAME_SOURCE_TYPES.indexOf(sourceType) !== -1) return "FRAME";
    if (sourceType === "BOOLEAN_OPERATION") return "VECTOR";
    return sourceType;
}

function getLayoutMode(selection: any) {
    const layoutMode = selection.layoutMode || selection.flexMode || "NONE";
    if (layoutMode === "ROW") return "HORIZONTAL";
    if (layoutMode === "COLUMN") return "VERTICAL";
    return layoutMode;
}

function getAxisAlign(value: string) {
    if (value === "FLEX_START") return "MIN";
    if (value === "FLEX_END") return "MAX";
    if (value === "SPACING_BETWEEN") return "SPACE_BETWEEN";
    return value;
}

function getCounterAxisAlignContent(selection: any) {
    return selection.counterAxisAlignContent || selection.crossAxisAlignContent || "AUTO";
}

function getLayoutAlign(value: string) {
    if (value === "STRETCH" || value === "INHERIT") return value;
    return getAxisAlign(value);
}

function multiplyTransform(a: Transform, b: Transform): Transform {
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

function invertTransform(transform: Transform): Transform {
    const a = transform[0][0];
    const b = transform[0][1];
    const c = transform[0][2];
    const d = transform[1][0];
    const e = transform[1][1];
    const f = transform[1][2];
    const det = a * e - b * d;

    if (Math.abs(det) < 0.000001) return [[1, 0, 0], [0, 1, 0]];

    return [
        [e / det, -b / det, (b * f - e * c) / det],
        [-d / det, a / det, (d * c - a * f) / det]
    ];
}

function createJsonCarrierFrame(name: string) {
    const frame = mg.createFrame();
    frame.name = name;
    frame.fills = [{
        type: "SOLID",
        color: { r: 0, g: 0, b: 0, a: 0.1 }
    }];
    return frame;
}

function processBlendMode(blendMode: BlendMode | string) {
    var resultBlenderMode = blendMode
    if (resultBlenderMode == "PLUS_DARKER" || resultBlenderMode == "PASS_THROUGH") resultBlenderMode = "NORMAL"
    return resultBlenderMode
}
