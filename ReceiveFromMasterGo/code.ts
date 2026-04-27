
let documentFonts: Font[] = [];
const restoredLayoutByNodeId: { [id: string]: any } = {};

const INTERNAL_PROPS_PREFIX = "[PROPS]";
const SIBLING_PROPS_PREFIX = "[PROPS_SIBLING]";
const VISUAL_FRAME_SOURCE_TYPES = ["COMPONENT", "COMPONENT_SET", "INSTANCE"];

const COMMAND_ALL_PAGES = "all-pages";
const COMMAND_SELECTED = "selected";

receive(figma.command);

async function receive(command: string) {
  if (command === COMMAND_SELECTED) {
    await receiveSelectedNodes();
    return;
  }

  const pages = await getPagesToProcess(command);
  figma.notify(command === COMMAND_ALL_PAGES ? "Restoring layers on all pages..." : "Restoring layers on current page...", { timeout: 1000 });

  for (const page of pages) {
    const nodes = [...page.children];
    for (const node of nodes) {
      await processNodeRecursive(node);
    }
    cleanupImportedContainerShells(page);
    applyDeferredSingleChildAutoSpaceAlignmentFixes(page);
  }

  figma.notify("Restore complete!");
  figma.closePlugin();
}

async function receiveSelectedNodes() {
  const nodes = getTopLevelSelectedNodes([...figma.currentPage.selection]);
  if (nodes.length === 0) {
    figma.notify("Please select layers to restore.", { timeout: 2000, error: true });
    figma.closePlugin();
    return;
  }

  figma.notify("Restoring selected layers...", { timeout: 1000 });
  for (const node of nodes) {
    await processNodeRecursive(node);
  }
  cleanupImportedContainerShells(figma.currentPage);
  applyDeferredSingleChildAutoSpaceAlignmentFixes(figma.currentPage);

  figma.notify("Restore complete!");
  figma.closePlugin();
}

async function getPagesToProcess(command: string): Promise<PageNode[]> {
  if (command !== COMMAND_ALL_PAGES) return [figma.currentPage];

  if (typeof (figma as any).loadAllPagesAsync === "function") {
    await (figma as any).loadAllPagesAsync();
  }

  return [...figma.root.children];
}

function getTopLevelSelectedNodes(selection: SceneNode[]) {
  const selectedSet = new Set(selection.map(node => node.id));
  return selection.filter(node => !hasSelectedAncestor(node, selectedSet));
}

function hasSelectedAncestor(node: SceneNode, selectedSet: Set<string>) {
  let parent = node.parent as BaseNode | null;
  while (parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT") {
    if (selectedSet.has(parent.id)) return true;
    parent = parent.parent;
  }
  return false;
}

async function processNodeRecursive(node: BaseNode) {
  if ((node as any).removed) return;

  if (isDataCarrierNode(node)) {
    const data = parseNodeData(node);
    if (data) {
      if (node.name.startsWith(INTERNAL_PROPS_PREFIX)) {
        await applyInternalProps(node, data);
      } else if (node.name.startsWith(SIBLING_PROPS_PREFIX)) {
        await applySiblingProps(node, data);
      } else {
        await replaceDataCarrierNode(node, data);
      }
      return;
    }
  }

  if ("children" in node) {
    const children = [...(node as any).children];
    for (const child of children) {
      await processNodeRecursive(child);
    }
  }
}

function parseNodeData(node: TextNode | FrameNode) {
  try {
    const payload = node.type === "TEXT" ? node.characters : getCarrierFramePayload(node.name);
    const parsed = JSON.parse(payload);
    if (Array.isArray(parsed) && parsed.length >= 2) {
      return parsed[0];
    }
  } catch (e) {
    return null;
  }

  return null;
}

function getCarrierFramePayload(name: string) {
  if (name.startsWith(INTERNAL_PROPS_PREFIX)) return name.slice(INTERNAL_PROPS_PREFIX.length);
  if (name.startsWith(SIBLING_PROPS_PREFIX)) return name.slice(SIBLING_PROPS_PREFIX.length);
  return name;
}

