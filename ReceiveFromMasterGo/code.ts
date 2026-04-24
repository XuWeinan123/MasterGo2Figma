
let documentFonts: Font[] = [];

receive();

async function receive() {
  figma.notify("Restoring layers on current page...", { timeout: 1000 });

  const nodes = [...figma.currentPage.children];
  for (const node of nodes) {
    await processNodeRecursive(node);
  }

  figma.notify("Restore complete!");
  figma.closePlugin();
}

async function processNodeRecursive(node: BaseNode) {
  if (node.type === "TEXT") {
    const textNode = node as TextNode;
    let data: any = null;

    try {
      const parsed = JSON.parse(textNode.characters);
      if (Array.isArray(parsed) && parsed.length >= 2) {
        data = parsed[0];
      }
    } catch (e) {
      return;
    }

    if (!data) return;

    if (textNode.name.startsWith("[PROPS]")) {
      const parent = textNode.parent;
      if (parent && (parent.type === "FRAME" || parent.type === "GROUP" || parent.type === "SECTION" || parent.type === "INSTANCE" || parent.type === "COMPONENT" || parent.type === "COMPONENT_SET")) {
        await applyProperties(parent as any, data);
        textNode.remove();
      }
    } else {
      // Replace the TextNode with the real Figma node
      const parent = textNode.parent;
      if (parent && 'insertChild' in parent) {
        const index = parent.children.indexOf(textNode);
        const newNode = await createNodeFromData(data);
        if (newNode) {
          (parent as any).insertChild(index, newNode);
          await applyProperties(newNode, data);
          textNode.remove();
        }
      }
    }
  } else if ("children" in node) {
    const children = [...(node as any).children];
    for (const child of children) {
      await processNodeRecursive(child);
    }
  }
}

async function createNodeFromData(data: any): Promise<SceneNode | null> {
  let node: SceneNode | null = null;
  const type = data.type;

  switch (type) {
    case "PEN":
    case "VECTOR":
      const vector = figma.createVector();
      if (data.vectorNetwork) vector.vectorNetwork = data.vectorNetwork;
      node = vector;
      break;
    case "ELLIPSE":
      const ellipse = figma.createEllipse();
      if (data.arcData) ellipse.arcData = data.arcData;
      node = ellipse;
      break;
    case "RECTANGLE":
      node = figma.createRectangle();
      break;
    case "STAR":
      const star = figma.createStar();
      star.pointCount = data.pointCount || 5;
      star.innerRadius = data.innerRadius || 0.38;
      node = star;
      break;
    case "LINE":
      node = figma.createLine();
      break;
    case "POLYGON":
      const polygon = figma.createPolygon();
      polygon.pointCount = data.pointCount || 3;
      node = polygon;
      break;
    case "TEXT":
      node = figma.createText();
      break;
    case "FRAME":
    case "INSTANCE":
    case "COMPONENT":
    case "COMPONENT_SET":
      node = figma.createFrame();
      break;
    case "GROUP":
      // Group creation requires children. In this workflow, we usually apply properties
      // to an existing group pasted from MasterGo. If we must create one, we start
      // with a dummy frame and then we might need to regroup later, but for now
      // let's create a frame as a placeholder if it's a leaf node.
      // However, groups are usually containers.
      node = figma.createFrame();
      node.name = "GROUP_PLACEHOLDER";
      break;
    default:
      console.log("Unsupported type:", type);
      break;
  }

  return node;
}

