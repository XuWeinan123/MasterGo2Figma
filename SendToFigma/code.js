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
let loadingNotify = null;
let lastNotifyAt = 0;
const INTERNAL_PROPS_PREFIX = "[PROPS]";
const SIBLING_PROPS_PREFIX = "[PROPS_SIBLING]";
const VISUAL_FRAME_SOURCE_TYPES = ["COMPONENT", "COMPONENT_SET", "INSTANCE"];
const COMMAND_CURRENT_PAGE = "current-page";
const COMMAND_ALL_PAGES = "all-pages";
const COMMAND_SELECTED = "selected";
const COMMAND_WRITE_LAYER_DATA_TEST = "write-layer-data-test";
const COMMAND_READ_LAYER_DATA_TEST = "read-layer-data-test";
const LAYER_DATA_TEST_KEY = "mastergo2figma.layerDataTest";
processByCommand(mg.command);
function countNodes(node) {
    totalNodes++;
    if (node.children) {
        for (const child of node.children)
            countNodes(child);
    }
}
function processByCommand(command) {
    return __awaiter(this, void 0, void 0, function* () {
        if (command === COMMAND_WRITE_LAYER_DATA_TEST) {
            writeLayerDataTest();
            return;
        }
        if (command === COMMAND_READ_LAYER_DATA_TEST) {
            readLayerDataTest();
            return;
        }
        if (command === COMMAND_ALL_PAGES) {
            yield processPages([...mg.document.children], "all pages");
            return;
        }
        if (command === COMMAND_SELECTED) {
            yield processSelectedNodes();
            return;
        }
        yield processPages([mg.document.currentPage], "current page");
    });
}
function writeLayerDataTest() {
    const selectedNodes = getTopLevelSelectedNodes(mg.document.currentPage.selection);
    if (selectedNodes.length === 0) {
        mg.notify("请先选择一个 Rectangle 和一个 Component", {
            position: "bottom",
            timeout: 3000,
            type: "warning"
        });
        return;
    }
    const writtenAt = new Date().toISOString();
    let rectangleCount = 0;
    let componentCount = 0;
    for (const node of selectedNodes) {
        if (node.type === "RECTANGLE" || node.type === "FRAME") {
            const payload = JSON.stringify(createLayerDataTestPayload(node, "rectangle-plugin-data", writtenAt));
            try {
                node.setPluginData(LAYER_DATA_TEST_KEY, "这是通过插件写入的内容：\n" + payload);
                rectangleCount++;
                console.log("[LayerDataTest][MasterGo write][rectangle pluginData]", node.name, payload);
            }
            catch (error) {
                console.warn("Unable to write rectangle plugin data:", node.name, error);
            }
            continue;
        }
        if (node.type === "COMPONENT") {
            const description = JSON.stringify(createLayerDataTestPayload(node, "component-description", writtenAt));
            try {
                node.description = "这是通过插件写入的内容：\n" + description;
                componentCount++;
                console.log("[LayerDataTest][MasterGo write][component description]", node.name, description);
            }
            catch (error) {
                console.warn("Unable to write component description:", node.name, error);
            }
        }
    }
    mg.notify(`测试数据已写入：Rectangle pluginData ${rectangleCount}，Component description ${componentCount}`, {
        position: "bottom",
        timeout: 5000,
        type: rectangleCount > 0 || componentCount > 0 ? "success" : "warning"
    });
}
function readLayerDataTest() {
    const selectedNodes = getTopLevelSelectedNodes(mg.document.currentPage.selection);
    if (selectedNodes.length === 0) {
        mg.notify("请先选择要读取的 Rectangle 或 Component", {
            position: "bottom",
            timeout: 3000,
            type: "warning"
        });
        return;
    }
    let readableCount = 0;
    for (const node of selectedNodes) {
        if (node.type === "RECTANGLE") {
            const value = node.getPluginData(LAYER_DATA_TEST_KEY);
            if (value)
                readableCount++;
            console.log("[LayerDataTest][MasterGo read][rectangle pluginData]", {
                nodeName: node.name,
                nodeType: node.type,
                pluginDataKeys: node.getPluginDataKeys(),
                pluginDataValue: value
            });
            continue;
        }
        if (node.type === "COMPONENT") {
            const description = node.description || "";
            if (description)
                readableCount++;
            console.log("[LayerDataTest][MasterGo read][component description]", {
                nodeName: node.name,
                nodeType: node.type,
                description
            });
        }
    }
    mg.notify(`读取完成：${readableCount}/${selectedNodes.length} 个选中图层有测试数据，请看控制台`, {
        position: "bottom",
        timeout: 5000,
        type: readableCount > 0 ? "success" : "warning"
    });
}
function createLayerDataTestPayload(node, target, writtenAt) {
    return {
        version: 1,
        writtenBy: "MasterGo SendToFigma",
        writtenAt,
        target,
        key: LAYER_DATA_TEST_KEY,
        node: {
            id: node.id,
            name: node.name,
            type: node.type
        },
        message: "MasterGo to Sketch to Figma retention test"
    };
}
function processSelectedNodes() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            totalNodes = 0;
            processedNodes = 0;
            const selectedNodes = getTopLevelSelectedNodes(mg.document.currentPage.selection);
            if (selectedNodes.length === 0) {
                mg.notify("请先选择要转换的图层", {
                    position: "bottom",
                    timeout: 3000,
                    type: "warning"
                });
                return;
            }
            setLoading(`准备转换已选中图层 (${selectedNodes.length})...`, true);
            for (const node of selectedNodes)
                countNodes(node);
            const processPage = mg.createPage();
            processPage.name = `${mg.document.currentPage.name}_Process_Selected_${selectedNodes.length}`;
            copyPageProperties(mg.document.currentPage, processPage);
            yield transformSelectedNodesIncrementally(selectedNodes, processPage);
            finishLoading("转换完成", "success");
        }
        catch (error) {
            console.error("Error processing selected nodes:", error);
            finishLoading("转换失败，请查看控制台", "error");
        }
    });
}
function processPages(pages, label) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            totalNodes = 0;
            processedNodes = 0;
            setLoading(`准备转换 ${label === "all pages" ? "所有页面" : "当前页"}...`, true);
            for (const page of pages) {
                if (page.name.endsWith("_Process"))
                    continue;
                countNodes(page);
            }
            const sourcePages = pages.filter(page => !page.name.endsWith("_Process"));
            for (let pageIndex = 0; pageIndex < sourcePages.length; pageIndex++) {
                const page = sourcePages[pageIndex];
                if (page.name.endsWith("_Process"))
                    continue;
                setLoading(`正在创建处理页 ${pageIndex + 1}/${sourcePages.length}: ${page.name}`, true);
                const processPage = mg.createPage();
                processPage.name = page.name + "_Process";
                copyPageProperties(page, processPage);
                yield transformPageNodesIncrementally(page, processPage, pageIndex + 1, sourcePages.length);
            }
            finishLoading("转换完成", "success");
        }
        catch (error) {
            console.error(`Error processing ${label}:`, error);
            finishLoading("转换失败，请查看控制台", "error");
        }
    });
}
function transformPageNodesIncrementally(sourcePage, processPage, pageIndex, pageCount) {
    return __awaiter(this, void 0, void 0, function* () {
        const children = [...sourcePage.children];
        for (let nodeIndex = 0; nodeIndex < children.length; nodeIndex++) {
            const sourceNode = children[nodeIndex];
            if (sourceNode.name.startsWith(INTERNAL_PROPS_PREFIX) || sourceNode.name.startsWith(SIBLING_PROPS_PREFIX))
                continue;
            setLoading(`转换页面 ${pageIndex}/${pageCount}：${sourcePage.name} (${nodeIndex + 1}/${children.length})`);
            const clonedNode = sourceNode.clone();
            processPage.appendChild(clonedNode);
            yield transformNodeRecursive(clonedNode);
            yield yieldToEventLoop();
        }
    });
}
function transformSelectedNodesIncrementally(selectedNodes, processPage) {
    return __awaiter(this, void 0, void 0, function* () {
        for (let nodeIndex = 0; nodeIndex < selectedNodes.length; nodeIndex++) {
            const sourceNode = selectedNodes[nodeIndex];
            if (sourceNode.name.startsWith(INTERNAL_PROPS_PREFIX) || sourceNode.name.startsWith(SIBLING_PROPS_PREFIX))
                continue;
            setLoading(`转换已选中图层 (${nodeIndex + 1}/${selectedNodes.length})：${sourceNode.name}`);
            const sourceTransform = cloneTransform(sourceNode.absoluteTransform || sourceNode.relativeTransform);
            const clonedNode = sourceNode.clone();
            processPage.appendChild(clonedNode);
            clonedNode.relativeTransform = sourceTransform;
            clonedNode.x = sourceTransform[0][2];
            clonedNode.y = sourceTransform[1][2];
            yield transformNodeRecursive(clonedNode);
            yield yieldToEventLoop();
        }
    });
}
function transformNodeRecursive(node) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            processedNodes++;
            if (processedNodes % 50 === 0 || processedNodes === totalNodes) {
                const progress = Math.round((processedNodes / totalNodes) * 100);
                console.log(`Progress: ${progress}% (${processedNodes}/${totalNodes}) - Current: ${node.name}`);
                setLoading(`转换中 ${progress}% (${processedNodes}/${totalNodes})`);
                yield yieldToEventLoop();
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
                else if (sourceType === "GROUP") {
                    nodeJson = analyseNodes(node, sourceType);
                    containerNode = replaceGroupWithFrame(node);
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
                overrideLayoutTransform(nodeJson, nodeTransform);
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
function copyPageProperties(sourcePage, processPage) {
    try {
        processPage.bgColor = sourcePage.bgColor;
    }
    catch (error) {
        console.warn("Unable to copy page background:", sourcePage.name, error);
    }
    try {
        processPage.label = sourcePage.label;
    }
    catch (error) {
        console.warn("Unable to copy page label:", sourcePage.name, error);
    }
}
function setLoading(message, force = false) {
    const now = Date.now();
    if (!force && now - lastNotifyAt < 500)
        return;
    lastNotifyAt = now;
    if (loadingNotify)
        loadingNotify.cancel();
    loadingNotify = mg.notify(message, {
        position: "bottom",
        timeout: 30 * 1000,
        isLoading: true
    });
}
function finishLoading(message, type) {
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
    return new Promise(resolve => setTimeout(resolve, 0));
}
function getTopLevelSelectedNodes(selection) {
    const selectedSet = new Set(selection.map(node => node.id));
    return selection.filter(node => !hasSelectedAncestor(node, selectedSet));
}
function hasSelectedAncestor(node, selectedSet) {
    let parent = node.parent;
    while (parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT") {
        if (selectedSet.has(parent.id))
            return true;
        parent = parent.parent;
    }
    return false;
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
function replaceGroupWithFrame(node) {
    const parent = node.parent;
    if (!parent || !('insertChild' in parent))
        return node;
    const frame = createVisualFrameFromContainer(node);
    const childrenList = parent.children;
    const index = getChildIndex(parent, node);
    parent.insertChild(index !== -1 ? index : childrenList.length, frame);
    const children = [...(node.children || [])].map((child) => ({
        node: child,
        relativeTransform: cloneTransform(child.relativeTransform),
        x: child.x,
        y: child.y
    }));
    let movedChildren = 0;
    for (const child of children) {
        try {
            frame.appendChild(child.node);
            restoreLocalTransform(child.node, child.relativeTransform, child.x, child.y);
            movedChildren++;
        }
        catch (error) {
            console.error("Unable to move group child into visual frame:", child.node.name, error);
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
function replaceComponentSetWithFrame(node) {
    const parent = node.parent;
    if (!parent || !('insertChild' in parent))
        return node;
    const frame = createVisualFrameFromContainer(node);
    const childrenList = parent.children;
    const index = getChildIndex(parent, node);
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
            restoreLocalTransform(child.node, child.relativeTransform, child.relativeTransform[0][2], child.relativeTransform[1][2]);
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
function createVisualFrameFromContainer(node) {
    const frame = mg.createFrame();
    frame.name = node.name;
    frame.isVisible = node.isVisible;
    frame.isLocked = node.isLocked;
    frame.fills = [];
    frame.relativeTransform = cloneTransform(node.relativeTransform);
    frame.x = node.x;
    frame.y = node.y;
    frame.width = node.width;
    frame.height = node.height;
    return frame;
}
function getChildIndex(parent, node) {
    const childrenList = parent.children || [];
    for (let i = 0; i < childrenList.length; i++) {
        if (childrenList[i].id === node.id)
            return i;
    }
    return -1;
}
function restoreLocalTransform(node, transform, x, y) {
    node.relativeTransform = cloneTransform(transform);
    node.x = x !== null && x !== void 0 ? x : transform[0][2];
    node.y = y !== null && y !== void 0 ? y : transform[1][2];
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
            "counterAxisAlignContent": getCounterAxisAlignContent(selection),
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
    // MasterGo reports absoluteTransform inconsistently for some grouped node
    // types. The node's own relativeTransform is the reliable local transform
    // and is also what we use when replacing the layer with a JSON text marker.
    return cloneTransform(selection.relativeTransform);
}
function overrideLayoutTransform(nodeJson, transform) {
    if (!nodeJson || !nodeJson.layout || !transform)
        return;
    const layoutTransform = cloneTransform(transform);
    nodeJson.layout.relativeTransform = layoutTransform;
    nodeJson.layout.x = layoutTransform[0][2];
    nodeJson.layout.y = layoutTransform[1][2];
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
function getCounterAxisAlignContent(selection) {
    return selection.counterAxisAlignContent || selection.crossAxisAlignContent || "AUTO";
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