async function applyInternalProps(carrierNode: TextNode | FrameNode, data: any) {
  const parent = carrierNode.parent;
  if (!parent || !isSceneNode(parent)) return;

  const originalTarget = parent as SceneNode;
  const target = await ensurePropsTarget(parent as SceneNode, data);
  if (target) {
    await applyProperties(target as any, data);
    removeImportedContainerShell(target, data);
  }
  safeRemove(carrierNode);

  if (target && (target !== originalTarget || originalTarget.type === "INSTANCE") && "children" in target) {
    await processChildrenRecursive(target);
  }
}

async function applySiblingProps(carrierNode: TextNode | FrameNode, data: any) {
  const parent = carrierNode.parent;
  if (!parent || !("children" in parent)) return;

  const index = parent.children.indexOf(carrierNode);
  const sibling = index >= 0 ? parent.children[index + 1] : null;

  if (sibling && isSceneNode(sibling)) {
    const target = await ensurePropsTarget(sibling, data);
    if (target) {
      await applyProperties(target as any, data);
      removeImportedContainerShell(target, data);
      if ("children" in target) {
        await processChildrenRecursive(target);
      }
    }
  }

  safeRemove(carrierNode);
}

async function processChildrenRecursive(node: BaseNode) {
  if (!("children" in node)) return;

  const children = [...(node as any).children];
  for (const child of children) {
    await processNodeRecursive(child);
  }
}

async function replaceDataCarrierNode(carrierNode: TextNode | FrameNode, data: any) {
  const parent = carrierNode.parent;
  if (parent && 'insertChild' in parent) {
    const index = parent.children.indexOf(carrierNode);
    const newNode = await createNodeFromData(data);
    if (newNode) {
      try {
        (parent as any).insertChild(index, newNode);
      } catch (e) {
        console.warn("Unable to insert restored node:", data.name, e);
        safeRemove(newNode);
        return;
      }
      await applyProperties(newNode, data);
      safeRemove(carrierNode);
    }
  }
}

async function ensurePropsTarget(target: SceneNode, data: any): Promise<SceneNode | null> {
  const restoreType = getRestoreType(data);
  target = detachInstanceForEdit(target);

  if (target.type === restoreType) return target;

  if (restoreType === "SECTION" && "children" in target) {
    return replaceContainerNode(target, figma.createSection());
  }

  if (restoreType === "GROUP") {
    return target;
  }

  // Component semantics are intentionally downgraded to visual frames for now.
  if (restoreType === "FRAME" && VISUAL_FRAME_SOURCE_TYPES.indexOf(data.sourceType || data.type) !== -1 && "children" in target) {
    return replaceContainerNode(target, figma.createFrame());
  }

  return target;
}

function replaceContainerNode(target: SceneNode, replacement: SceneNode): SceneNode {
  if (target.type === "INSTANCE" || isInsideInstance(target)) {
    return target;
  }

  const parent = target.parent;
  if (!parent || !("insertChild" in parent)) return target;

  const index = parent.children.indexOf(target);
  try {
    (parent as any).insertChild(index >= 0 ? index : parent.children.length, replacement);
  } catch (e) {
    console.warn("Unable to insert replacement node:", target.name, e);
    safeRemove(replacement);
    return target;
  }

  let movedChildren = 0;
  let movableChildren = 0;
  if ("children" in target && "appendChild" in replacement) {
    const children = [...(target as any).children];
    for (const child of children) {
      if (isPropsMarker(child)) continue;
      movableChildren++;
      try {
        (replacement as any).appendChild(child);
        movedChildren++;
      } catch (e) {
        console.warn("Unable to move child into replacement node:", child.name, e);
      }
    }
  }

  if (movableChildren > 0 && movedChildren === 0) {
    safeRemove(replacement);
    return target;
  }

  safeRemove(target);
  return replacement;
}

