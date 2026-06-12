import { state } from "./state";
import { getReceiveCreateType } from "./layerRules";
import { safeSet, isSceneNode } from "../../shared/utils";
import { applyVectorNetwork } from "./appliers/vector";
import { createConnectorVectorNetworkFromData } from "./appliers/connector";

export function appendRestoredNode(parent: PageNode | SceneNode, node: SceneNode): boolean {
    if ("appendChild" in parent) {
        (parent as any).appendChild(node);
        return true;
    }
    console.warn("Unable to append restored node because parent cannot contain children:", node.name, parent.name);
    safeRemove(node);
    return false;
}

export function isRemovedNode(node: any): boolean {
    return !node || !!node.removed;
}

export function safeRemove(node: BaseNode) {
    if ((node as any).removed) return;

    try {
        node.remove();
    } catch (e) {
        console.warn("Unable to remove node:", node.name, e);
    }
}

export function isShellContainer(node: BaseNode): boolean {
    return node.type === "FRAME" ||
        node.type === "GROUP" ||
        node.type === "SECTION" ||
        node.type === "COMPONENT" ||
        node.type === "INSTANCE" ||
        node.type === "COMPONENT_SET";
}

export function clearMaskFlag(node: SceneNode) {
    const nodeAny = node as any;
    if (!("isMask" in nodeAny)) return;

    try {
        nodeAny.isMask = false;
    } catch (e) {
        console.warn("Unable to clear mask before removing imported rectangle:", node.name, e);
    }
}

export function isInsideInstance(node: BaseNode): boolean {
    let parent = node.parent;
    while (parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT") {
        if (parent.type === "INSTANCE") return true;
        parent = parent.parent;
    }
    return false;
}

export function cleanupImportedContainerShells(root: BaseNode) {
    if (!("children" in root)) return;
    if (isSceneNode(root) && (root.type === "INSTANCE" || isInsideInstance(root))) return;

    const children = [...(root as any).children] as SceneNode[];
    for (const child of children) {
        cleanupImportedContainerShells(child);
    }

    if (!isSceneNode(root) || !isShellContainer(root)) return;

    const shellChildren = [...(root as any).children] as SceneNode[];
    for (const child of shellChildren) {
        if (child.type === "RECTANGLE" && child.name === root.name) {
            clearMaskFlag(child);
            safeRemove(child);
            return;
        }
    }
}

export function hasUsableVectorNetwork(vectorNetwork: any): boolean {
    return !!(vectorNetwork &&
        Array.isArray(vectorNetwork.vertices) &&
        vectorNetwork.vertices.length > 0 &&
        Array.isArray(vectorNetwork.segments));
}

export async function createNodeFromData(data: any): Promise<SceneNode | null> {
    let node: SceneNode | null = null;
    const type = getReceiveCreateType(data);

    try {
        switch (type) {
            case "SVG":
                if (typeof data.svgMarkup === "string" && data.svgMarkup.trim()) {
                    node = figma.createNodeFromSvg(data.svgMarkup);
                } else {
                    node = figma.createFrame();
                }
                break;
            case "PEN":
            case "VECTOR":
                const vector = figma.createVector();
                node = vector;
                break;
            case "ELLIPSE":
                const ellipse = figma.createEllipse();
                node = ellipse;
                if (data.arcData) safeSet(ellipse, "arcData", data.arcData);
                break;
            case "RECTANGLE":
                node = figma.createRectangle();
                break;
            case "STAR":
                const star = figma.createStar();
                node = star;
                safeSet(star, "pointCount", data.pointCount || 5);
                safeSet(star, "innerRadius", data.innerRadius || 0.38);
                break;
            case "LINE":
                node = figma.createLine();
                break;
            case "POLYGON":
                const polygon = figma.createPolygon();
                node = polygon;
                safeSet(polygon, "pointCount", data.pointCount || 3);
                break;
            case "TEXT":
                node = figma.createText();
                break;
            case "SECTION":
                node = figma.createSection();
                break;
            case "COMPONENT":
                node = figma.createComponent();
                break;
            case "SLICE":
                node = figma.createSlice();
                break;
            case "CONNECTOR":
                const connectorVector = figma.createVector();
                node = connectorVector;
                if (!data.connectorFallbackPolyline) data.connectorFallbackPolyline = true;
                if (!hasUsableVectorNetwork(data.vectorNetwork)) {
                    data.vectorNetwork = createConnectorVectorNetworkFromData(data, null);
                }
                if (data.vectorNetwork) applyVectorNetwork(connectorVector, data.vectorNetwork, data);
                state.fallbackConnectorCount++;
                if (!state.connectorFallbackLogged) {
                    state.connectorFallbackLogged = true;
                    console.warn("CONNECTOR restored as VECTOR polyline because createConnector is unavailable/disabled");
                }
                break;
            case "BOOLEAN_OPERATION":
                node = figma.createFrame();
                break;
            case "FRAME":
                node = figma.createFrame();
                break;
            case "GROUP":
                node = figma.createFrame();
                node.name = "GROUP_PLACEHOLDER";
                break;
            default:
                console.warn("Unsupported type:", type);
                break;
        }
    } catch (error) {
        console.warn("Unable to create node, removing partial node:", data?.name || data?.id || type, error);
        if (node) safeRemove(node);
        return null;
    }

    return node;
}