async function applyProperties(node: any, data: any) {
  if (!node || !data) return;

  node.name = data.name;

  if (data.scence) {
    node.visible = data.scence.visible ?? true;
    node.locked = data.scence.locked ?? false;
  }

  if (data.blend) {
    node.opacity = data.blend.opacity ?? 1;
    node.isMask = data.blend.isMask ?? false;
    node.blendMode = data.blend.blendMode || "NORMAL";
    if (data.blend.effects) node.effects = data.blend.effects;
  }

  // Groups in Figma do not support corner radius or geometry (fills/strokes)
  const isGroup = node.type === "GROUP";

  if (!isGroup && data.corner && node.type !== "LINE" && node.type !== "TEXT") {
    if (data.corner.cornerRadius === -1) {
      if ("topLeftRadius" in node) {
        node.topLeftRadius = data.corner.topLeftRadius || 0;
        node.topRightRadius = data.corner.topRightRadius || 0;
        node.bottomLeftRadius = data.corner.bottomLeftRadius || 0;
        node.bottomRightRadius = data.corner.bottomRightRadius || 0;
      }
    } else {
      if ("cornerRadius" in node) node.cornerRadius = data.corner.cornerRadius || 0;
    }
    if ("cornerSmoothing" in node) node.cornerSmoothing = data.corner.cornerSmoothing || 0;
  }

  if (!isGroup && data.geometry) {
    if (data.geometry.fills) node.fills = data.geometry.fills;
    if (data.geometry.strokes) node.strokes = data.geometry.strokes;
    if (data.geometry.strokeWeight !== undefined) node.strokeWeight = data.geometry.strokeWeight;
    if (data.geometry.strokeAlign) node.strokeAlign = data.geometry.strokeAlign;
    if (data.geometry.strokeJoin) node.strokeJoin = data.geometry.strokeJoin;
    if (data.geometry.dashPattern) node.dashPattern = data.geometry.dashPattern;
    if (data.geometry.strokeCap) node.strokeCap = data.geometry.strokeCap;
  }

  if (data.layout) {
    if (data.layout.relativeTransform) node.relativeTransform = data.layout.relativeTransform;
    if (data.layout.width !== undefined && data.layout.height !== undefined) {
      if (isGroup) {
        // Group resize is different, but for now we trust relativeTransform
      } else {
        node.resize(data.layout.width, data.layout.height);
      }
    }

    // Auto layout properties
    if (!isGroup && "layoutMode" in node) {
      if (data.layout.layoutMode) node.layoutMode = data.layout.layoutMode;
      if (data.layout.itemSpacing !== undefined) node.itemSpacing = data.layout.itemSpacing;
      if (data.layout.paddingLeft !== undefined) node.paddingLeft = data.layout.paddingLeft;
      if (data.layout.paddingRight !== undefined) node.paddingRight = data.layout.paddingRight;
      if (data.layout.paddingTop !== undefined) node.paddingTop = data.layout.paddingTop;
      if (data.layout.paddingBottom !== undefined) node.paddingBottom = data.layout.paddingBottom;
      if (data.layout.primaryAxisAlignItems) node.primaryAxisAlignItems = data.layout.primaryAxisAlignItems;
      if (data.layout.counterAxisAlignItems) node.counterAxisAlignItems = data.layout.counterAxisAlignItems;
      if (data.layout.primaryAxisSizingMode) node.primaryAxisSizingMode = data.layout.primaryAxisSizingMode;
      if (data.layout.counterAxisSizingMode) node.counterAxisSizingMode = data.layout.counterAxisSizingMode;
      if (data.layout.itemReverseZIndex !== undefined) node.itemReverseZIndex = data.layout.itemReverseZIndex;
      if (data.layout.strokesIncludedInLayout !== undefined) node.strokesIncludedInLayout = data.layout.strokesIncludedInLayout;
    }

    // Individual layout properties for children
    if ("layoutAlign" in node && data.layout.layoutAlign) node.layoutAlign = data.layout.layoutAlign;
    if ("layoutGrow" in node && data.layout.layoutGrow !== undefined) node.layoutGrow = data.layout.layoutGrow;
    if ("layoutPositioning" in node && data.layout.layoutPositioning) node.layoutPositioning = data.layout.layoutPositioning;
  }

  if ('clipsContent' in node && data.clipsContent !== undefined) {
    node.clipsContent = data.clipsContent;
  }

  if (node.type === "TEXT" && data.characters !== undefined) {
    await applyTextProperties(node, data);
  }
}

async function applyTextProperties(node: TextNode, data: any) {
  if (documentFonts.length === 0) {
    documentFonts = await figma.listAvailableFontsAsync();
  }

  const family = data.fontName?.family || "Inter";
  const style = data.fontName?.style || "Regular";
  let isFontExist = documentFonts.some(f => f.fontName.family === family && f.fontName.style === style);

  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  if (isFontExist) await figma.loadFontAsync({ family, style });
  else node.name = "[Font Missing][" + family + "][" + style + "] " + node.name;

  node.textAlignHorizontal = data.textAlignHorizontal || "LEFT";
  node.textAlignVertical = data.textAlignVertical || "TOP";
  node.textAutoResize = data.textAutoResize || "NONE";
  node.paragraphIndent = data.paragraphIndent || 0;
  node.paragraphSpacing = data.paragraphSpacing || 0;
  node.autoRename = data.autoRename || false;
  node.fontSize = data.fontSize || 12;
  node.fontName = isFontExist ? { family, style } : { family: "Inter", style: "Regular" };
  node.characters = data.characters || "";
  if (data.textCase) node.textCase = data.textCase;
  if (data.textDecoration) node.textDecoration = data.textDecoration;
  if (data.letterSpacing) node.letterSpacing = data.letterSpacing;
  if (data.lineHeight) node.lineHeight = data.lineHeight;
}