function removeImportedContainerShell(node: SceneNode, data: any) {
  if (!("children" in node) || !isContainerSource(data)) return;
  if (node.type === "INSTANCE" || isInsideInstance(node)) return;

  const children = [...(node as any).children] as SceneNode[];
  for (const child of children) {
    if (isRedundantContainerRectangle(node, child, data)) {
      clearMaskFlag(child);
      safeRemove(child);
      return;
    }
  }
}

function cleanupImportedContainerShells(root: BaseNode) {
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

function isShellContainer(node: SceneNode) {
  return node.type === "FRAME" ||
    node.type === "GROUP" ||
    node.type === "SECTION" ||
    node.type === "COMPONENT" ||
    node.type === "INSTANCE" ||
    node.type === "COMPONENT_SET";
}

function isContainerSource(data: any) {
  const sourceType = data.sourceType || data.type;
  return sourceType === "FRAME" ||
    sourceType === "GROUP" ||
    sourceType === "SECTION" ||
    VISUAL_FRAME_SOURCE_TYPES.indexOf(sourceType) !== -1;
}

function isRedundantContainerRectangle(parent: SceneNode, child: SceneNode, data: any) {
  if (child.type !== "RECTANGLE" || child.name !== data.name) return false;

  // Sketch import materializes Frame/Group backgrounds as a same-name rectangle child.
  // Clip content can materialize the same rectangle as a mask carrier.
  if ((child.parent as any)?.id === parent.id) return true;

  const childAny = child as any;
  const parentAny = parent as any;
  const parentWidth = data.layout?.width ?? parentAny.width;
  const parentHeight = data.layout?.height ?? parentAny.height;

  return isNearlyZero(childAny.x || 0) &&
    isNearlyZero(childAny.y || 0) &&
    isNearlyEqual(childAny.width, parentWidth) &&
    isNearlyEqual(childAny.height, parentHeight);
}

function clearMaskFlag(node: SceneNode) {
  const nodeAny = node as any;
  if (!("isMask" in nodeAny)) return;

  try {
    nodeAny.isMask = false;
  } catch (e) {
    console.warn("Unable to clear mask before removing carrier rectangle:", node.name, e);
  }
}

function detachInstanceForEdit(node: SceneNode): SceneNode {
  if (node.type !== "INSTANCE" || typeof (node as any).detachInstance !== "function") {
    return node;
  }

  try {
    return (node as any).detachInstance();
  } catch (e) {
    console.warn("Unable to detach instance for restore:", node.name, e);
    return node;
  }
}

function safeRemove(node: BaseNode) {
  if ((node as any).removed) return;

  try {
    node.remove();
  } catch (e) {
    console.warn("Unable to remove node:", node.name, e);
  }
}

function isInsideInstance(node: BaseNode) {
  let parent = node.parent;
  while (parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT") {
    if (parent.type === "INSTANCE") return true;
    parent = parent.parent;
  }

  return false;
}

function isNearlyZero(value: number) {
  return Math.abs(value) < 0.01;
}

function isNearlyEqual(a: number, b: number) {
  return Math.abs(a - b) < 0.01;
}

function isPropsMarker(node: BaseNode) {
  return isDataCarrierNode(node) && (node.name.startsWith(INTERNAL_PROPS_PREFIX) || node.name.startsWith(SIBLING_PROPS_PREFIX));
}

function isDataCarrierNode(node: BaseNode): node is TextNode | FrameNode {
  return node.type === "TEXT" || node.type === "FRAME";
}

function isSceneNode(node: BaseNode): node is SceneNode {
  return node.type !== "DOCUMENT" && node.type !== "PAGE";
}

function getRestoreType(data: any) {
  const sourceType = data.sourceType || data.type;
  if (data.restoreType) return data.restoreType;
  if (VISUAL_FRAME_SOURCE_TYPES.indexOf(sourceType) !== -1) return "FRAME";
  if (sourceType === "BOOLEAN_OPERATION") return "VECTOR";
  return data.type;
}

async function createNodeFromData(data: any): Promise<SceneNode | null> {
  let node: SceneNode | null = null;
  const type = getRestoreType(data);

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
    case "SECTION":
      node = figma.createSection();
      break;
    case "SLICE":
      node = figma.createSlice();
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

  return node;
}

async function applyProperties(node: any, data: any) {
  if (!node || !data) return;

  safeSet(node, "name", data.name);

  if (data.scence) {
    safeSet(node, "visible", data.scence.visible ?? true);
    safeSet(node, "locked", data.scence.locked ?? false);
  }

  if (data.blend) {
    safeSet(node, "opacity", data.blend.opacity ?? 1);
    safeSet(node, "isMask", data.blend.isMask ?? false);
    safeSet(node, "blendMode", data.blend.blendMode || "NORMAL");
    if (data.blend.effects) safeSet(node, "effects", normalizeEffectsForNode(node, data.blend.effects));
  }

  const isGroup = node.type === "GROUP";

  if (!isGroup && data.corner && node.type !== "LINE" && node.type !== "TEXT") {
    if (data.corner.cornerRadius === -1) {
      if ("topLeftRadius" in node) {
        safeSet(node, "topLeftRadius", data.corner.topLeftRadius || 0);
        safeSet(node, "topRightRadius", data.corner.topRightRadius || 0);
        safeSet(node, "bottomLeftRadius", data.corner.bottomLeftRadius || 0);
        safeSet(node, "bottomRightRadius", data.corner.bottomRightRadius || 0);
      }
    } else {
      safeSet(node, "cornerRadius", data.corner.cornerRadius || 0);
    }
    safeSet(node, "cornerSmoothing", data.corner.cornerSmoothing || 0);
  }

  if (!isGroup && data.geometry) {
    if (data.geometry.fills) safeSet(node, "fills", data.geometry.fills);
    if (data.geometry.strokes) safeSet(node, "strokes", data.geometry.strokes);
    if (data.geometry.strokeWeight !== undefined) safeSet(node, "strokeWeight", data.geometry.strokeWeight);
    if (data.geometry.strokeAlign) safeSet(node, "strokeAlign", data.geometry.strokeAlign);
    if (data.geometry.strokeJoin) safeSet(node, "strokeJoin", data.geometry.strokeJoin);
    if (data.geometry.dashPattern !== undefined) safeSet(node, "dashPattern", data.geometry.dashPattern);
    if (data.geometry.strokeCap) safeSet(node, "strokeCap", data.geometry.strokeCap);
  }

  if (data.constraints) safeSet(node, "constraints", normalizeConstraints(data.constraints));
  if (data.exportSettings) safeSet(node, "exportSettings", data.exportSettings);

  if (data.layout) {
    const layout = normalizeLayoutForParent(node, data.layout);
    restoredLayoutByNodeId[node.id] = layout;

    if (layout.layoutPositioning && hasAutoLayoutParent(node)) {
      safeSet(node, "layoutPositioning", layout.layoutPositioning);
    }
    if (layout.relativeTransform) safeSet(node, "relativeTransform", layout.relativeTransform);
    if (layout.x !== undefined) safeSet(node, "x", layout.x);
    if (layout.y !== undefined) safeSet(node, "y", layout.y);
    if (layout.rotation !== undefined) safeSet(node, "rotation", layout.rotation);
    if (layout.width !== undefined && layout.height !== undefined) {
      if (isGroup) {
        // Group resize is different, but for now we trust relativeTransform
      } else {
        safeResize(node, layout.width, layout.height);
      }
    }
    if (layout.constrainProportions !== undefined) {
      applyAspectRatioLock(node, layout.constrainProportions);
    }

    if (!isGroup && "layoutMode" in node) {
      if (layout.layoutMode) safeSet(node, "layoutMode", normalizeLayoutMode(layout.layoutMode));
      if (hasAutoLayout(node)) {
        if (layout.primaryAxisSizingMode) safeSet(node, "primaryAxisSizingMode", normalizeAxisSizingMode(layout.primaryAxisSizingMode));
        if (layout.counterAxisSizingMode) safeSet(node, "counterAxisSizingMode", normalizeAxisSizingMode(layout.counterAxisSizingMode));
        if (layout.itemSpacing !== undefined) safeSet(node, "itemSpacing", layout.itemSpacing);
        if (layout.paddingLeft !== undefined) safeSet(node, "paddingLeft", layout.paddingLeft);
        if (layout.paddingRight !== undefined) safeSet(node, "paddingRight", layout.paddingRight);
        if (layout.paddingTop !== undefined) safeSet(node, "paddingTop", layout.paddingTop);
        if (layout.paddingBottom !== undefined) safeSet(node, "paddingBottom", layout.paddingBottom);
        if (layout.primaryAxisAlignItems) safeSet(node, "primaryAxisAlignItems", normalizeAxisAlign(layout.primaryAxisAlignItems));
        if (layout.counterAxisAlignItems) safeSet(node, "counterAxisAlignItems", normalizeAxisAlign(layout.counterAxisAlignItems));
        if (layout.counterAxisAlignContent) safeSet(node, "counterAxisAlignContent", layout.counterAxisAlignContent);
        applySingleChildAutoSpaceAlignmentFix(node, layout);
        if (layout.itemReverseZIndex !== undefined) safeSet(node, "itemReverseZIndex", layout.itemReverseZIndex);
        if (layout.strokesIncludedInLayout !== undefined) safeSet(node, "strokesIncludedInLayout", layout.strokesIncludedInLayout);
      }
    }

    if (hasAutoLayoutParent(node)) {
      if (layout.layoutAlign) safeSet(node, "layoutAlign", normalizeLayoutAlign(layout.layoutAlign));
      if (layout.layoutGrow !== undefined) safeSet(node, "layoutGrow", layout.layoutGrow);
    }

    if (!isGroup && layout.width !== undefined && layout.height !== undefined && shouldRestoreFixedSize(node, layout)) {
      safeResize(node, layout.width, layout.height);
      if (layout.relativeTransform) safeSet(node, "relativeTransform", layout.relativeTransform);
      if (layout.x !== undefined) safeSet(node, "x", layout.x);
      if (layout.y !== undefined) safeSet(node, "y", layout.y);
    }
  }

  if (data.clipsContent !== undefined) safeSet(node, "clipsContent", data.clipsContent);

  if (node.type === "TEXT" && data.characters !== undefined) {
    await applyTextProperties(node, data);
  }
}

function normalizeConstraints(value: any) {
  if (!value || typeof value !== "object") return value;

  const horizontal = normalizeConstraintType(value.horizontal);
  const vertical = normalizeConstraintType(value.vertical);
  if (!horizontal || !vertical) return undefined;

  return { horizontal, vertical };
}

function normalizeConstraintType(value: any) {
  if (value === "START" || value === "MIN") return "MIN";
  if (value === "END" || value === "MAX") return "MAX";
  if (value === "STARTANDEND" || value === "STRETCH") return "STRETCH";
  if (value === "CENTER" || value === "SCALE") return value;
  return undefined;
}

function normalizeLayoutMode(value: any) {
  if (value === "ROW") return "HORIZONTAL";
  if (value === "COLUMN") return "VERTICAL";
  return value;
}

function normalizeLayoutForParent(node: any, layout: any) {
  const offset = getGroupChildCanvasOffset(node, layout);
  if (!offset) return layout;

  const normalized = copyLayout(layout);
  normalized.x = (layout.x || 0) - offset.x;
  normalized.y = (layout.y || 0) - offset.y;

  if (layout.relativeTransform) {
    normalized.relativeTransform = cloneTransform(layout.relativeTransform);
    normalized.relativeTransform[0][2] -= offset.x;
    normalized.relativeTransform[1][2] -= offset.y;
  }

  return normalized;
}

function getGroupChildCanvasOffset(node: any, layout: any) {
  const parent = node.parent as any;
  if (!parent || parent.type !== "GROUP" || !layout) return null;
  if (layout.x === undefined || layout.y === undefined) return null;

  const ancestor = findNearestPositionedAncestor(parent);
  if (!ancestor) return null;

  const ancestorTransform = (ancestor as any).absoluteTransform || (ancestor as any).relativeTransform;
  if (!ancestorTransform) return null;

  const offset = { x: ancestorTransform[0][2] || 0, y: ancestorTransform[1][2] || 0 };
  if (isNearlyZero(offset.x) && isNearlyZero(offset.y)) return null;

  const normalizedX = layout.x - offset.x;
  const normalizedY = layout.y - offset.y;
  if (!isGroupChildOffsetImprovement(parent, layout.x, layout.y, normalizedX, normalizedY)) return null;

  return offset;
}

function findNearestPositionedAncestor(group: any) {
  let ancestor = group.parent as any;
  while (ancestor && ancestor.type !== "PAGE" && ancestor.type !== "DOCUMENT") {
    if (ancestor.type !== "GROUP") return ancestor;
    ancestor = ancestor.parent;
  }

  return null;
}

function isGroupChildOffsetImprovement(parent: any, x: number, y: number, normalizedX: number, normalizedY: number) {
  const restoredLayout = restoredLayoutByNodeId[parent.id] || {};
  const width = Math.max(restoredLayout.width || parent.width || 0, 1);
  const height = Math.max(restoredLayout.height || parent.height || 0, 1);
  const currentScore = groupChildBoundsDistance(x, y, width, height);
  const normalizedScore = groupChildBoundsDistance(normalizedX, normalizedY, width, height);

  return normalizedScore < currentScore && currentScore > 0;
}

function groupChildBoundsDistance(x: number, y: number, width: number, height: number) {
  return axisBoundsDistance(x, width) + axisBoundsDistance(y, height);
}

function axisBoundsDistance(value: number, size: number) {
  if (value < -size) return -size - value;
  if (value > size * 2) return value - size * 2;
  return 0;
}

function copyLayout(layout: any) {
  const copy: any = {};
  for (const key in layout) copy[key] = layout[key];
  return copy;
}

function cloneTransform(transform: any) {
  return [
    [transform[0][0], transform[0][1], transform[0][2]],
    [transform[1][0], transform[1][1], transform[1][2]]
  ];
}

function normalizeAxisAlign(value: any) {
  if (value === "START" || value === "FLEX_START") return "MIN";
  if (value === "END" || value === "FLEX_END") return "MAX";
  if (value === "SPACING_BETWEEN") return "SPACE_BETWEEN";
  return value;
}

function normalizeAxisSizingMode(value: any) {
  if (value === "HUG") return "AUTO";
  if (value === "FILL") return "FIXED";
  return value;
}

function normalizeLayoutAlign(value: any) {
  if (value === "STRETCH" || value === "INHERIT") return value;
  return normalizeAxisAlign(value);
}

function applySingleChildAutoSpaceAlignmentFix(node: any, layout: any) {
  if (!isAutoSpaceAlongPrimaryAxis(layout)) return;
  if (getRestorableChildCount(node) !== 1) return;

  // IMPORTANT: MasterGo and Figma handle "auto" spacing differently when an
  // auto-layout container has exactly one child. MasterGo keeps that child at
  // the start of the primary axis (left in horizontal layout, top in vertical
  // layout), while Figma centers it for SPACE_BETWEEN. Force MIN here so the
  // restored layout preserves MasterGo's visual result.
  safeSet(node, "primaryAxisAlignItems", "MIN");
}

function applyDeferredSingleChildAutoSpaceAlignmentFixes(root: BaseNode) {
  if (!("children" in root)) return;

  const children = [...(root as any).children];
  for (const child of children) {
    applyDeferredSingleChildAutoSpaceAlignmentFixes(child);
  }

  if (!isSceneNode(root)) return;

  const layout = restoredLayoutByNodeId[root.id];
  if (!layout || !hasAutoLayout(root)) return;
  applySingleChildAutoSpaceAlignmentFix(root, layout);
}

function isAutoSpaceAlongPrimaryAxis(layout: any) {
  return normalizeAxisAlign(layout.primaryAxisAlignItems) === "SPACE_BETWEEN" ||
    normalizeAxisAlign(layout.mainAxisAlignItems) === "SPACE_BETWEEN";
}

function getRestorableChildCount(node: any) {
  if (!("children" in node)) return 0;

  return [...node.children].filter((child: BaseNode) => {
    return !child.name.startsWith(INTERNAL_PROPS_PREFIX) && !child.name.startsWith(SIBLING_PROPS_PREFIX);
  }).length;
}

function hasAutoLayout(node: any) {
  return "layoutMode" in node && node.layoutMode !== "NONE";
}

function hasAutoLayoutParent(node: any) {
  const parent = node.parent as any;
  return !!parent && "layoutMode" in parent && parent.layoutMode !== "NONE";
}

function shouldRestoreFixedSize(node: any, layout: any) {
  if (!hasAutoLayout(node)) return true;

  const primarySizing = normalizeAxisSizingMode(layout.primaryAxisSizingMode || node.primaryAxisSizingMode);
  const counterSizing = normalizeAxisSizingMode(layout.counterAxisSizingMode || node.counterAxisSizingMode);
  return primarySizing === "FIXED" || counterSizing === "FIXED";
}

function applyAspectRatioLock(node: any, shouldLock: boolean) {
  if (typeof node.lockAspectRatio === "function" && typeof node.unlockAspectRatio === "function") {
    try {
      if (shouldLock) {
        node.lockAspectRatio();
      } else if (node.targetAspectRatio) {
        node.unlockAspectRatio();
      }
    } catch (e) {}
    return;
  }

  safeSet(node, "constrainProportions", shouldLock);
}

function normalizeEffectsForNode(node: any, effects: any[]) {
  if (!Array.isArray(effects)) return effects;
  if (supportsEffectSpread(node)) return effects;

  return effects.map(effect => {
    if (!effect || (effect.type !== "DROP_SHADOW" && effect.type !== "INNER_SHADOW") || effect.spread === undefined) {
      return effect;
    }

    const copy: any = {};
    for (const key in effect) {
      if (key !== "spread") copy[key] = effect[key];
    }
    return copy;
  });
}

function supportsEffectSpread(node: any) {
  return node.type === "FRAME" ||
    node.type === "COMPONENT" ||
    node.type === "COMPONENT_SET" ||
    node.type === "INSTANCE" ||
    node.type === "RECTANGLE";
}

function safeSet(node: any, property: string, value: any) {
  if (value === undefined || !(property in node)) return;

  try {
    node[property] = value;
  } catch (e) {}
}

function safeResize(node: any, width: number, height: number) {
  try {
    if (typeof node.resize === "function") {
      node.resize(width, height);
    } else if (typeof node.resizeWithoutConstraints === "function") {
      node.resizeWithoutConstraints(width, height);
    }
  } catch (e) {}
}

async function applyTextProperties(node: TextNode, data: any) {
  if (documentFonts.length === 0) {
    documentFonts = await figma.listAvailableFontsAsync();
  }

  const family = data.fontName?.family || "Inter";
  const style = data.fontName?.style || "Regular";
  const isFontExist = documentFonts.some(f => f.fontName.family === family && f.fontName.style === style);

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
  if (data.letterSpacing !== undefined) node.letterSpacing = data.letterSpacing;
  if (data.lineHeight !== undefined) node.lineHeight = data.lineHeight;
}
