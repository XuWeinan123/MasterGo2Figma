"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defProps = Object.defineProperties;
  var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };
  var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
  var __async = (__this, __arguments, generator) => {
    return new Promise((resolve, reject) => {
      var fulfilled = (value) => {
        try {
          step(generator.next(value));
        } catch (e) {
          reject(e);
        }
      };
      var rejected = (value) => {
        try {
          step(generator.throw(value));
        } catch (e) {
          reject(e);
        }
      };
      var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
      step((generator = generator.apply(__this, __arguments)).next());
    });
  };

  // ../shared/utils.ts
  function formatDurationMs(ms) {
    const totalSeconds = Math.round(ms / 1e3);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
  }
  function safeSet(node, key, value) {
    try {
      if (node[key] === value) return false;
      node[key] = value;
      return true;
    } catch (e) {
      return false;
    }
  }
  function safeResize(node, width, height) {
    try {
      if (node.width === width && node.height === height) return false;
      node.resize(width, height);
      return true;
    } catch (e) {
      return false;
    }
  }
  function yieldToEventLoop() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  function isSceneNode(node) {
    return !!(node && typeof node === "object" && typeof node.type === "string" && node.type !== "DOCUMENT" && node.type !== "PAGE");
  }

  // src/state.ts
  var RestorerState = class {
    constructor() {
      this.documentFonts = [];
      this.restoredLayoutByNodeId = {};
      this.importInProgress = false;
      this.cachedLayerRules = null;
      this.layerRulesBySourceType = null;
      this.layerRulesLoadPromise = null;
      this.activeImportAssets = {};
      this.imageHashByAssetName = {};
      this.missingImageAssetNames = {};
      this.missingImageAssetCount = 0;
      this.placeholderImageHash = null;
      this.restoredNodeIdBySourceId = {};
      this.deferredConnectorRestores = [];
      this.deferredLayoutRestores = [];
      this.fontLoadPromises = {};
      this.availableFontKeys = {};
      this.fallbackConnectorCount = 0;
      this.booleanFallbackCount = 0;
      this.connectorFallbackLogged = false;
      this.activeRestoreStats = null;
      this.activeProgressState = null;
    }
    reset() {
      this.activeImportAssets = {};
      this.imageHashByAssetName = {};
      this.missingImageAssetNames = {};
      this.missingImageAssetCount = 0;
      this.restoredNodeIdBySourceId = {};
      this.deferredConnectorRestores = [];
      this.deferredLayoutRestores = [];
      this.fallbackConnectorCount = 0;
      this.booleanFallbackCount = 0;
      this.connectorFallbackLogged = false;
    }
    resetRestoreRuntimeStats(totalNodes, pageCount) {
      this.activeRestoreStats = {
        startedAt: Date.now(),
        totalNodes,
        restoredNodes: 0,
        pageCount,
        textNodeCount: 0,
        fontListLoadCount: 0,
        fontLoadRequestCount: 0,
        fontLoadCacheHitCount: 0,
        fontLoadFailureCount: 0,
        deferredLayoutNodeCount: 0,
        deferredLayoutAppliedCount: 0,
        safeSetWriteCount: 0,
        safeSetSkipCount: 0,
        resizeWriteCount: 0,
        resizeSkipCount: 0
      };
      this.activeProgressState = {
        total: totalNodes,
        lastCurrent: 0,
        lastPostedAt: Date.now()
      };
    }
    logRestorePerformanceSummary(restoredNodes, pageCount) {
      if (!this.activeRestoreStats) return;
      this.activeRestoreStats.restoredNodes = restoredNodes;
      this.activeRestoreStats.pageCount = pageCount;
      const durationMs = Math.max(Date.now() - this.activeRestoreStats.startedAt, 1);
      const nodesPerSecond = Math.round(restoredNodes / durationMs * 1e4) / 10;
      console.log("[MasterGo2Figma] Restore performance", {
        durationMs,
        duration: formatDurationMs(durationMs),
        nodesPerSecond,
        totalNodes: this.activeRestoreStats.totalNodes,
        restoredNodes,
        pageCount,
        textNodeCount: this.activeRestoreStats.textNodeCount,
        fontListLoadCount: this.activeRestoreStats.fontListLoadCount,
        fontLoadRequestCount: this.activeRestoreStats.fontLoadRequestCount,
        fontLoadCacheHitCount: this.activeRestoreStats.fontLoadCacheHitCount,
        fontLoadFailureCount: this.activeRestoreStats.fontLoadFailureCount,
        deferredLayoutNodeCount: this.activeRestoreStats.deferredLayoutNodeCount,
        deferredLayoutAppliedCount: this.activeRestoreStats.deferredLayoutAppliedCount,
        safeSetWriteCount: this.activeRestoreStats.safeSetWriteCount,
        safeSetSkipCount: this.activeRestoreStats.safeSetSkipCount,
        resizeWriteCount: this.activeRestoreStats.resizeWriteCount,
        resizeSkipCount: this.activeRestoreStats.resizeSkipCount,
        booleanFallbackCount: this.booleanFallbackCount,
        fallbackConnectorCount: this.fallbackConnectorCount
      });
    }
  };
  var state = new RestorerState();

  // ../shared/layerRulesConfig.ts
  var LAYER_RULES_SCHEMA = "mastergo2figma.layer-conversion-rules.v1";
  var VALID_RECEIVE_CREATE_TYPES = [
    "VECTOR",
    "ELLIPSE",
    "RECTANGLE",
    "STAR",
    "LINE",
    "POLYGON",
    "TEXT",
    "SECTION",
    "SLICE",
    "FRAME",
    "COMPONENT",
    "COMPONENT_SET",
    "GROUP",
    "CONNECTOR",
    "BOOLEAN_OPERATION"
  ];
  var DEFAULT_LAYER_CONVERSION_CONFIG = {
    schema: LAYER_RULES_SCHEMA,
    version: 1,
    rules: {
      BOOLEAN_OPERATION: { sourceType: "BOOLEAN_OPERATION", restoreType: "BOOLEAN_OPERATION", sendStrategy: "booleanTree", receiveCreate: "BOOLEAN_OPERATION", isContainer: true, visualFrameSource: false },
      PEN: { sourceType: "PEN", restoreType: "VECTOR", sendStrategy: "penNetwork", receiveCreate: "VECTOR", isContainer: false, visualFrameSource: false },
      VECTOR: { sourceType: "VECTOR", restoreType: "VECTOR", sendStrategy: "penNetwork", receiveCreate: "VECTOR", isContainer: false, visualFrameSource: false },
      ELLIPSE: { sourceType: "ELLIPSE", restoreType: "ELLIPSE", sendStrategy: "ellipseArc", receiveCreate: "ELLIPSE", isContainer: false, visualFrameSource: false },
      RECTANGLE: { sourceType: "RECTANGLE", restoreType: "RECTANGLE", sendStrategy: "universalOnly", receiveCreate: "RECTANGLE", isContainer: false, visualFrameSource: false },
      STAR: { sourceType: "STAR", restoreType: "STAR", sendStrategy: "star", receiveCreate: "STAR", isContainer: false, visualFrameSource: false },
      LINE: { sourceType: "LINE", restoreType: "LINE", sendStrategy: "universalOnly", receiveCreate: "LINE", isContainer: false, visualFrameSource: false },
      POLYGON: { sourceType: "POLYGON", restoreType: "POLYGON", sendStrategy: "polygon", receiveCreate: "POLYGON", isContainer: false, visualFrameSource: false },
      TEXT: { sourceType: "TEXT", restoreType: "TEXT", sendStrategy: "text", receiveCreate: "TEXT", isContainer: false, visualFrameSource: false },
      FRAME: { sourceType: "FRAME", restoreType: "FRAME", sendStrategy: "frameLike", receiveCreate: "FRAME", isContainer: true, visualFrameSource: false },
      GROUP: { sourceType: "GROUP", restoreType: "GROUP", sendStrategy: "groupLike", receiveCreate: "GROUP", isContainer: true, visualFrameSource: false },
      SECTION: { sourceType: "SECTION", restoreType: "SECTION", sendStrategy: "frameLike", receiveCreate: "SECTION", isContainer: true, visualFrameSource: false },
      SLICE: { sourceType: "SLICE", restoreType: "SLICE", sendStrategy: "universalOnly", receiveCreate: "SLICE", isContainer: false, visualFrameSource: false },
      CONNECTOR: { sourceType: "CONNECTOR", restoreType: "CONNECTOR", sendStrategy: "connector", receiveCreate: "CONNECTOR", isContainer: false, visualFrameSource: false },
      COMPONENT: { sourceType: "COMPONENT", restoreType: "COMPONENT", sendStrategy: "frameLike", receiveCreate: "COMPONENT", isContainer: true, visualFrameSource: false },
      COMPONENT_SET: { sourceType: "COMPONENT_SET", restoreType: "COMPONENT_SET", sendStrategy: "frameLike", receiveCreate: "COMPONENT_SET", isContainer: true, visualFrameSource: false },
      INSTANCE: { sourceType: "INSTANCE", restoreType: "FRAME", sendStrategy: "frameLike", receiveCreate: "FRAME", isContainer: true, visualFrameSource: true }
    }
  };

  // src/layerRules.ts
  function startLayerRulesLoad() {
    if (!state.layerRulesLoadPromise) {
      state.layerRulesLoadPromise = loadCachedLayerRules();
    }
    return state.layerRulesLoadPromise;
  }
  function ensureLayerRulesLoaded() {
    return __async(this, null, function* () {
      yield startLayerRulesLoad();
    });
  }
  function loadCachedLayerRules() {
    return __async(this, null, function* () {
      state.cachedLayerRules = {
        config: DEFAULT_LAYER_CONVERSION_CONFIG,
        fileName: "\u5185\u7F6E\u8F6C\u6362\u89C4\u5219",
        importedAt: ""
      };
      state.layerRulesBySourceType = createLayerRuleIndex(DEFAULT_LAYER_CONVERSION_CONFIG);
    });
  }
  function createLayerRuleIndex(config) {
    const result = {};
    for (const sourceType in config.rules) {
      result[sourceType] = config.rules[sourceType];
    }
    return result;
  }
  function getLayerRuleStatus() {
    if (!state.cachedLayerRules || !state.layerRulesBySourceType) return { valid: false };
    return {
      valid: true,
      fileName: state.cachedLayerRules.fileName,
      importedAt: state.cachedLayerRules.importedAt,
      ruleCount: Object.keys(state.layerRulesBySourceType).length
    };
  }
  function hasValidLayerRules() {
    return !!state.layerRulesBySourceType;
  }
  function getLayerRule(sourceType) {
    if (!sourceType || !state.layerRulesBySourceType) return null;
    return state.layerRulesBySourceType[sourceType] || null;
  }
  function getRestoreType(data) {
    const sourceType = data.sourceType || data.type;
    if (data.restoreType) return data.restoreType;
    const rule = getLayerRule(sourceType) || getLayerRule(data.type);
    if (rule) return rule.restoreType;
    return data.type;
  }
  function getReceiveCreateType(data) {
    const override = data && data.receiveCreateOverride;
    if (override === "SVG" && typeof data.svgMarkup === "string" && data.svgMarkup.trim()) return "SVG";
    if (override && VALID_RECEIVE_CREATE_TYPES.indexOf(override) !== -1) return override;
    const sourceType = data.sourceType || data.type;
    const rule = getLayerRule(sourceType) || getLayerRule(data.restoreType) || getLayerRule(data.type);
    if (rule) return rule.receiveCreate;
    const restoreType = getRestoreType(data);
    if (restoreType === "PEN") return "VECTOR";
    return restoreType;
  }

  // src/fontLoader.ts
  function getFontKey(family, style) {
    return `${family}
${style}`;
  }
  function ensureAvailableFontsLoaded() {
    return __async(this, null, function* () {
      if (state.documentFonts.length === 0) {
        if (state.activeRestoreStats) {
          state.activeRestoreStats.fontListLoadCount++;
        }
        state.documentFonts = yield figma.listAvailableFontsAsync();
        rebuildAvailableFontIndex();
        return;
      }
      if (Object.keys(state.availableFontKeys).length === 0) {
        rebuildAvailableFontIndex();
      }
    });
  }
  function rebuildAvailableFontIndex() {
    state.availableFontKeys = {};
    for (const font of state.documentFonts) {
      state.availableFontKeys[getFontKey(font.fontName.family, font.fontName.style)] = true;
    }
  }
  function loadFontCached(fontName) {
    return __async(this, null, function* () {
      const key = getFontKey(fontName.family, fontName.style);
      const existing = state.fontLoadPromises[key];
      if (existing) {
        if (state.activeRestoreStats) {
          state.activeRestoreStats.fontLoadCacheHitCount++;
        }
        yield existing;
        return;
      }
      if (state.activeRestoreStats) {
        state.activeRestoreStats.fontLoadRequestCount++;
      }
      const promise = figma.loadFontAsync(fontName).catch((error) => {
        delete state.fontLoadPromises[key];
        if (state.activeRestoreStats) {
          state.activeRestoreStats.fontLoadFailureCount++;
        }
        throw error;
      });
      state.fontLoadPromises[key] = promise;
      yield promise;
    });
  }
  function resolveAvailableFontName(requested) {
    if (state.availableFontKeys[getFontKey(requested.family, requested.style)]) {
      return requested;
    }
    let bestMatch = null;
    for (const font of state.documentFonts) {
      const fontName = font.fontName;
      const familyScore = getFontFamilyMatchScore(requested.family, fontName.family);
      if (familyScore <= 0) continue;
      const styleScore = getFontStyleMatchScore(requested.style, fontName.style);
      if (styleScore <= 0) continue;
      const score = familyScore + styleScore;
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { fontName, score };
      }
    }
    return bestMatch ? bestMatch.fontName : null;
  }
  function getFontFamilyMatchScore(requestedFamily, availableFamily) {
    const requested = normalizeFontFamilyForMatch(requestedFamily);
    const available = normalizeFontFamilyForMatch(availableFamily);
    if (!requested || !available) return 0;
    if (requested === available) return 100;
    if (available.indexOf(requested) === 0 || requested.indexOf(available) === 0) return 80;
    return 0;
  }
  function getFontStyleMatchScore(requestedStyle, availableStyle) {
    const requested = normalizeFontStyleForMatch(requestedStyle);
    const available = normalizeFontStyleForMatch(availableStyle);
    if (!requested || !available) return 0;
    if (requested === available) return 50;
    return 0;
  }
  function normalizeFontFamilyForMatch(value) {
    return String(value || "").toLowerCase().replace(/[\s_-]+/g, "").replace(/[^a-z0-9]/g, "");
  }
  function normalizeFontStyleForMatch(value) {
    const normalized = String(value || "").toLowerCase().replace(/[\s_-]+/g, "").replace(/[^a-z0-9]/g, "");
    const aliases = {
      normal: "regular",
      book: "regular",
      roman: "regular",
      regular: "regular",
      400: "regular",
      medium: "medium",
      500: "medium",
      semibold: "semibold",
      demibold: "semibold",
      600: "semibold",
      bold: "bold",
      700: "bold",
      heavy: "heavy",
      black: "black",
      900: "black",
      light: "light",
      300: "light",
      extralight: "extralight",
      ultralight: "extralight",
      200: "extralight",
      thin: "thin",
      100: "thin"
    };
    return aliases[normalized] || normalized;
  }
  function getNearbyAvailableFontsForLog(requested) {
    const requestedFamily = normalizeFontFamilyForMatch(requested.family);
    const nearby = [];
    for (const font of state.documentFonts) {
      const family = normalizeFontFamilyForMatch(font.fontName.family);
      if (family.indexOf(requestedFamily) !== -1 || requestedFamily.indexOf(family) !== -1 || familiesShareWords(requested.family, font.fontName.family)) {
        nearby.push(font.fontName);
      }
      if (nearby.length >= 20) break;
    }
    return nearby;
  }
  function familiesShareWords(left, right) {
    const leftWords = splitFontFamilyWords(left);
    const rightWords = splitFontFamilyWords(right);
    let sharedCount = 0;
    for (const word of leftWords) {
      if (rightWords.indexOf(word) !== -1) sharedCount++;
    }
    return sharedCount >= Math.min(2, leftWords.length, rightWords.length);
  }
  function splitFontFamilyWords(value) {
    return String(value || "").toLowerCase().split(/[\s_-]+/).filter(Boolean);
  }

  // src/appliers/text.ts
  var MISSING_FONT_NAME_PREFIX_PATTERN = /^\[Font Missing\]\[([^\]]+)\]\[([^\]]+)\]\s*/;
  function applyTextProperties(node, data) {
    return __async(this, null, function* () {
      var _a, _b;
      if (state.activeRestoreStats) {
        state.activeRestoreStats.textNodeCount++;
      }
      yield ensureAvailableFontsLoaded();
      const family = ((_a = data.fontName) == null ? void 0 : _a.family) || "Inter";
      const style = ((_b = data.fontName) == null ? void 0 : _b.style) || "Regular";
      const requestedFontName = { family, style };
      const resolvedFontName = resolveAvailableFontName(requestedFontName);
      yield loadFontCached({ family: "Inter", style: "Regular" });
      if (resolvedFontName) {
        yield loadFontCached(resolvedFontName);
      } else {
        node.name = "[Font Missing][" + family + "][" + style + "] " + node.name;
      }
      node.textAlignHorizontal = data.textAlignHorizontal || "LEFT";
      node.textAlignVertical = data.textAlignVertical || "TOP";
      node.textAutoResize = data.textAutoResize || "NONE";
      node.paragraphIndent = data.paragraphIndent || 0;
      node.paragraphSpacing = data.paragraphSpacing || 0;
      node.autoRename = data.autoRename || false;
      node.fontSize = data.fontSize || 12;
      node.fontName = resolvedFontName || { family: "Inter", style: "Regular" };
      node.characters = data.characters || "";
      if (data.textCase) node.textCase = data.textCase;
      if (data.textDecoration) node.textDecoration = data.textDecoration;
      if (data.letterSpacing !== void 0) node.letterSpacing = data.letterSpacing;
      if (data.lineHeight !== void 0) node.lineHeight = data.lineHeight;
      if (Array.isArray(data.styledTextSegments) && data.styledTextSegments.length > 0) {
        yield applyStyledTextSegments(node, data.styledTextSegments);
      }
    });
  }
  function applyStyledTextSegments(node, segments) {
    return __async(this, null, function* () {
      var _a, _b;
      const charLength = node.characters.length;
      const resolvedByKey = {};
      for (const segment of segments) {
        if (!segment || !segment.fontName) continue;
        const key = getFontKey(segment.fontName.family, segment.fontName.style);
        if (key in resolvedByKey) continue;
        const resolved = resolveAvailableFontName(segment.fontName);
        resolvedByKey[key] = resolved;
        if (resolved) {
          try {
            yield loadFontCached(resolved);
          } catch (error) {
            resolvedByKey[key] = null;
            console.warn("Unable to load run font for styled text:", segment.fontName, error);
          }
        }
      }
      for (const segment of segments) {
        if (!segment) continue;
        const start = Math.max(0, Math.floor((_a = segment.start) != null ? _a : 0));
        const end = Math.min(charLength, Math.floor((_b = segment.end) != null ? _b : 0));
        if (!(end > start)) continue;
        const fontKey = segment.fontName ? getFontKey(segment.fontName.family, segment.fontName.style) : "";
        const resolvedFont = fontKey ? resolvedByKey[fontKey] : null;
        if (resolvedFont) trySetRange(() => node.setRangeFontName(start, end, resolvedFont));
        if (typeof segment.fontSize === "number") trySetRange(() => node.setRangeFontSize(start, end, segment.fontSize));
        if (Array.isArray(segment.fills) && segment.fills.length > 0) {
          trySetRange(() => node.setRangeFills(start, end, segment.fills));
        }
        if (segment.textCase) trySetRange(() => node.setRangeTextCase(start, end, segment.textCase));
        if (segment.textDecoration) trySetRange(() => node.setRangeTextDecoration(start, end, segment.textDecoration));
        if (segment.letterSpacing !== void 0) trySetRange(() => node.setRangeLetterSpacing(start, end, segment.letterSpacing));
        if (segment.lineHeight !== void 0) trySetRange(() => node.setRangeLineHeight(start, end, segment.lineHeight));
      }
    });
  }
  function trySetRange(fn) {
    try {
      fn();
    } catch (error) {
    }
  }
  function parseMissingFontTextLayerName(name) {
    const match = MISSING_FONT_NAME_PREFIX_PATTERN.exec(name);
    if (!match) return null;
    return {
      family: match[1],
      style: match[2],
      restoredName: name.slice(match[0].length)
    };
  }
  function logMissingFontRestoreTargets(targets) {
    const requestedToResolved = {};
    for (const target of targets) {
      if (!requestedToResolved[target.requestedFontKey]) {
        requestedToResolved[target.requestedFontKey] = {
          requested: target.requestedFontName,
          resolved: target.resolvedFontName,
          count: 0
        };
      }
      requestedToResolved[target.requestedFontKey].count++;
    }
    const resolutions = Object.keys(requestedToResolved).map((key) => requestedToResolved[key]);
    console.log("[MasterGo2Figma] Missing font restore targets", resolutions);
    for (const item of resolutions) {
      if (item.resolved) continue;
      console.warn("[MasterGo2Figma] No available font match for missing font", {
        requested: item.requested,
        nearbyAvailableFonts: getNearbyAvailableFontsForLog(item.requested)
      });
    }
  }
  function restoreMissingFontTextLayers(pages) {
    return __async(this, null, function* () {
      const result = {
        scannedTextNodeCount: 0,
        candidateTextNodeCount: 0,
        restoredTextNodeCount: 0,
        failedTextNodeCount: 0,
        loadedFontCount: 0,
        failedFontCount: 0
      };
      const targets = [];
      yield ensureAvailableFontsLoaded();
      for (const page of pages) {
        const textNodes = page.findAll((node) => node.type === "TEXT");
        result.scannedTextNodeCount += textNodes.length;
        for (const node of textNodes) {
          const parsed = parseMissingFontTextLayerName(node.name);
          if (!parsed) continue;
          const requestedFontName = { family: parsed.family, style: parsed.style };
          const resolvedFontName = resolveAvailableFontName(requestedFontName);
          targets.push({
            node,
            requestedFontName,
            resolvedFontName,
            restoredName: parsed.restoredName,
            requestedFontKey: getFontKey(parsed.family, parsed.style),
            resolvedFontKey: resolvedFontName ? getFontKey(resolvedFontName.family, resolvedFontName.style) : ""
          });
        }
      }
      result.candidateTextNodeCount = targets.length;
      if (targets.length === 0) return result;
      logMissingFontRestoreTargets(targets);
      const fontLoadState = /* @__PURE__ */ new Map();
      for (const target of targets) {
        if (!target.resolvedFontName) {
          result.failedTextNodeCount++;
          continue;
        }
        if (!fontLoadState.has(target.resolvedFontKey)) {
          try {
            yield loadFontCached(target.resolvedFontName);
            fontLoadState.set(target.resolvedFontKey, true);
            result.loadedFontCount++;
          } catch (error) {
            fontLoadState.set(target.resolvedFontKey, false);
            result.failedFontCount++;
            console.warn("Unable to restore missing font:", {
              requested: target.requestedFontName,
              resolved: target.resolvedFontName
            }, error);
          }
        }
        if (!fontLoadState.get(target.resolvedFontKey)) {
          result.failedTextNodeCount++;
          continue;
        }
        try {
          target.node.fontName = target.resolvedFontName;
          target.node.name = target.restoredName;
          result.restoredTextNodeCount++;
        } catch (error) {
          result.failedTextNodeCount++;
          console.warn("Unable to apply restored font:", target.node.name, {
            requested: target.requestedFontName,
            resolved: target.resolvedFontName
          }, error);
        }
      }
      console.log("[MasterGo2Figma] Missing font restore", result);
      return result;
    });
  }

  // ../shared/connectorUtils.ts
  function normalizeConnectorPoint(point) {
    return {
      x: Number(point && point.x) || 0,
      y: Number(point && point.y) || 0
    };
  }
  function isSameConnectorAxis(start, end) {
    return Math.abs(start.x - end.x) < 0.01 || Math.abs(start.y - end.y) < 0.01;
  }
  function shouldConnectorRouteStartHorizontal(start, end, startEndpoint, endEndpoint) {
    const startMagnet = startEndpoint && startEndpoint.magnet;
    if (startMagnet === "LEFT" || startMagnet === "RIGHT") return true;
    if (startMagnet === "TOP" || startMagnet === "BOTTOM") return false;
    const endMagnet = endEndpoint && endEndpoint.magnet;
    if (endMagnet === "TOP" || endMagnet === "BOTTOM") return true;
    if (endMagnet === "LEFT" || endMagnet === "RIGHT") return false;
    return Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
  }
  function dedupeConnectorPoints(points) {
    const result = [];
    for (const point of points) {
      const previous = result[result.length - 1];
      if (!previous || Math.abs(previous.x - point.x) >= 0.01 || Math.abs(previous.y - point.y) >= 0.01) {
        result.push(point);
      }
    }
    return result.length > 1 ? result : [points[0], points[points.length - 1]];
  }
  function getConnectorCornerRadius(points, index, requestedRadius) {
    const radius = Number(requestedRadius) || 0;
    if (radius <= 0) return 0;
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    const previousLength = Math.abs(current.x - previous.x) + Math.abs(current.y - previous.y);
    const nextLength = Math.abs(next.x - current.x) + Math.abs(next.y - current.y);
    return Math.min(radius, previousLength / 2, nextLength / 2);
  }
  function normalizeConnectorVectorStrokeCap(value) {
    if (value === "ARROW_EQUILATERAL" || value === "ARROW_LINES" || value === "TRIANGLE_FILLED" || value === "DIAMOND_FILLED" || value === "CIRCLE_FILLED" || value === "ROUND" || value === "SQUARE" || value === "NONE") {
      return value;
    }
    if (value === "LINE_ARROW" || value === "LINE") return "ARROW_LINES";
    if (value === "TRIANGLE_ARROW") return "ARROW_EQUILATERAL";
    if (value === "DIAMOND") return "DIAMOND_FILLED";
    if (value === "ROUND_ARROW" || value === "RING") return "CIRCLE_FILLED";
    return "NONE";
  }
  function normalizeMasterGoStrokeCapForFigma(value) {
    if (value === "NONE" || value === "ROUND" || value === "SQUARE" || value === "ARROW_LINES" || value === "ARROW_EQUILATERAL") {
      return value;
    }
    if (value === "LINE_ARROW" || value === "LINE") return "ARROW_LINES";
    if (value === "TRIANGLE_ARROW" || value === "TRIANGLE_FILLED") return "ARROW_EQUILATERAL";
    if (value === "ROUND_ARROW" || value === "RING") return "ROUND";
    if (value === "DIAMOND" || value === "DIAMOND_FILLED") return "ARROW_EQUILATERAL";
    if (value === "CIRCLE_FILLED") return "ROUND";
    return "NONE";
  }
  function createConnectorRoutePoints(start, end, startEndpoint, endEndpoint, lineType) {
    const startPoint = normalizeConnectorPoint(start);
    const endPoint = normalizeConnectorPoint(end);
    if (lineType !== "ELBOWED" || isSameConnectorAxis(startPoint, endPoint)) {
      return dedupeConnectorPoints([startPoint, endPoint]);
    }
    const horizontalFirst = shouldConnectorRouteStartHorizontal(startPoint, endPoint, startEndpoint, endEndpoint);
    const middlePoint = horizontalFirst ? { x: endPoint.x, y: startPoint.y } : { x: startPoint.x, y: endPoint.y };
    return dedupeConnectorPoints([startPoint, middlePoint, endPoint]);
  }

  // src/appliers/connector.ts
  function normalizeConnectorMagnet(value) {
    if (value === "TOP" || value === "LEFT" || value === "BOTTOM" || value === "RIGHT" || value === "NONE" || value === "AUTO") {
      return value;
    }
    return null;
  }
  function resolveConnectorEndpointNodeId(sourceId, allowExistingFallback) {
    if (typeof sourceId !== "string" || !sourceId) return null;
    if (state.restoredNodeIdBySourceId[sourceId]) {
      return state.restoredNodeIdBySourceId[sourceId];
    }
    if (!allowExistingFallback) return null;
    try {
      const existing = figma.getNodeById(sourceId);
      if (existing && isSceneNode(existing)) return existing.id;
    } catch (error) {
    }
    return null;
  }
  function hasUnresolvedConnectorEndpoint(endpoint) {
    return !!(endpoint && endpoint.endpointNodeId && !resolveConnectorEndpointNodeId(endpoint.endpointNodeId, false));
  }
  function normalizeConnectorStrokeCap(value) {
    if (value === "ARROW_EQUILATERAL" || value === "ARROW_LINES" || value === "TRIANGLE_FILLED" || value === "DIAMOND_FILLED" || value === "CIRCLE_FILLED" || value === "NONE") {
      return value;
    }
    if (value === "LINE_ARROW" || value === "LINE") return "ARROW_LINES";
    if (value === "TRIANGLE_ARROW") return "ARROW_EQUILATERAL";
    if (value === "DIAMOND") return "DIAMOND_FILLED";
    if (value === "ROUND_ARROW" || value === "RING") return "CIRCLE_FILLED";
    return "NONE";
  }
  function normalizeConnectorPosition(position) {
    if (!position || typeof position !== "object") return null;
    return {
      x: Number(position.x) || 0,
      y: Number(position.y) || 0
    };
  }
  function getParentAbsoluteOrigin(parent) {
    if (!parent || parent.type === "PAGE") return { x: 0, y: 0 };
    const transform = parent.absoluteTransform;
    if (transform && transform[0] && transform[1]) {
      return {
        x: Number(transform[0][2]) || 0,
        y: Number(transform[1][2]) || 0
      };
    }
    return {
      x: Number(parent.x) || 0,
      y: Number(parent.y) || 0
    };
  }
  function getConnectorLocalPoint(data, parent, isStart) {
    const localKey = isStart ? "connectorStartLocal" : "connectorEndLocal";
    const localPoint = normalizeConnectorPosition(data[localKey]);
    if (localPoint) return localPoint;
    const endpoint = isStart ? data.connectorStart : data.connectorEnd;
    const absolutePoint = normalizeConnectorPosition(endpoint && endpoint.position);
    if (absolutePoint && parent && data.layout) {
      const parentOrigin = getParentAbsoluteOrigin(parent);
      return {
        x: absolutePoint.x - parentOrigin.x - (Number(data.layout.x) || 0),
        y: absolutePoint.y - parentOrigin.y - (Number(data.layout.y) || 0)
      };
    }
    const layout = data.layout || {};
    return isStart ? { x: 0, y: 0 } : { x: Number(layout.width) || 0, y: Number(layout.height) || 0 };
  }
  function createConnectorVectorNetworkFromData(data, parent) {
    const start = getConnectorLocalPoint(data, parent, true);
    const end = getConnectorLocalPoint(data, parent, false);
    const points = createConnectorRoutePoints(
      start,
      end,
      data.connectorStart,
      data.connectorEnd,
      data.connectorLineType || "ELBOWED"
    );
    const vertices = points.map((point, index) => {
      var _a, _b, _c;
      const vertex = { x: point.x, y: point.y };
      if (index === 0) {
        vertex.strokeCap = normalizeConnectorVectorStrokeCap(data.connectorStartStrokeCap || "NONE");
      }
      if (index === points.length - 1) {
        vertex.strokeCap = normalizeConnectorVectorStrokeCap(data.connectorEndStrokeCap || "NONE");
      }
      if (index > 0 && index < points.length - 1) {
        const radius = getConnectorCornerRadius(points, index, (_c = (_b = data.connectorCornerRadius) != null ? _b : (_a = data.corner) == null ? void 0 : _a.cornerRadius) != null ? _c : 0);
        if (radius > 0) vertex.cornerRadius = radius;
      }
      return vertex;
    });
    const segments = [];
    for (let index = 0; index < points.length - 1; index++) {
      segments.push({ start: index, end: index + 1, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } });
    }
    return { vertices, segments, regions: [] };
  }
  function normalizeConnectorEndpointForFigma(endpoint, allowExistingFallback) {
    if (!endpoint || typeof endpoint !== "object") return null;
    const endpointNodeId = resolveConnectorEndpointNodeId(endpoint.endpointNodeId, allowExistingFallback);
    const position = normalizeConnectorPosition(endpoint.position);
    if (endpointNodeId) {
      const magnet = normalizeConnectorMagnet(endpoint.magnet);
      if (magnet) return { endpointNodeId, magnet };
      if (position) return { endpointNodeId, position };
      return { endpointNodeId, magnet: "AUTO" };
    }
    if (position) return { position };
    return null;
  }
  function applyConnectorProperties(node, data, deferUnresolved) {
    var _a, _b;
    safeSet(node, "connectorLineType", data.connectorLineType || "ELBOWED");
    safeSet(node, "cornerRadius", (_b = data.connectorCornerRadius) != null ? _b : (_a = data.corner) == null ? void 0 : _a.cornerRadius);
    if (data.connectorStartStrokeCap) {
      safeSet(node, "connectorStartStrokeCap", normalizeConnectorStrokeCap(data.connectorStartStrokeCap));
    }
    if (data.connectorEndStrokeCap) {
      safeSet(node, "connectorEndStrokeCap", normalizeConnectorStrokeCap(data.connectorEndStrokeCap));
    }
    const start = normalizeConnectorEndpointForFigma(data.connectorStart, !deferUnresolved);
    const end = normalizeConnectorEndpointForFigma(data.connectorEnd, !deferUnresolved);
    if (start) safeSet(node, "connectorStart", start);
    if (end) safeSet(node, "connectorEnd", end);
    if (deferUnresolved && (hasUnresolvedConnectorEndpoint(data.connectorStart) || hasUnresolvedConnectorEndpoint(data.connectorEnd))) {
      state.deferredConnectorRestores.push({ node, data });
    }
  }
  function applyDeferredConnectorRestores() {
    if (state.deferredConnectorRestores.length === 0) return;
    const deferred = state.deferredConnectorRestores;
    state.deferredConnectorRestores = [];
    for (const item of deferred) {
      if (!item.node || item.node.removed) continue;
      applyConnectorProperties(item.node, item.data, false);
    }
  }

  // src/deferredLayout.ts
  var INTERNAL_PROPS_PREFIX = "[PROPS]";
  var SIBLING_PROPS_PREFIX = "[PROPS_SIBLING]";
  function deferLayoutRestore(node, layout, isGroup) {
    if (!node || !layout || !isSceneNode(node)) return;
    state.deferredLayoutRestores.push({ node, layout, isGroup });
    if (state.activeRestoreStats) {
      state.activeRestoreStats.deferredLayoutNodeCount++;
    }
  }
  function applyDeferredLayoutRestores() {
    if (state.deferredLayoutRestores.length === 0) return;
    const records = state.deferredLayoutRestores;
    state.deferredLayoutRestores = [];
    for (const record of records) applyDeferredNodeAutoLayout(record);
    for (const record of records) applyDeferredParentAutoLayout(record);
    for (const record of records) finalizeDeferredAutoLayout(record);
  }
  function isRemovedNode(node) {
    return !node || !!node.removed;
  }
  function normalizeLayoutMode(value) {
    if (value === "ROW") return "HORIZONTAL";
    if (value === "COLUMN") return "VERTICAL";
    return value;
  }
  function normalizeAxisAlign(value) {
    if (value === "START" || value === "FLEX_START") return "MIN";
    if (value === "END" || value === "FLEX_END") return "MAX";
    if (value === "SPACING_BETWEEN") return "SPACE_BETWEEN";
    return value;
  }
  function normalizeAxisSizingMode(value) {
    if (value === "HUG") return "AUTO";
    if (value === "FILL") return "FIXED";
    return value;
  }
  function normalizeLayoutAlign(value) {
    if (value === "STRETCH" || value === "INHERIT") return value;
    return normalizeAxisAlign(value);
  }
  function applyDeferredNodeAutoLayout(record) {
    const { node, layout, isGroup } = record;
    if (isRemovedNode(node) || isGroup || !("layoutMode" in node)) return;
    let applied = false;
    if (layout.layoutMode) {
      safeSet(node, "layoutMode", normalizeLayoutMode(layout.layoutMode));
      applied = true;
    }
    if (hasAutoLayout(node)) {
      if (layout.primaryAxisSizingMode) {
        safeSet(node, "primaryAxisSizingMode", normalizeAxisSizingMode(layout.primaryAxisSizingMode));
        applied = true;
      }
      if (layout.counterAxisSizingMode) {
        safeSet(node, "counterAxisSizingMode", normalizeAxisSizingMode(layout.counterAxisSizingMode));
        applied = true;
      }
      if (layout.itemSpacing !== void 0) {
        safeSet(node, "itemSpacing", layout.itemSpacing);
        applied = true;
      }
      if (layout.paddingLeft !== void 0) {
        safeSet(node, "paddingLeft", layout.paddingLeft);
        applied = true;
      }
      if (layout.paddingRight !== void 0) {
        safeSet(node, "paddingRight", layout.paddingRight);
        applied = true;
      }
      if (layout.paddingTop !== void 0) {
        safeSet(node, "paddingTop", layout.paddingTop);
        applied = true;
      }
      if (layout.paddingBottom !== void 0) {
        safeSet(node, "paddingBottom", layout.paddingBottom);
        applied = true;
      }
      if (layout.primaryAxisAlignItems) {
        safeSet(node, "primaryAxisAlignItems", normalizeAxisAlign(layout.primaryAxisAlignItems));
        applied = true;
      }
      if (layout.counterAxisAlignItems) {
        safeSet(node, "counterAxisAlignItems", normalizeAxisAlign(layout.counterAxisAlignItems));
        applied = true;
      }
      if (layout.counterAxisAlignContent) {
        safeSet(node, "counterAxisAlignContent", layout.counterAxisAlignContent);
        applied = true;
      }
      if (layout.itemReverseZIndex !== void 0) {
        safeSet(node, "itemReverseZIndex", layout.itemReverseZIndex);
        applied = true;
      }
      if (layout.strokesIncludedInLayout !== void 0) {
        safeSet(node, "strokesIncludedInLayout", layout.strokesIncludedInLayout);
        applied = true;
      }
    }
    if (applied && state.activeRestoreStats) {
      state.activeRestoreStats.deferredLayoutAppliedCount++;
    }
  }
  function applyDeferredParentAutoLayout(record) {
    const { node, layout } = record;
    if (isRemovedNode(node) || !hasAutoLayoutParent(node)) return;
    let applied = false;
    if (layout.layoutPositioning) {
      safeSet(node, "layoutPositioning", layout.layoutPositioning);
      applied = true;
    }
    if (layout.layoutAlign) {
      safeSet(node, "layoutAlign", normalizeLayoutAlign(layout.layoutAlign));
      applied = true;
    }
    if (layout.layoutGrow !== void 0) {
      safeSet(node, "layoutGrow", layout.layoutGrow);
      applied = true;
    }
    const hasRelativeTransform = hasFiniteRelativeTransform(layout);
    if (hasRelativeTransform) {
      safeSet(node, "relativeTransform", layout.relativeTransform);
      applied = true;
    } else if (layout.x !== void 0) {
      safeSet(node, "x", layout.x);
      applied = true;
    }
    if (!hasRelativeTransform && layout.y !== void 0) {
      safeSet(node, "y", layout.y);
      applied = true;
    }
    if (applied && state.activeRestoreStats) {
      state.activeRestoreStats.deferredLayoutAppliedCount++;
    }
  }
  function finalizeDeferredAutoLayout(record) {
    const { node, layout, isGroup } = record;
    if (isRemovedNode(node) || isGroup || !hasAutoLayout(node)) return;
    if (layout.width === void 0 || layout.height === void 0 || !shouldRestoreFixedSize(node, layout)) return;
    safeResize(node, layout.width, layout.height);
    if (hasFiniteRelativeTransform(layout)) {
      safeSet(node, "relativeTransform", layout.relativeTransform);
    } else {
      if (layout.x !== void 0) safeSet(node, "x", layout.x);
      if (layout.y !== void 0) safeSet(node, "y", layout.y);
    }
  }
  function hasFiniteRelativeTransform(layout) {
    return Array.isArray(layout == null ? void 0 : layout.relativeTransform) && Array.isArray(layout.relativeTransform[0]) && Array.isArray(layout.relativeTransform[1]) && Number.isFinite(layout.relativeTransform[0][0]) && Number.isFinite(layout.relativeTransform[0][1]) && Number.isFinite(layout.relativeTransform[0][2]) && Number.isFinite(layout.relativeTransform[1][0]) && Number.isFinite(layout.relativeTransform[1][1]) && Number.isFinite(layout.relativeTransform[1][2]);
  }
  function applySingleChildAutoSpaceAlignmentFix(node, layout) {
    if (!isAutoSpaceAlongPrimaryAxis(layout)) return;
    if (getRestorableChildCount(node) !== 1) return;
    safeSet(node, "primaryAxisAlignItems", "MIN");
  }
  function applyDeferredSingleChildAutoSpaceAlignmentFixes(root) {
    if (!("children" in root)) return;
    const children = [...root.children];
    for (const child of children) {
      applyDeferredSingleChildAutoSpaceAlignmentFixes(child);
    }
    if (!isSceneNode(root)) return;
    const layout = state.restoredLayoutByNodeId[root.id];
    if (!layout || !hasAutoLayout(root)) return;
    applySingleChildAutoSpaceAlignmentFix(root, layout);
  }
  function isAutoSpaceAlongPrimaryAxis(layout) {
    return normalizeAxisAlign(layout.primaryAxisAlignItems) === "SPACE_BETWEEN" || normalizeAxisAlign(layout.mainAxisAlignItems) === "SPACE_BETWEEN";
  }
  function getRestorableChildCount(node) {
    if (!("children" in node)) return 0;
    return [...node.children].filter((child) => {
      return !child.name.startsWith(INTERNAL_PROPS_PREFIX) && !child.name.startsWith(SIBLING_PROPS_PREFIX);
    }).length;
  }
  function hasAutoLayout(node) {
    return "layoutMode" in node && node.layoutMode !== "NONE";
  }
  function hasAutoLayoutParent(node) {
    const parent = node.parent;
    return !!parent && "layoutMode" in parent && parent.layoutMode !== "NONE";
  }
  function shouldRestoreFixedSize(node, layout) {
    if (!hasAutoLayout(node)) return true;
    const primarySizing = normalizeAxisSizingMode(layout.primaryAxisSizingMode || node.primaryAxisSizingMode);
    const counterSizing = normalizeAxisSizingMode(layout.counterAxisSizingMode || node.counterAxisSizingMode);
    return primarySizing === "FIXED" || counterSizing === "FIXED";
  }
  function applyAspectRatioLock(node, shouldLock) {
    if (typeof node.lockAspectRatio === "function" && typeof node.unlockAspectRatio === "function") {
      try {
        if (shouldLock) {
          node.lockAspectRatio();
        } else if (node.targetAspectRatio) {
          node.unlockAspectRatio();
        }
      } catch (e) {
      }
    }
  }

  // ../shared/vectorUtils.ts
  function normalizeVectorWindingRule(value) {
    if (value === "Evenodd" || value === "EVENODD") return "EVENODD";
    if (value === "Nonzero" || value === "NONZERO") return "NONZERO";
    return "NONZERO";
  }
  function stripVectorNetworkVertexExtras(vectorNetwork) {
    if (!vectorNetwork || typeof vectorNetwork !== "object" || !Array.isArray(vectorNetwork.vertices)) return vectorNetwork;
    const result = {};
    for (const key in vectorNetwork) {
      if (Object.prototype.hasOwnProperty.call(vectorNetwork, key)) {
        result[key] = vectorNetwork[key];
      }
    }
    result.vertices = vectorNetwork.vertices.map((vertex) => {
      if (!vertex || typeof vertex !== "object") return vertex;
      const next = {};
      for (const key in vertex) {
        if (Object.prototype.hasOwnProperty.call(vertex, key)) {
          if (key === "strokeCap" || key === "cornerRadius") {
            next[key] = vertex[key];
          } else if (key === "x" || key === "y") {
            next[key] = Number(vertex[key]) || 0;
          }
        }
      }
      return next;
    });
    return result;
  }

  // src/appliers/vector.ts
  function normalizeVectorStrokeCap(value) {
    return normalizeConnectorVectorStrokeCap(value);
  }
  function applyVectorNetwork(node, vectorNetwork, data) {
    const normalized = normalizeVectorNetworkForFigma(createVectorNetworkWithLayoutBoxAnchors(vectorNetwork, data));
    try {
      node.vectorNetwork = normalized;
      return;
    } catch (error) {
      console.warn("Unable to set vectorNetwork, retrying without vertex stroke caps/corner radii:", (data == null ? void 0 : data.name) || (data == null ? void 0 : data.id) || "Untitled", error);
    }
    try {
      node.vectorNetwork = stripVectorNetworkVertexExtras(normalized);
    } catch (fallbackError) {
      console.warn("Unable to set fallback vectorNetwork:", (data == null ? void 0 : data.name) || (data == null ? void 0 : data.id) || "Untitled", fallbackError);
    }
  }
  function createVectorNetworkWithLayoutBoxAnchors(vectorNetwork, data) {
    var _a, _b;
    if (!(data == null ? void 0 : data.vectorAutoLayoutBox) || !vectorNetwork || typeof vectorNetwork !== "object") return vectorNetwork;
    const width = Number((_a = data == null ? void 0 : data.layout) == null ? void 0 : _a.width);
    const height = Number((_b = data == null ? void 0 : data.layout) == null ? void 0 : _b.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return vectorNetwork;
    const vertices = Array.isArray(vectorNetwork.vertices) ? vectorNetwork.vertices.slice() : [];
    const segments = Array.isArray(vectorNetwork.segments) ? vectorNetwork.segments.slice() : [];
    const startIndex = vertices.length;
    vertices.push(
      { x: 0, y: 0, strokeCap: "NONE" },
      { x: width, y: height, strokeCap: "NONE" }
    );
    segments.push(
      { start: startIndex, end: startIndex, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } },
      { start: startIndex + 1, end: startIndex + 1, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } }
    );
    return __spreadProps(__spreadValues({}, vectorNetwork), {
      vertices,
      segments
    });
  }
  function normalizeVectorNetworkForFigma(vectorNetwork) {
    if (!vectorNetwork || typeof vectorNetwork !== "object") return vectorNetwork;
    const result = {};
    for (const key in vectorNetwork) {
      if (Object.prototype.hasOwnProperty.call(vectorNetwork, key)) {
        result[key] = vectorNetwork[key];
      }
    }
    if (Array.isArray(vectorNetwork.vertices)) {
      result.vertices = vectorNetwork.vertices.map((vertex) => {
        if (!vertex || typeof vertex !== "object") return vertex;
        const next = {};
        for (const key in vertex) {
          if (Object.prototype.hasOwnProperty.call(vertex, key)) {
            next[key] = vertex[key];
          }
        }
        if (next.strokeCap !== void 0) {
          next.strokeCap = normalizeVectorStrokeCap(next.strokeCap);
        }
        return next;
      });
    }
    if (Array.isArray(vectorNetwork.segments)) {
      result.segments = vectorNetwork.segments.map((segment) => {
        if (!segment || typeof segment !== "object") return segment;
        const next = {};
        for (const key in segment) {
          if (Object.prototype.hasOwnProperty.call(segment, key)) {
            next[key] = segment[key];
          }
        }
        return next;
      });
    }
    if (Array.isArray(vectorNetwork.regions)) {
      result.regions = vectorNetwork.regions.map((region) => {
        if (!region || typeof region !== "object") return region;
        const next = {};
        for (const key in region) {
          if (Object.prototype.hasOwnProperty.call(region, key)) {
            next[key] = region[key];
          }
        }
        next.windingRule = normalizeVectorWindingRule(next.windingRule);
        if (Array.isArray(region.loops)) {
          next.loops = region.loops.map((loop) => {
            if (!Array.isArray(loop)) return loop;
            return loop.map((value) => Number(value)).filter((value) => Number.isFinite(value));
          });
        }
        return next;
      });
    }
    return result;
  }

  // src/nodeCreator.ts
  function appendRestoredNode(parent, node) {
    if ("appendChild" in parent) {
      parent.appendChild(node);
      return true;
    }
    console.warn("Unable to append restored node because parent cannot contain children:", node.name, parent.name);
    safeRemove(node);
    return false;
  }
  function safeRemove(node) {
    if (node.removed) return;
    try {
      node.remove();
    } catch (e) {
      console.warn("Unable to remove node:", node.name, e);
    }
  }
  function isShellContainer(node) {
    return node.type === "FRAME" || node.type === "GROUP" || node.type === "SECTION" || node.type === "COMPONENT" || node.type === "INSTANCE" || node.type === "COMPONENT_SET";
  }
  function clearMaskFlag(node) {
    const nodeAny = node;
    if (!("isMask" in nodeAny)) return;
    try {
      nodeAny.isMask = false;
    } catch (e) {
      console.warn("Unable to clear mask before removing imported rectangle:", node.name, e);
    }
  }
  function isInsideInstance(node) {
    let parent = node.parent;
    while (parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT") {
      if (parent.type === "INSTANCE") return true;
      parent = parent.parent;
    }
    return false;
  }
  function cleanupImportedContainerShells(root) {
    if (!("children" in root)) return;
    if (isSceneNode(root) && (root.type === "INSTANCE" || isInsideInstance(root))) return;
    const children = [...root.children];
    for (const child of children) {
      cleanupImportedContainerShells(child);
    }
    if (!isSceneNode(root) || !isShellContainer(root)) return;
    const shellChildren = [...root.children];
    for (const child of shellChildren) {
      if (child.type === "RECTANGLE" && child.name === root.name) {
        clearMaskFlag(child);
        safeRemove(child);
        return;
      }
    }
  }
  function hasUsableVectorNetwork(vectorNetwork) {
    return !!(vectorNetwork && Array.isArray(vectorNetwork.vertices) && vectorNetwork.vertices.length > 0 && Array.isArray(vectorNetwork.segments));
  }
  function createNodeFromData(data) {
    return __async(this, null, function* () {
      let node = null;
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
        console.warn("Unable to create node, removing partial node:", (data == null ? void 0 : data.name) || (data == null ? void 0 : data.id) || type, error);
        if (node) safeRemove(node);
        return null;
      }
      return node;
    });
  }

  // ../shared/matrixUtils.ts
  function cloneTransform(transform) {
    if (!transform || !Array.isArray(transform) || transform.length < 2) {
      return [[1, 0, 0], [0, 1, 0]];
    }
    const r0 = transform[0] || [1, 0, 0];
    const r1 = transform[1] || [0, 1, 0];
    return [
      [typeof r0[0] === "number" ? r0[0] : 1, typeof r0[1] === "number" ? r0[1] : 0, typeof r0[2] === "number" ? r0[2] : 0],
      [typeof r1[0] === "number" ? r1[0] : 0, typeof r1[1] === "number" ? r1[1] : 1, typeof r1[2] === "number" ? r1[2] : 0]
    ];
  }

  // src/appliers/universal.ts
  function recordRestoredNode(data, node) {
    const sourceId = data && typeof data.id === "string" ? data.id : "";
    if (sourceId && node && typeof node.id === "string") {
      state.restoredNodeIdBySourceId[sourceId] = node.id;
    }
  }
  var MISSING_IMAGE_PLACEHOLDER_COLOR = { r: 0.82, g: 0.83, b: 0.85 };
  function normalizeImagePaint(paint) {
    if (!paint || paint.type !== "IMAGE") return normalizePaintForFigma(paint);
    const assetName = typeof paint.imageRef === "string" ? paint.imageRef : "";
    const imageHash = tryResolveImageHash(paint);
    if (!imageHash) {
      recordMissingImageAsset(assetName || "missing-image.png");
      const placeholder = {
        type: "SOLID",
        color: __spreadValues({}, MISSING_IMAGE_PLACEHOLDER_COLOR)
      };
      if (paint.visible !== void 0) placeholder.visible = paint.visible;
      if (paint.opacity !== void 0) placeholder.opacity = paint.opacity;
      if (paint.blendMode) placeholder.blendMode = paint.blendMode;
      return normalizePaintForFigma(placeholder);
    }
    const result = {
      type: "IMAGE",
      scaleMode: paint.scaleMode || "FILL",
      imageHash
    };
    if (paint.visible !== void 0) result.visible = paint.visible;
    if (paint.opacity !== void 0) result.opacity = paint.opacity;
    if (paint.blendMode) result.blendMode = paint.blendMode;
    const filters = normalizeImageFilters(paint.filters);
    if (filters) result.filters = filters;
    if (paint.rotation !== void 0) result.rotation = paint.rotation;
    if (paint.imageTransform) result.imageTransform = paint.imageTransform;
    if (paint.scalingFactor !== void 0) result.scalingFactor = paint.scalingFactor;
    return normalizePaintForFigma(result);
  }
  function normalizeImageFills(fills) {
    if (!Array.isArray(fills)) return fills;
    return fills.map(normalizeImagePaint).filter(Boolean);
  }
  function normalizeImageStrokes(strokes) {
    if (!Array.isArray(strokes)) return strokes;
    return strokes.map(normalizeImagePaint).filter(Boolean);
  }
  function normalizeImageFilters(filters) {
    if (!filters || typeof filters !== "object") return null;
    const result = {};
    const allowed = ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"];
    for (const key of allowed) {
      if (typeof filters[key] === "number") result[key] = filters[key];
    }
    return Object.keys(result).length > 0 ? result : null;
  }
  function tryResolveImageHash(fill) {
    const assetName = typeof fill.imageRef === "string" ? fill.imageRef : "";
    if (!assetName || fill.missingAsset) return null;
    const existingHash = state.imageHashByAssetName[assetName];
    if (existingHash) return existingHash;
    const bytes = state.activeImportAssets[assetName];
    if (!bytes) return null;
    try {
      const image = figma.createImage(bytes);
      state.imageHashByAssetName[assetName] = image.hash;
      return image.hash;
    } catch (error) {
      console.warn("Unable to create Figma image from asset:", assetName, error);
      return null;
    }
  }
  function recordMissingImageAsset(assetName) {
    if (state.missingImageAssetNames[assetName]) return;
    state.missingImageAssetNames[assetName] = true;
    state.missingImageAssetCount++;
  }
  function normalizeEffectsForNode(node, effects) {
    if (!Array.isArray(effects)) return effects;
    return effects.map((effect) => {
      if (!effect || typeof effect !== "object") return effect;
      const copy = {};
      for (const key in effect) {
        if (key !== "spread" || supportsEffectSpread(node)) copy[key] = effect[key];
      }
      if (copy.visible === void 0 && effect.isVisible !== void 0) copy.visible = effect.isVisible;
      if (copy.visible === void 0) copy.visible = true;
      if (copy.blendMode === "PASS_THROUGH") copy.blendMode = "NORMAL";
      if (copy.type === "DROP_SHADOW" || copy.type === "INNER_SHADOW") {
        if (copy.showShadowBehindNode === void 0) copy.showShadowBehindNode = true;
      }
      return copy;
    });
  }
  function safeSetEffects(node, effects) {
    if (!("effects" in node)) return;
    const normalized = normalizeEffectsForNode(node, effects);
    try {
      node.effects = normalized;
      return;
    } catch (_) {
    }
    const withoutSpread = Array.isArray(normalized) ? normalized.map((effect) => {
      if (!effect || typeof effect !== "object") return effect;
      const copy = {};
      for (const key in effect) {
        if (key !== "spread") copy[key] = effect[key];
      }
      return copy;
    }) : normalized;
    try {
      node.effects = withoutSpread;
    } catch (_) {
    }
  }
  function supportsEffectSpread(node) {
    return node.type === "FRAME" || node.type === "COMPONENT" || node.type === "COMPONENT_SET" || node.type === "INSTANCE" || node.type === "RECTANGLE" || node.type === "ELLIPSE" || node.type === "POLYGON" || node.type === "STAR" || node.type === "VECTOR" || node.type === "SECTION" || node.type === "TEXT";
  }
  function normalizeConstraints(value) {
    if (!value || typeof value !== "object") return value;
    const horizontal = normalizeConstraintType(value.horizontal);
    const vertical = normalizeConstraintType(value.vertical);
    if (!horizontal || !vertical) return void 0;
    return { horizontal, vertical };
  }
  function normalizeConstraintType(value) {
    if (value === "START" || value === "MIN") return "MIN";
    if (value === "END" || value === "MAX") return "MAX";
    if (value === "STARTANDEND" || value === "STRETCH") return "STRETCH";
    if (value === "CENTER" || value === "SCALE") return value;
    return void 0;
  }
  function safeSetFills(node, fills) {
    if (!("fills" in node)) return;
    const normalized = normalizePaintsForFigma(fills);
    try {
      node.fills = normalized;
    } catch (error) {
      const fallbackFills = stripUnsupportedPaintExtras(normalized);
      try {
        node.fills = fallbackFills;
      } catch (fallbackError) {
        console.warn("Unable to set fills:", node.name, describePaintSetError(fallbackError, fallbackFills));
      }
    }
  }
  function safeSetStrokes(node, strokes) {
    if (!("strokes" in node)) return;
    const normalized = normalizePaintsForFigma(strokes);
    try {
      node.strokes = normalized;
    } catch (error) {
      const fallbackStrokes = stripUnsupportedPaintExtras(normalized);
      try {
        node.strokes = fallbackStrokes;
      } catch (fallbackError) {
        console.warn("Unable to set strokes:", node.name, describePaintSetError(fallbackError, fallbackStrokes));
      }
    }
  }
  function normalizePaintsForFigma(paints) {
    if (!Array.isArray(paints)) return paints;
    return paints.map(normalizePaintForFigma).filter(Boolean);
  }
  function normalizePaintForFigma(paint) {
    if (!paint || typeof paint !== "object") return paint;
    const copy = {};
    for (const key in paint) {
      if (key === "imageRef" || key === "missingAsset" || key === "isVisible") continue;
      if (paint[key] !== void 0) copy[key] = paint[key];
    }
    if (copy.visible === void 0 && paint.isVisible !== void 0) copy.visible = paint.isVisible;
    if (copy.visible === void 0) copy.visible = true;
    if (copy.blendMode === "PASS_THROUGH") copy.blendMode = "NORMAL";
    if (typeof copy.opacity === "number") copy.opacity = clamp01(copy.opacity);
    if (copy.type === "SOLID") {
      if (copy.color) copy.color = normalizePaintColor(copy.color);
      return pickDefined(copy, ["type", "visible", "opacity", "blendMode", "color", "boundVariables"]);
    }
    if (copy.type === "GRADIENT_LINEAR" || copy.type === "GRADIENT_RADIAL" || copy.type === "GRADIENT_ANGULAR" || copy.type === "GRADIENT_DIAMOND") {
      if (Array.isArray(copy.gradientStops)) copy.gradientStops = copy.gradientStops.map(normalizeGradientStop).filter(Boolean);
      return pickDefined(copy, ["type", "visible", "opacity", "blendMode", "gradientHandlePositions", "gradientStops", "gradientTransform", "boundVariables"]);
    }
    if (copy.type === "IMAGE") {
      if (!copy.imageHash) return null;
      return pickDefined(copy, ["type", "visible", "opacity", "blendMode", "scaleMode", "imageHash", "imageTransform", "scalingFactor", "rotation", "filters", "gifRef", "boundVariables"]);
    }
    if (copy.type === "VIDEO") {
      return pickDefined(copy, ["type", "visible", "opacity", "blendMode", "scaleMode", "videoHash", "videoTransform", "scalingFactor", "rotation", "filters", "boundVariables"]);
    }
    return copy;
  }
  function stripUnsupportedPaintExtras(paints) {
    if (!Array.isArray(paints)) return paints;
    return paints.map((paint) => {
      if (!paint || typeof paint !== "object") return paint;
      if (paint.type === "IMAGE") {
        return pickDefined(paint, ["type", "visible", "opacity", "blendMode", "scaleMode", "imageHash"]);
      }
      if (paint.type === "GRADIENT_LINEAR" || paint.type === "GRADIENT_RADIAL" || paint.type === "GRADIENT_ANGULAR" || paint.type === "GRADIENT_DIAMOND") {
        return pickDefined(paint, ["type", "visible", "opacity", "blendMode", "gradientHandlePositions", "gradientStops"]);
      }
      return normalizePaintForFigma(paint);
    }).filter(Boolean);
  }
  function pickDefined(value, keys) {
    const result = {};
    for (const key of keys) {
      if (value[key] !== void 0) result[key] = value[key];
    }
    return result;
  }
  function normalizeGradientStop(stop) {
    if (!stop || typeof stop !== "object") return null;
    const result = {};
    result.position = clamp01(typeof stop.position === "number" ? stop.position : 0);
    result.color = normalizePaintColor(stop.color || {});
    if (stop.boundVariables !== void 0) result.boundVariables = stop.boundVariables;
    return result;
  }
  function normalizePaintColor(color) {
    return {
      r: clamp01(typeof color.r === "number" ? color.r : 0),
      g: clamp01(typeof color.g === "number" ? color.g : 0),
      b: clamp01(typeof color.b === "number" ? color.b : 0),
      a: clamp01(typeof color.a === "number" ? color.a : 1)
    };
  }
  function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }
  function describePaintSetError(error, paints) {
    return {
      message: error instanceof Error ? error.message : String(error || "Unknown error"),
      paintTypes: Array.isArray(paints) ? paints.map((paint) => paint && paint.type) : [],
      blendModes: Array.isArray(paints) ? paints.map((paint) => paint && paint.blendMode).filter(Boolean) : []
    };
  }
  function isNearlyZero(value) {
    return Math.abs(value) < 0.01;
  }
  function copyLayout(layout) {
    const copy = {};
    for (const key in layout) copy[key] = layout[key];
    return copy;
  }
  function axisBoundsDistance(value, size) {
    if (value < -size) return -size - value;
    if (value > size * 2) return value - size * 2;
    return 0;
  }
  function groupChildBoundsDistance(x, y, width, height) {
    return axisBoundsDistance(x, width) + axisBoundsDistance(y, height);
  }
  function isGroupChildOffsetImprovement(parent, x, y, normalizedX, normalizedY) {
    const restoredLayout = state.restoredLayoutByNodeId[parent.id] || {};
    const width = Math.max(restoredLayout.width || parent.width || 0, 1);
    const height = Math.max(restoredLayout.height || parent.height || 0, 1);
    const currentScore = groupChildBoundsDistance(x, y, width, height);
    const normalizedScore = groupChildBoundsDistance(normalizedX, normalizedY, width, height);
    return normalizedScore < currentScore && currentScore > 0;
  }
  function findNearestPositionedAncestor(group) {
    let ancestor = group.parent;
    while (ancestor && ancestor.type !== "PAGE" && ancestor.type !== "DOCUMENT") {
      if (ancestor.type !== "GROUP") return ancestor;
      ancestor = ancestor.parent;
    }
    return null;
  }
  function getGroupChildCanvasOffset(node, layout) {
    const parent = node.parent;
    if (!parent || parent.type !== "GROUP" || !layout) return null;
    if (layout.x === void 0 || layout.y === void 0) return null;
    const ancestor = findNearestPositionedAncestor(parent);
    if (!ancestor) return null;
    const ancestorTransform = ancestor.absoluteTransform || ancestor.relativeTransform;
    if (!ancestorTransform) return null;
    const offset = { x: ancestorTransform[0][2] || 0, y: ancestorTransform[1][2] || 0 };
    if (isNearlyZero(offset.x) && isNearlyZero(offset.y)) return null;
    const normalizedX = layout.x - offset.x;
    const normalizedY = layout.y - offset.y;
    if (!isGroupChildOffsetImprovement(parent, layout.x, layout.y, normalizedX, normalizedY)) return null;
    return offset;
  }
  function normalizeLayoutForParent(node, layout) {
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
  function hasFiniteRelativeTransform2(layout) {
    return Array.isArray(layout == null ? void 0 : layout.relativeTransform) && Array.isArray(layout.relativeTransform[0]) && Array.isArray(layout.relativeTransform[1]) && Number.isFinite(layout.relativeTransform[0][0]) && Number.isFinite(layout.relativeTransform[0][1]) && Number.isFinite(layout.relativeTransform[0][2]) && Number.isFinite(layout.relativeTransform[1][0]) && Number.isFinite(layout.relativeTransform[1][1]) && Number.isFinite(layout.relativeTransform[1][2]);
  }
  function getUniformOpenVectorStrokeCap(vectorNetwork) {
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
  function applyUniversalProperties(node, data) {
    return __async(this, null, function* () {
      var _a, _b, _c, _d;
      if (!node || !data) return;
      safeSet(node, "name", data.name);
      recordRestoredNode(data, node);
      if (data.scence) {
        safeSet(node, "visible", (_a = data.scence.visible) != null ? _a : true);
        safeSet(node, "locked", (_b = data.scence.locked) != null ? _b : false);
      }
      if (data.blend) {
        safeSet(node, "opacity", (_c = data.blend.opacity) != null ? _c : 1);
        safeSet(node, "isMask", (_d = data.blend.isMask) != null ? _d : false);
        safeSet(node, "blendMode", data.blend.blendMode || "NORMAL");
        if (data.blend.effects) {
          safeSetEffects(node, data.blend.effects);
        }
      }
      const isGroup = node.type === "GROUP";
      const isBooleanOperation = node.type === "BOOLEAN_OPERATION";
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
      if (!isGroup && data.geometry && !data.svgFallback) {
        if (data.geometry.fills) safeSetFills(node, normalizeImageFills(data.geometry.fills));
        if (data.geometry.strokes) {
          safeSetStrokes(node, normalizeImageStrokes(data.geometry.strokes));
        }
        if (data.geometry.strokeWeight !== void 0) {
          safeSet(node, "strokeWeight", data.geometry.strokeWeight);
        }
        if (node.strokeTopWeight !== void 0) {
          if (data.geometry.strokeTopWeight !== void 0) {
            try {
              node.strokeTopWeight = data.geometry.strokeTopWeight;
              node.strokeBottomWeight = data.geometry.strokeBottomWeight;
              node.strokeLeftWeight = data.geometry.strokeLeftWeight;
              node.strokeRightWeight = data.geometry.strokeRightWeight;
            } catch (e) {
            }
          }
        }
        if (data.geometry.strokeAlign) safeSet(node, "strokeAlign", data.geometry.strokeAlign);
        if (data.geometry.strokeJoin) safeSet(node, "strokeJoin", data.geometry.strokeJoin);
        if (data.geometry.dashPattern !== void 0) safeSet(node, "dashPattern", data.geometry.dashPattern);
        if (data.geometry.strokeCap && !data.connectorFallbackPolyline) {
          const vectorCap = data.geometry.strokeCap === "NONE" ? getUniformOpenVectorStrokeCap(data.vectorNetwork) : null;
          safeSet(node, "strokeCap", vectorCap || normalizeMasterGoStrokeCapForFigma(data.geometry.strokeCap));
        }
      }
      if (data.constraints) safeSet(node, "constraints", normalizeConstraints(data.constraints));
      if (data.exportSettings) safeSet(node, "exportSettings", data.exportSettings);
      if (data.layout) {
        const layout = normalizeLayoutForParent(node, data.layout);
        state.restoredLayoutByNodeId[node.id] = layout;
        if (layout.width !== void 0 && layout.height !== void 0) {
          if (isGroup || isBooleanOperation) {
          } else {
            safeResize(node, layout.width, layout.height);
          }
        }
        const hasRelativeTransform = hasFiniteRelativeTransform2(layout);
        if (hasRelativeTransform) {
          safeSet(node, "relativeTransform", layout.relativeTransform);
        } else {
          if (layout.x !== void 0) safeSet(node, "x", layout.x);
          if (layout.y !== void 0) safeSet(node, "y", layout.y);
          if (layout.rotation !== void 0) safeSet(node, "rotation", layout.rotation);
        }
        if (layout.constrainProportions !== void 0) {
          applyAspectRatioLock(node, layout.constrainProportions);
        }
        deferLayoutRestore(node, layout, isGroup);
      }
      if (data.clipsContent !== void 0) safeSet(node, "clipsContent", data.clipsContent);
    });
  }

  // src/propertyApplier.ts
  function applyProperties(node, data) {
    return __async(this, null, function* () {
      if (!node || !data) return;
      yield applyUniversalProperties(node, data);
      if (node.type === "VECTOR" && data.vectorNetwork) {
        applyVectorNetwork(node, data.vectorNetwork, data);
        reapplyVectorStrokeGeometry(node, data);
      }
      if (node.type === "TEXT" && data.characters !== void 0) {
        yield applyTextProperties(node, data);
      }
      if (node.type === "CONNECTOR") {
        applyConnectorProperties(node, data, true);
      }
    });
  }
  function reapplyVectorStrokeGeometry(node, data) {
    const geometry = data && data.geometry;
    if (!geometry) return;
    if (geometry.strokeWeight !== void 0) safeSet(node, "strokeWeight", geometry.strokeWeight);
    if (geometry.strokeAlign) safeSet(node, "strokeAlign", geometry.strokeAlign);
    if (geometry.strokeJoin) safeSet(node, "strokeJoin", geometry.strokeJoin);
    if (geometry.dashPattern !== void 0) safeSet(node, "dashPattern", geometry.dashPattern);
    if (geometry.strokeCap && !data.connectorFallbackPolyline) {
      safeSet(node, "strokeCap", normalizeMasterGoStrokeCapForFigma(geometry.strokeCap));
    }
  }

  // src/appliers/container.ts
  var BOOLEAN_RESTORE_DEBUG_BUILD = "boolean-debug-2026-06-11-01";
  function shouldRestoreBooleanVectorAsFrame(data, layerRecord) {
    if (!data || data.sourceType !== "BOOLEAN_OPERATION") return false;
    if (data.receiveCreateOverride || data.svgFallback) return false;
    if (data.type !== "VECTOR" && data.restoreType !== "VECTOR") return false;
    if (!layerRecord.childIds || layerRecord.childIds.length === 0) return false;
    return !hasUsableVectorNetwork(data.vectorNetwork);
  }
  function shouldRestoreBooleanOperationTree(data, layerRecord) {
    if (!data) return false;
    const hasBooleanChildren = data.sourceType === "BOOLEAN_OPERATION" && !!layerRecord && Array.isArray(layerRecord.childIds) && layerRecord.childIds.length > 0;
    return data.sourceType === "BOOLEAN_OPERATION" && (hasBooleanChildren || data.type === "BOOLEAN_OPERATION" || data.restoreType === "BOOLEAN_OPERATION" || data.receiveCreateOverride === "BOOLEAN_OPERATION");
  }
  function normalizeBooleanOperation(value) {
    if (value === "UNION" || value === "SUBTRACT" || value === "INTERSECT" || value === "EXCLUDE") {
      return value;
    }
    return null;
  }
  function clearGeometryPaint(geometry) {
    if (!geometry || typeof geometry !== "object") return geometry;
    return __spreadProps(__spreadValues({}, geometry), {
      fills: [],
      strokes: [],
      strokeWeight: 0,
      strokeTopWeight: void 0,
      strokeBottomWeight: void 0,
      strokeLeftWeight: void 0,
      strokeRightWeight: void 0
    });
  }
  function createBooleanFrameFallbackProps(data) {
    return __spreadProps(__spreadValues({}, data), {
      type: "FRAME",
      restoreType: "FRAME",
      receiveCreateOverride: "FRAME",
      booleanFallback: "frameContainer",
      clipsContent: false,
      geometry: clearGeometryPaint(data.geometry)
    });
  }
  function createUntransformedContainerShellProps(data) {
    const props = createBooleanFrameFallbackProps(data);
    delete props.layout;
    delete props.constraints;
    return props;
  }
  function createContainerShellFrameProps(data) {
    return hasNonTranslationTransform(data == null ? void 0 : data.layout) ? createUntransformedContainerShellProps(data) : createBooleanFrameFallbackProps(data);
  }
  function createFinalizedContainerProps(data, preserveLayout = false) {
    const props = __spreadValues({}, data);
    if (!preserveLayout) {
      delete props.layout;
      delete props.constraints;
    }
    return props;
  }
  function hasNonTranslationTransform(layout) {
    const transform = layout && layout.relativeTransform;
    if (!hasFiniteTransform(transform)) return false;
    return Math.abs(transform[0][0] - 1) > 1e-4 || Math.abs(transform[0][1]) > 1e-4 || Math.abs(transform[1][0]) > 1e-4 || Math.abs(transform[1][1] - 1) > 1e-4;
  }
  function hasFiniteTransform(transform) {
    return Array.isArray(transform) && Array.isArray(transform[0]) && Array.isArray(transform[1]) && Number.isFinite(transform[0][0]) && Number.isFinite(transform[0][1]) && Number.isFinite(transform[0][2]) && Number.isFinite(transform[1][0]) && Number.isFinite(transform[1][1]) && Number.isFinite(transform[1][2]);
  }
  function shouldRestoreComponentSetNode(data) {
    if (!data) return false;
    if (data.receiveCreateOverride === "SVG" || data.svgFallback) return false;
    return data.sourceType === "COMPONENT_SET" && (data.type === "COMPONENT_SET" || data.restoreType === "COMPONENT_SET" || data.receiveCreateOverride === "COMPONENT_SET");
  }
  function restoreComponentSetNode(nodeProps, parent, layerRecord, layers, restoredBefore, totalNodes, restoreNodeCallback, applyPropertiesCallback, maybeReportProgressCallback) {
    return __async(this, null, function* () {
      const shell = figma.createFrame();
      const childIds = nodeProps.omitChildrenOnRestore ? [] : layerRecord.childIds || [];
      const shellProps = createBooleanFrameFallbackProps(nodeProps);
      let appended = false;
      try {
        if (!appendRestoredNode(parent, shell)) return 0;
        appended = true;
        yield applyPropertiesCallback(shell, shellProps);
      } catch (error) {
        console.warn("Unable to create component set restore shell:", (nodeProps == null ? void 0 : nodeProps.name) || layerRecord.name, error);
        if (appended) safeRemove(shell);
        return 0;
      }
      let restoredCount = 1;
      yield maybeReportProgressCallback(restoredBefore + restoredCount, totalNodes, "\u6B63\u5728\u8FD8\u539F\uFF1A" + (nodeProps.name || layerRecord.name));
      for (const childId of childIds) {
        restoredCount += yield restoreNodeCallback(childId, shell, layers, restoredBefore + restoredCount, totalNodes);
      }
      yield finalizeComponentSetShell(shell, nodeProps, applyPropertiesCallback);
      return restoredCount;
    });
  }
  function finalizeComponentSetShell(shell, data, applyPropertiesCallback) {
    return __async(this, null, function* () {
      const parent = shell.parent;
      if (!parent || !("insertChild" in parent)) {
        safeSet(shell, "name", data.name);
        return;
      }
      const components = shell.children.filter((child) => child.type === "COMPONENT");
      if (components.length < 1) {
        console.warn("Unable to create component set because it has no component children:", (data == null ? void 0 : data.name) || (data == null ? void 0 : data.id) || "Untitled");
        safeSet(shell, "name", data.name);
        return;
      }
      try {
        const parentIndex = parent.children.indexOf(shell);
        for (let index = 0; index < components.length; index++) {
          const component = components[index];
          safeSet(component, "name", createFigmaVariantName(component.name, index));
        }
        const componentSet = figma.combineAsVariants(
          components,
          parent,
          parentIndex >= 0 ? parentIndex : parent.children.length
        );
        safeRemove(shell);
        yield applyPropertiesCallback(componentSet, data);
        restoreComponentSetChildLayouts(componentSet);
      } catch (error) {
        console.warn("Unable to create native component set, keeping frame fallback:", (data == null ? void 0 : data.name) || (data == null ? void 0 : data.id) || "Untitled", error);
        safeSet(shell, "name", data.name);
      }
    });
  }
  function createFigmaVariantName(name, index) {
    const fallback = `Variant ${index + 1}`;
    if (!name) return `Property 1=${fallback}`;
    const bracketed = name.match(/^(.+?)\[[^\]]+\]=(.+)$/);
    if (bracketed) {
      return `${sanitizeVariantPropertyName(bracketed[1])}=${sanitizeVariantValue(bracketed[2], fallback)}`;
    }
    const equalsIndex = name.indexOf("=");
    if (equalsIndex > 0 && equalsIndex < name.length - 1) {
      return `${sanitizeVariantPropertyName(name.slice(0, equalsIndex))}=${sanitizeVariantValue(name.slice(equalsIndex + 1), fallback)}`;
    }
    return `Property 1=${sanitizeVariantValue(name, fallback)}`;
  }
  function sanitizeVariantPropertyName(value) {
    const trimmed = String(value || "").trim();
    return trimmed || "Property 1";
  }
  function sanitizeVariantValue(value, fallback) {
    const trimmed = String(value || "").trim();
    return trimmed || fallback;
  }
  function restoreComponentSetChildLayouts(componentSet) {
    for (const child of componentSet.children) {
      if (child.type !== "COMPONENT") continue;
      const layout = state.restoredLayoutByNodeId[child.id];
      if (layout) {
        if (layout.width !== void 0 && layout.height !== void 0) {
          safeResize(child, layout.width, layout.height);
        }
        if (hasFiniteRelativeTransform3(layout)) {
          safeSet(child, "relativeTransform", layout.relativeTransform);
        } else {
          if (layout.x !== void 0) safeSet(child, "x", layout.x);
          if (layout.y !== void 0) safeSet(child, "y", layout.y);
        }
      }
    }
  }
  function hasFiniteRelativeTransform3(layout) {
    return Array.isArray(layout == null ? void 0 : layout.relativeTransform) && Array.isArray(layout.relativeTransform[0]) && Array.isArray(layout.relativeTransform[1]) && Number.isFinite(layout.relativeTransform[0][0]) && Number.isFinite(layout.relativeTransform[0][1]) && Number.isFinite(layout.relativeTransform[0][2]) && Number.isFinite(layout.relativeTransform[1][0]) && Number.isFinite(layout.relativeTransform[1][1]) && Number.isFinite(layout.relativeTransform[1][2]);
  }
  function shouldRestoreGroupNode(data) {
    if (!data) return false;
    if (data.receiveCreateOverride === "SVG" || data.svgFallback) return false;
    return data.sourceType === "GROUP" && (data.type === "GROUP" || data.restoreType === "GROUP" || data.receiveCreateOverride === "GROUP");
  }
  function restoreGroupNode(nodeProps, parent, layerRecord, layers, restoredBefore, totalNodes, restoreNodeCallback, applyPropertiesCallback, maybeReportProgressCallback) {
    return __async(this, null, function* () {
      const shell = figma.createFrame();
      const childIds = nodeProps.omitChildrenOnRestore ? [] : layerRecord.childIds || [];
      const shellProps = createContainerShellFrameProps(nodeProps);
      let appended = false;
      try {
        if (!appendRestoredNode(parent, shell)) return 0;
        appended = true;
        yield applyPropertiesCallback(shell, shellProps);
      } catch (error) {
        console.warn("Unable to create group restore shell:", (nodeProps == null ? void 0 : nodeProps.name) || layerRecord.name, error);
        if (appended) safeRemove(shell);
        return 0;
      }
      let restoredCount = 1;
      yield maybeReportProgressCallback(restoredBefore + restoredCount, totalNodes, "\u6B63\u5728\u8FD8\u539F\uFF1A" + (nodeProps.name || layerRecord.name));
      for (const childId of childIds) {
        restoredCount += yield restoreNodeCallback(childId, shell, layers, restoredBefore + restoredCount, totalNodes);
      }
      yield finalizeGroupShell(shell, nodeProps, applyPropertiesCallback);
      return restoredCount;
    });
  }
  function finalizeGroupShell(shell, data, applyPropertiesCallback) {
    return __async(this, null, function* () {
      const parent = shell.parent;
      const children = [...shell.children];
      if (!parent || !("insertChild" in parent) || children.length < 1) {
        safeSet(shell, "name", data.name);
        return;
      }
      try {
        const parentIndex = parent.children.indexOf(shell);
        const group = figma.group(
          children,
          parent,
          parentIndex >= 0 ? parentIndex : parent.children.length
        );
        safeRemove(shell);
        yield applyPropertiesCallback(group, createFinalizedContainerProps(data, hasNonTranslationTransform(data == null ? void 0 : data.layout)));
      } catch (error) {
        console.warn("Unable to create native group, keeping frame fallback:", (data == null ? void 0 : data.name) || (data == null ? void 0 : data.id) || "Untitled", error);
        safeSet(shell, "name", data.name);
      }
    });
  }
  function restoreBooleanOperationTree(nodeProps, parent, layerRecord, layers, restoredBefore, totalNodes, restoreNodeCallback, applyPropertiesCallback, maybeReportProgressCallback) {
    return __async(this, null, function* () {
      logBooleanRestoreDebug("restore-start", {
        build: BOOLEAN_RESTORE_DEBUG_BUILD,
        sourceId: nodeProps == null ? void 0 : nodeProps.id,
        name: (nodeProps == null ? void 0 : nodeProps.name) || layerRecord.name,
        sourceType: nodeProps == null ? void 0 : nodeProps.sourceType,
        type: nodeProps == null ? void 0 : nodeProps.type,
        restoreType: nodeProps == null ? void 0 : nodeProps.restoreType,
        operation: nodeProps == null ? void 0 : nodeProps.booleanOperation,
        childIds: layerRecord.childIds || [],
        omitChildrenOnRestore: !!(nodeProps == null ? void 0 : nodeProps.omitChildrenOnRestore)
      });
      const shell = figma.createFrame();
      const shellProps = createBooleanFrameFallbackProps(nodeProps);
      let appended = false;
      try {
        if (!appendRestoredNode(parent, shell)) return 0;
        appended = true;
        yield applyPropertiesCallback(shell, shellProps);
      } catch (error) {
        console.warn("Unable to create boolean restore shell:", (nodeProps == null ? void 0 : nodeProps.name) || layerRecord.name, error);
        if (appended) safeRemove(shell);
        return yield restoreBooleanFallbackNode(nodeProps, parent, layerRecord, restoredBefore, totalNodes, applyPropertiesCallback, maybeReportProgressCallback);
      }
      let restoredCount = 1;
      const currentCount = restoredBefore + restoredCount;
      yield maybeReportProgressCallback(currentCount, totalNodes, "\u6B63\u5728\u8FD8\u539F\uFF1A" + (nodeProps.name || layerRecord.name));
      const childIds = nodeProps.omitChildrenOnRestore ? [] : layerRecord.childIds || [];
      for (const childId of childIds) {
        restoredCount += yield restoreNodeCallback(childId, shell, layers, restoredBefore + restoredCount, totalNodes);
      }
      logBooleanRestoreDebug("children-restored", {
        build: BOOLEAN_RESTORE_DEBUG_BUILD,
        sourceId: nodeProps == null ? void 0 : nodeProps.id,
        name: (nodeProps == null ? void 0 : nodeProps.name) || layerRecord.name,
        shell: summarizeSceneNode(shell),
        children: [...shell.children].map(summarizeSceneNode)
      });
      const combined = yield combineBooleanShell(shell, nodeProps, applyPropertiesCallback);
      if (!combined) {
        yield restoreBooleanFallbackFromShell(shell, nodeProps, applyPropertiesCallback);
      }
      return restoredCount;
    });
  }
  function combineBooleanShell(shell, data, applyPropertiesCallback) {
    return __async(this, null, function* () {
      const parent = shell.parent;
      if (!parent || !("insertChild" in parent)) return null;
      const children = [...shell.children];
      logBooleanRestoreDebug("combine-start", {
        build: BOOLEAN_RESTORE_DEBUG_BUILD,
        sourceId: data == null ? void 0 : data.id,
        name: data == null ? void 0 : data.name,
        operation: data == null ? void 0 : data.booleanOperation,
        childCount: children.length,
        children: children.map(summarizeSceneNode)
      });
      if (children.length === 1) {
        return yield promoteSingleBooleanChild(shell, children[0], data);
      }
      if (children.length < 1) {
        console.warn("Unable to restore boolean operation because it has no children:", (data == null ? void 0 : data.name) || (data == null ? void 0 : data.id) || "Untitled");
        return null;
      }
      const operation = normalizeBooleanOperation(data.booleanOperation);
      if (!operation) {
        console.warn("Unsupported boolean operation:", data == null ? void 0 : data.booleanOperation, (data == null ? void 0 : data.name) || (data == null ? void 0 : data.id) || "Untitled");
        return null;
      }
      try {
        const booleanChildren = flattenStrokeOnlyBooleanChildren(children, shell);
        logBooleanRestoreDebug("after-flatten", {
          build: BOOLEAN_RESTORE_DEBUG_BUILD,
          sourceId: data == null ? void 0 : data.id,
          name: data == null ? void 0 : data.name,
          operation,
          sourceOperation: data == null ? void 0 : data.booleanOperation,
          children: booleanChildren.map(summarizeSceneNode)
        });
        const combined = createBooleanContainerNode(operation, booleanChildren, shell, parent);
        yield applyPropertiesCallback(combined, data);
        logBooleanRestoreDebug("combine-complete", {
          build: BOOLEAN_RESTORE_DEBUG_BUILD,
          sourceId: data == null ? void 0 : data.id,
          name: data == null ? void 0 : data.name,
          combined: summarizeSceneNode(combined),
          children: [...combined.children].map(summarizeSceneNode)
        });
        safeRemove(shell);
        return combined;
      } catch (error) {
        console.warn("Unable to combine boolean operation, falling back:", (data == null ? void 0 : data.name) || (data == null ? void 0 : data.id) || "Untitled", error);
        return null;
      }
    });
  }
  function flattenStrokeOnlyBooleanChildren(children, parent) {
    const result = [];
    for (const child of children) {
      if (!shouldFlattenBooleanChild(child)) {
        logBooleanRestoreDebug("flatten-skip", {
          build: BOOLEAN_RESTORE_DEBUG_BUILD,
          child: summarizeSceneNode(child),
          reason: describeFlattenSkipReason(child)
        });
        result.push(child);
        continue;
      }
      try {
        const index = parent.children.indexOf(child);
        const beforeSummary = summarizeSceneNode(child);
        logBooleanRestoreDebug("flatten-before", {
          build: BOOLEAN_RESTORE_DEBUG_BUILD,
          child: beforeSummary,
          parentChildIndex: index
        });
        const flattened = figma.flatten([child], parent, index >= 0 ? index : parent.children.length);
        logBooleanRestoreDebug("flatten-after", {
          build: BOOLEAN_RESTORE_DEBUG_BUILD,
          before: beforeSummary,
          flattened: summarizeSceneNode(flattened)
        });
        result.push(flattened);
      } catch (error) {
        console.warn("Unable to flatten stroked boolean child, keeping original:", child.name, error);
        result.push(child);
      }
    }
    return result;
  }
  function shouldFlattenBooleanChild(node) {
    if (!isStrokeOnlyWithoutVisibleFill(node)) return false;
    return hasClosedVectorRegion(node);
  }
  function hasClosedVectorRegion(node) {
    const vectorNetwork = node.vectorNetwork;
    return !!vectorNetwork && Array.isArray(vectorNetwork.regions) && vectorNetwork.regions.length > 0;
  }
  function isStrokeOnlyWithoutVisibleFill(node) {
    if (!("strokes" in node)) return false;
    const strokes = node.strokes;
    if (!Array.isArray(strokes) || strokes.length === 0) return false;
    if (!("fills" in node)) return true;
    const fills = node.fills;
    return !Array.isArray(fills) || fills.length === 0 || fills.every((fill) => !fill || fill.visible === false);
  }
  function describeFlattenSkipReason(node) {
    if (!("strokes" in node)) return "node-has-no-strokes-property";
    const strokes = node.strokes;
    if (!Array.isArray(strokes) || strokes.length === 0) return "node-has-no-strokes";
    if (!hasClosedVectorRegion(node)) return "node-has-no-closed-region";
    if (!("fills" in node)) return "node-has-strokes-and-no-fills-property";
    const fills = node.fills;
    if (!Array.isArray(fills) || fills.length === 0) return "node-has-strokes-and-no-fills";
    if (fills.every((fill) => !fill || fill.visible === false)) return "node-has-only-hidden-fills";
    return "node-has-visible-fill";
  }
  function summarizeSceneNode(node) {
    const nodeAny = node;
    const fills = "fills" in nodeAny && Array.isArray(nodeAny.fills) ? nodeAny.fills : [];
    const strokes = "strokes" in nodeAny && Array.isArray(nodeAny.strokes) ? nodeAny.strokes : [];
    const vectorNetwork = nodeAny.vectorNetwork;
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      x: "x" in nodeAny ? nodeAny.x : void 0,
      y: "y" in nodeAny ? nodeAny.y : void 0,
      width: "width" in nodeAny ? nodeAny.width : void 0,
      height: "height" in nodeAny ? nodeAny.height : void 0,
      relativeTransform: nodeAny.relativeTransform,
      booleanOperation: nodeAny.booleanOperation,
      fills: fills.map(summarizePaint),
      strokes: strokes.map(summarizePaint),
      strokeWeight: nodeAny.strokeWeight,
      vectorNetwork: vectorNetwork ? {
        vertices: Array.isArray(vectorNetwork.vertices) ? vectorNetwork.vertices.length : void 0,
        segments: Array.isArray(vectorNetwork.segments) ? vectorNetwork.segments.length : void 0,
        regions: Array.isArray(vectorNetwork.regions) ? vectorNetwork.regions.length : void 0
      } : void 0,
      children: "children" in nodeAny ? nodeAny.children.length : void 0
    };
  }
  function summarizePaint(paint) {
    if (!paint || typeof paint !== "object") return paint;
    return {
      type: paint.type,
      visible: paint.visible,
      opacity: paint.opacity,
      blendMode: paint.blendMode
    };
  }
  function logBooleanRestoreDebug(stage, payload) {
    console.log(`[MasterGo2Figma][BooleanRestore][${stage}]`, payload);
  }
  function createBooleanContainerNode(operation, children, shell, parent) {
    const parentIndex = parent.children.indexOf(shell);
    const operationNode = figma.createBooleanOperation();
    safeSet(operationNode, "booleanOperation", operation);
    parent.insertChild(parentIndex >= 0 ? parentIndex : parent.children.length, operationNode);
    for (const child of children) {
      operationNode.appendChild(child);
    }
    return operationNode;
  }
  function promoteSingleBooleanChild(shell, child, data) {
    return __async(this, null, function* () {
      const parent = shell.parent;
      if (!parent || !("insertChild" in parent)) return null;
      try {
        const parentIndex = parent.children.indexOf(shell);
        const transform = composeSingleBooleanChildTransform(shell, child, data);
        parent.insertChild(parentIndex >= 0 ? parentIndex : parent.children.length, child);
        if (transform) safeSet(child, "relativeTransform", transform);
        safeSet(child, "name", (data == null ? void 0 : data.name) || child.name);
        safeRemove(shell);
        return child;
      } catch (error) {
        console.warn("Unable to promote single-child boolean operation:", (data == null ? void 0 : data.name) || (data == null ? void 0 : data.id) || "Untitled", error);
        return null;
      }
    });
  }
  function composeSingleBooleanChildTransform(shell, child, data) {
    var _a;
    const parentTransform = ((_a = data == null ? void 0 : data.layout) == null ? void 0 : _a.relativeTransform) || shell.relativeTransform;
    const childTransform = child.relativeTransform;
    if (!hasFiniteTransform(parentTransform) || !hasFiniteTransform(childTransform)) return null;
    return multiplyTransforms(parentTransform, childTransform);
  }
  function multiplyTransforms(parent, child) {
    return [
      [
        parent[0][0] * child[0][0] + parent[0][1] * child[1][0],
        parent[0][0] * child[0][1] + parent[0][1] * child[1][1],
        parent[0][0] * child[0][2] + parent[0][1] * child[1][2] + parent[0][2]
      ],
      [
        parent[1][0] * child[0][0] + parent[1][1] * child[1][0],
        parent[1][0] * child[0][1] + parent[1][1] * child[1][1],
        parent[1][0] * child[0][2] + parent[1][1] * child[1][2] + parent[1][2]
      ]
    ];
  }
  function restoreBooleanFallbackFromShell(shell, data, applyPropertiesCallback) {
    return __async(this, null, function* () {
      const parent = shell.parent;
      if (!parent || !("insertChild" in parent)) return;
      state.booleanFallbackCount++;
      yield applyPropertiesCallback(shell, createBooleanFrameFallbackProps(data));
    });
  }
  function restoreBooleanFallbackNode(data, parent, layerRecord, restoredBefore, totalNodes, applyPropertiesCallback, maybeReportProgressCallback) {
    return __async(this, null, function* () {
      state.booleanFallbackCount++;
      const fallbackNode = figma.createFrame();
      const fallbackProps = createBooleanFrameFallbackProps(data);
      try {
        if (!appendRestoredNode(parent, fallbackNode)) return 0;
        yield applyPropertiesCallback(fallbackNode, fallbackProps);
      } catch (error) {
        console.warn("Unable to restore boolean fallback:", (data == null ? void 0 : data.name) || layerRecord.name, error);
        safeRemove(fallbackNode);
        return 0;
      }
      const currentCount = restoredBefore + 1;
      yield maybeReportProgressCallback(currentCount, totalNodes, "\u6B63\u5728\u8FD8\u539F\uFF1A" + (data.name || layerRecord.name));
      return 1;
    });
  }

  // src/code.ts
  var RESTORE_PROGRESS_NODE_INTERVAL = 100;
  var RESTORE_PROGRESS_TIME_INTERVAL_MS = 500;
  var activeImportSession = null;
  var pendingImportAssets = {};
  var pendingImportPages = {};
  showImportUI();
  function showImportUI() {
    ensureLayerRulesLoaded();
    figma.showUI(__html__, { width: 400, height: 630 });
    figma.ui.onmessage = (message) => __async(null, null, function* () {
      if (!message || typeof message !== "object") return;
      if (message.type === "ui-ready") {
        yield postInitUI();
        return;
      }
      if (message.type === "close") {
        figma.closePlugin();
        return;
      }
      if (message.type === "resize") {
        const width = typeof message.width === "number" ? message.width : 400;
        const height = typeof message.height === "number" ? message.height : 504;
        figma.ui.resize(width, height);
        return;
      }
      if (message.type === "import-session-start") {
        yield handleImportRequest(message, () => startImportSession(message));
        return;
      }
      if (message.type === "import-asset-start") {
        yield handleImportRequest(message, () => startImportAsset(message));
        return;
      }
      if (message.type === "import-asset-chunk") {
        appendImportAssetChunk(message);
        return;
      }
      if (message.type === "import-asset-end") {
        yield handleImportRequest(message, () => finishImportAsset(message));
        return;
      }
      if (message.type === "import-page-start") {
        yield handleImportRequest(message, () => startImportPage(message));
        return;
      }
      if (message.type === "import-page-chunk") {
        appendImportPageChunk(message);
        return;
      }
      if (message.type === "import-page-end") {
        yield handleImportRequest(message, () => finishImportPage(message));
        return;
      }
      if (message.type === "import-page") {
        yield handleImportRequest(message, () => restoreImportSessionPage(message));
        return;
      }
      if (message.type === "import-session-complete") {
        yield completeImportSession(message);
        return;
      }
      if (message.type !== "start-import") return;
      if (state.importInProgress) return;
      state.importInProgress = true;
      try {
        yield ensureLayerRulesLoaded();
        if (message.payload) {
          yield restoreImportPayload(message.payload);
        } else {
          throw new Error("\u8BF7\u5148\u9009\u62E9\u6709\u6548\u7684 MasterGo2Figma zip");
        }
      } catch (error) {
        console.error("Import failed:", error);
        figma.ui.postMessage({
          type: "error",
          message: error instanceof Error ? error.message : "\u5BFC\u5165\u5931\u8D25\uFF0C\u8BF7\u67E5\u770B\u63A7\u5236\u53F0"
        });
      }
      state.importInProgress = false;
    });
  }
  function handleImportRequest(message, action) {
    return __async(this, null, function* () {
      try {
        yield action();
        figma.ui.postMessage({
          type: "import-ack",
          requestId: message.requestId,
          transferId: message.transferId,
          success: true
        });
      } catch (error) {
        console.error("Import request failed:", error);
        if (typeof message.type === "string" && message.type.indexOf("import-") === 0) {
          state.importInProgress = false;
          activeImportSession = null;
          clearPendingImportAssets();
          clearPendingImportPages();
        }
        figma.ui.postMessage({
          type: "import-ack",
          requestId: message.requestId,
          transferId: message.transferId,
          success: false,
          error: error instanceof Error ? error.message : "\u5BFC\u5165\u5931\u8D25\uFF0C\u8BF7\u67E5\u770B\u63A7\u5236\u53F0"
        });
      }
    });
  }
  function startImportSession(message) {
    return __async(this, null, function* () {
      var _a, _b;
      if (state.importInProgress) throw new Error("\u5DF2\u6709\u5BFC\u5165\u4EFB\u52A1\u6B63\u5728\u8FD0\u884C");
      yield ensureLayerRulesLoaded();
      if (!hasValidLayerRules()) throw new Error("\u8BF7\u5148\u5BFC\u5165\u6709\u6548\u7684\u56FE\u5C42\u8F6C\u6362\u89C4\u5219 JSON");
      const manifest = message.manifest;
      if (!manifest || manifest.schema !== "mastergo2figma.package.v2" || manifest.version !== 2) {
        throw new Error("\u5F53\u524D\u53EA\u652F\u6301 v2 \u5BFC\u51FA\u5305\uFF0C\u8BF7\u7528\u65B0\u7248 SendToFigma \u91CD\u65B0\u5BFC\u51FA\u3002");
      }
      const totalNodes = Number(message.totalNodes || ((_a = manifest.stats) == null ? void 0 : _a.layerCount) || 0);
      const totalPages = Number(message.totalPages || ((_b = manifest.pages) == null ? void 0 : _b.length) || 0);
      if (totalNodes <= 0 || totalPages <= 0) throw new Error("\u6240\u9009\u9875\u9762\u6CA1\u6709\u53EF\u8FD8\u539F\u7684\u56FE\u5C42");
      state.importInProgress = true;
      state.reset();
      state.resetRestoreRuntimeStats(totalNodes, totalPages);
      clearPendingImportAssets();
      clearPendingImportPages();
      activeImportSession = {
        transferId: String(message.transferId || ""),
        manifest,
        totalPages,
        totalNodes,
        restoredNodes: 0,
        restoredPages: [],
        previousCurrentPage: figma.currentPage
      };
      figma.ui.postMessage({
        type: "progress",
        current: 0,
        total: totalNodes,
        label: "\u6B63\u5728\u63A5\u6536\u5BFC\u5165\u6570\u636E..."
      });
    });
  }
  function startImportAsset(message) {
    const session = requireImportSession(message.transferId);
    const path = String(message.path || "");
    if (!path) throw new Error("\u56FE\u7247\u8D44\u6E90\u7F3A\u5C11\u8DEF\u5F84");
    pendingImportAssets[path] = {
      path,
      keys: Array.isArray(message.keys) ? message.keys.filter((key) => typeof key === "string") : [],
      size: Number(message.size || 0),
      chunks: []
    };
    void session;
  }
  function appendImportAssetChunk(message) {
    if (!activeImportSession || activeImportSession.transferId !== message.transferId) return;
    const path = String(message.path || "");
    const pending = pendingImportAssets[path];
    if (!pending) return;
    const bytes = normalizeBytes(message.bytes);
    if (bytes) pending.chunks.push(bytes);
  }
  function finishImportAsset(message) {
    requireImportSession(message.transferId);
    const path = String(message.path || "");
    const pending = pendingImportAssets[path];
    if (!pending) throw new Error(`\u56FE\u7247\u8D44\u6E90\u4F20\u8F93\u4E0D\u5B58\u5728\uFF1A${path}`);
    const bytes = concatBytes(pending.chunks, pending.size);
    try {
      const image = figma.createImage(bytes);
      for (const key of pending.keys) state.imageHashByAssetName[key] = image.hash;
      if (pending.keys.length === 0) state.imageHashByAssetName[path] = image.hash;
    } catch (error) {
      console.warn("Unable to create Figma image from streamed asset:", path, error);
      for (const key of pending.keys.length > 0 ? pending.keys : [path]) recordStreamedMissingImage(key);
    }
    delete pendingImportAssets[path];
  }
  function startImportPage(message) {
    requireImportSession(message.transferId);
    const pageIndex = Number(message.pageIndex || 0);
    const importPage = message.page;
    if (!importPage || !Array.isArray(importPage.rootNodeIds)) throw new Error("\u9875\u9762\u5BFC\u5165\u6570\u636E\u4E0D\u5B8C\u6574");
    pendingImportPages[String(pageIndex)] = {
      pageIndex,
      page: importPage,
      layers: {},
      recordCount: 0
    };
  }
  function appendImportPageChunk(message) {
    if (!activeImportSession || activeImportSession.transferId !== message.transferId) return;
    const pageIndex = String(Number(message.pageIndex || 0));
    const pending = pendingImportPages[pageIndex];
    if (!pending || !Array.isArray(message.records)) return;
    for (const record of message.records) {
      if (record && record.id) {
        pending.layers[record.id] = record;
        pending.recordCount++;
      }
    }
  }
  function finishImportPage(message) {
    return __async(this, null, function* () {
      requireImportSession(message.transferId);
      const pageIndex = String(Number(message.pageIndex || 0));
      const pending = pendingImportPages[pageIndex];
      if (!pending) throw new Error(`\u9875\u9762\u4F20\u8F93\u4E0D\u5B58\u5728\uFF1A${pageIndex}`);
      try {
        yield restoreImportPageData(pending.page, pending.layers);
      } finally {
        delete pendingImportPages[pageIndex];
      }
    });
  }
  function restoreImportSessionPage(message) {
    return __async(this, null, function* () {
      requireImportSession(message.transferId);
      const importPage = message.page;
      const layers = message.layers;
      if (!importPage || !Array.isArray(importPage.rootNodeIds) || !layers || typeof layers !== "object") {
        throw new Error("\u9875\u9762\u5BFC\u5165\u6570\u636E\u4E0D\u5B8C\u6574");
      }
      yield restoreImportPageData(importPage, layers);
    });
  }
  function restoreImportPageData(importPage, layers) {
    return __async(this, null, function* () {
      if (!activeImportSession) throw new Error("\u5BFC\u5165\u4F1A\u8BDD\u4E0D\u5B58\u5728\u6216\u5DF2\u91CD\u7F6E");
      const session = activeImportSession;
      figma.ui.postMessage({
        type: "progress",
        current: session.restoredNodes,
        total: session.totalNodes,
        label: "\u6B63\u5728\u521B\u5EFA\u9875\u9762\uFF1A" + createRestoredPageName(importPage.name)
      });
      const restoredPage = figma.createPage();
      restoredPage.name = createRestoredPageName(importPage.name);
      session.restoredPages.push(restoredPage);
      figma.currentPage = restoredPage;
      for (let rootIndex = 0; rootIndex < importPage.rootNodeIds.length; rootIndex++) {
        const rootId = importPage.rootNodeIds[rootIndex];
        session.restoredNodes += yield restoreImportedNode(rootId, restoredPage, layers, session.restoredNodes, session.totalNodes);
      }
      applyDeferredLayoutRestores();
      cleanupImportedContainerShells(restoredPage);
      applyDeferredSingleChildAutoSpaceAlignmentFixes(restoredPage);
      yield yieldToEventLoop();
    });
  }
  function completeImportSession(message) {
    return __async(this, null, function* () {
      const session = requireImportSession(message.transferId);
      try {
        applyDeferredConnectorRestores();
        yield maybeReportRestoreProgress(session.restoredNodes, session.totalNodes, "\u6B63\u5728\u8FD8\u539F\u7F3A\u5931\u5B57\u4F53...", true);
        const missingFontRestoreResult = yield restoreMissingFontTextLayers(session.restoredPages);
        yield maybeReportRestoreProgress(session.restoredNodes, session.totalNodes, "\u6B63\u5728\u5B8C\u6210\u8FD8\u539F...", true);
        if (session.restoredPages.length > 0) {
          figma.currentPage = session.restoredPages[0];
          figma.viewport.scrollAndZoomIntoView(session.restoredPages[0].children);
        }
        figma.ui.postMessage({
          type: "complete",
          pageCount: session.restoredPages.length,
          layerCount: session.restoredNodes,
          missingImageAssetCount: state.missingImageAssetCount,
          fallbackConnectorCount: state.fallbackConnectorCount,
          restoredMissingFontTextNodeCount: missingFontRestoreResult.restoredTextNodeCount,
          failedMissingFontTextNodeCount: missingFontRestoreResult.failedTextNodeCount
        });
        state.logRestorePerformanceSummary(session.restoredNodes, session.restoredPages.length);
        figma.notify("Restore complete!");
      } catch (error) {
        figma.currentPage = session.previousCurrentPage;
        console.error("Import failed:", error);
        figma.ui.postMessage({
          type: "error",
          message: error instanceof Error ? error.message : "\u5BFC\u5165\u5931\u8D25\uFF0C\u8BF7\u67E5\u770B\u63A7\u5236\u53F0"
        });
      } finally {
        state.importInProgress = false;
        activeImportSession = null;
        clearPendingImportAssets();
        clearPendingImportPages();
      }
    });
  }
  function requireImportSession(transferId) {
    if (!activeImportSession || activeImportSession.transferId !== transferId) {
      throw new Error("\u5BFC\u5165\u4F1A\u8BDD\u4E0D\u5B58\u5728\u6216\u5DF2\u91CD\u7F6E");
    }
    return activeImportSession;
  }
  function concatBytes(chunks, expectedSize) {
    const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (expectedSize > 0 && size !== expectedSize) {
      throw new Error(`\u56FE\u7247\u8D44\u6E90\u4F20\u8F93\u4E0D\u5B8C\u6574\uFF1Aexpected=${expectedSize}, actual=${size}`);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
  function clearPendingImportAssets() {
    for (const path in pendingImportAssets) delete pendingImportAssets[path];
  }
  function clearPendingImportPages() {
    for (const pageIndex in pendingImportPages) delete pendingImportPages[pageIndex];
  }
  function recordStreamedMissingImage(assetName) {
    if (state.missingImageAssetNames[assetName]) return;
    state.missingImageAssetNames[assetName] = true;
    state.missingImageAssetCount++;
  }
  function postInitUI() {
    return __async(this, null, function* () {
      yield ensureLayerRulesLoaded();
      figma.ui.postMessage({
        type: "init",
        rules: getLayerRuleStatus()
      });
    });
  }
  function normalizeImportAssets(assets) {
    const result = {};
    if (!assets || typeof assets !== "object") return result;
    for (const fileName in assets) {
      const bytes = normalizeBytes(assets[fileName]);
      if (bytes) result[fileName] = bytes;
    }
    return result;
  }
  function normalizeBytes(value) {
    if (!value) return null;
    if (value instanceof Uint8Array) return value;
    if (Array.isArray(value)) return new Uint8Array(value);
    if (typeof value.length === "number") return new Uint8Array(value);
    if (typeof value === "object") {
      const keys = Object.keys(value).filter((key) => /^\d+$/.test(key));
      if (keys.length > 0) {
        const bytes = new Uint8Array(keys.length);
        keys.sort((a, b) => Number(a) - Number(b));
        for (let index = 0; index < keys.length; index++) {
          bytes[index] = Number(value[keys[index]]) || 0;
        }
        return bytes;
      }
    }
    return null;
  }
  function createRestoredPageName(name) {
    return name || "Imported Page";
  }
  function maybeReportRestoreProgress(current, total, label, force = false) {
    return __async(this, null, function* () {
      const now = Date.now();
      const progState = state.activeProgressState || {
        total,
        lastCurrent: 0,
        lastPostedAt: 0
      };
      const shouldPost = force || current >= total || current - progState.lastCurrent >= RESTORE_PROGRESS_NODE_INTERVAL || now - progState.lastPostedAt >= RESTORE_PROGRESS_TIME_INTERVAL_MS;
      if (!shouldPost) return;
      figma.ui.postMessage({
        type: "progress",
        current,
        total,
        label
      });
      progState.total = total;
      progState.lastCurrent = current;
      progState.lastPostedAt = now;
      state.activeProgressState = progState;
      yield yieldToEventLoop();
    });
  }
  function restoreImportPayload(payload) {
    return __async(this, null, function* () {
      yield ensureLayerRulesLoaded();
      if (!hasValidLayerRules()) throw new Error("\u8BF7\u5148\u5BFC\u5165\u6709\u6548\u7684\u56FE\u5C42\u8F6C\u6362\u89C4\u5219 JSON");
      if (!payload || !payload.manifest || !payload.pages || !payload.layers) {
        throw new Error("\u5BFC\u5165\u6570\u636E\u4E0D\u5B8C\u6574");
      }
      if (payload.manifest.schema !== "mastergo2figma.package.v2" || payload.manifest.version !== 2) {
        throw new Error("\u5F53\u524D\u53EA\u652F\u6301 v2 \u5BFC\u51FA\u5305\uFF0C\u8BF7\u7528\u65B0\u7248 SendToFigma \u91CD\u65B0\u5BFC\u51FA\u3002");
      }
      state.reset();
      state.activeImportAssets = normalizeImportAssets(payload.assets || {});
      let totalNodes = 0;
      for (const page of payload.pages) totalNodes += page.layerCount || 0;
      if (totalNodes === 0) throw new Error("\u6240\u9009\u9875\u9762\u6CA1\u6709\u53EF\u8FD8\u539F\u7684\u56FE\u5C42");
      state.resetRestoreRuntimeStats(totalNodes, payload.pages.length);
      const previousCurrentPage = figma.currentPage;
      let restoredNodes = 0;
      const restoredPages = [];
      try {
        figma.ui.postMessage({
          type: "progress",
          current: 0,
          total: totalNodes,
          label: "\u6B63\u5728\u521B\u5EFA Figma \u9875\u9762..."
        });
        for (let pageIndex = 0; pageIndex < payload.pages.length; pageIndex++) {
          const importPage = payload.pages[pageIndex];
          const restoredPage = figma.createPage();
          restoredPage.name = createRestoredPageName(importPage.name);
          restoredPages.push(restoredPage);
          figma.currentPage = restoredPage;
          for (let rootIndex = 0; rootIndex < importPage.rootNodeIds.length; rootIndex++) {
            const rootId = importPage.rootNodeIds[rootIndex];
            restoredNodes += yield restoreImportedNode(rootId, restoredPage, payload.layers, restoredNodes, totalNodes);
          }
          applyDeferredLayoutRestores();
          cleanupImportedContainerShells(restoredPage);
          applyDeferredSingleChildAutoSpaceAlignmentFixes(restoredPage);
        }
      } catch (error) {
        figma.currentPage = previousCurrentPage;
        throw error;
      }
      applyDeferredConnectorRestores();
      yield maybeReportRestoreProgress(restoredNodes, totalNodes, "\u6B63\u5728\u8FD8\u539F\u7F3A\u5931\u5B57\u4F53...", true);
      const missingFontRestoreResult = yield restoreMissingFontTextLayers(restoredPages);
      yield maybeReportRestoreProgress(restoredNodes, totalNodes, "\u6B63\u5728\u5B8C\u6210\u8FD8\u539F...", true);
      if (restoredPages.length > 0) {
        figma.currentPage = restoredPages[0];
        figma.viewport.scrollAndZoomIntoView(restoredPages[0].children);
      }
      figma.ui.postMessage({
        type: "complete",
        pageCount: restoredPages.length,
        layerCount: restoredNodes,
        missingImageAssetCount: state.missingImageAssetCount,
        fallbackConnectorCount: state.fallbackConnectorCount,
        restoredMissingFontTextNodeCount: missingFontRestoreResult.restoredTextNodeCount,
        failedMissingFontTextNodeCount: missingFontRestoreResult.failedTextNodeCount
      });
      const completeDetails = [];
      if (state.missingImageAssetCount > 0) {
        completeDetails.push(`Missing images: ${state.missingImageAssetCount}`);
      }
      if (state.fallbackConnectorCount > 0) {
        completeDetails.push(`Connectors restored as polylines: ${state.fallbackConnectorCount}`);
      }
      if (missingFontRestoreResult.restoredTextNodeCount > 0) {
        completeDetails.push(`Fonts restored: ${missingFontRestoreResult.restoredTextNodeCount}`);
      }
      if (missingFontRestoreResult.failedTextNodeCount > 0) {
        completeDetails.push(`Fonts still missing: ${missingFontRestoreResult.failedTextNodeCount}`);
      }
      state.logRestorePerformanceSummary(restoredNodes, restoredPages.length);
      figma.notify(completeDetails.length > 0 ? `Restore complete. ${completeDetails.join("; ")}` : "Restore complete!");
    });
  }
  function applyManifestLayoutToProps(props, _meta) {
    return props;
  }
  function isConnectorRestoreData(data) {
    return !!data && (data.sourceType === "CONNECTOR" || data.type === "CONNECTOR" || data.restoreType === "CONNECTOR");
  }
  function prepareConnectorPolylineFallbackProps(data, parent) {
    if (!isConnectorRestoreData(data)) return data;
    const props = __spreadValues({}, data);
    props.connectorFallbackPolyline = true;
    if (!hasUsableVectorNetwork(props.vectorNetwork)) {
      props.vectorNetwork = createConnectorVectorNetworkFromData(props, parent);
    }
    return props;
  }
  function shouldPreserveVectorLayoutBoxForAutoLayout(data, parent) {
    if (!data || !data.vectorNetwork) return false;
    const sourceType = data.sourceType || data.type;
    if (sourceType !== "PEN" && sourceType !== "VECTOR") return false;
    if (!parent || !("id" in parent)) return false;
    const restoredParentLayout = state.restoredLayoutByNodeId[parent.id];
    const parentLayoutMode = restoredParentLayout && restoredParentLayout.layoutMode;
    if (parentLayoutMode && parentLayoutMode !== "NONE") return true;
    return "layoutMode" in parent && parent.layoutMode !== "NONE";
  }
  function markVectorAutoLayoutBox(data) {
    return __spreadProps(__spreadValues({}, data), {
      vectorAutoLayoutBox: true
    });
  }
  function restoreImportedNode(nodeId, parent, layers, restoredBefore, totalNodes) {
    return __async(this, null, function* () {
      const layerRecord = layers[nodeId];
      if (!layerRecord || !layerRecord.props) {
        console.warn("Missing layer record:", nodeId);
        return 0;
      }
      let nodeProps = applyManifestLayoutToProps(layerRecord.props, layerRecord);
      if (shouldRestoreBooleanOperationTree(nodeProps, layerRecord)) {
        return yield restoreBooleanOperationTree(
          nodeProps,
          parent,
          layerRecord,
          layers,
          restoredBefore,
          totalNodes,
          restoreImportedNode,
          applyProperties,
          maybeReportRestoreProgress
        );
      }
      if (shouldRestoreGroupNode(nodeProps)) {
        return yield restoreGroupNode(
          nodeProps,
          parent,
          layerRecord,
          layers,
          restoredBefore,
          totalNodes,
          restoreImportedNode,
          applyProperties,
          maybeReportRestoreProgress
        );
      }
      if (shouldRestoreComponentSetNode(nodeProps)) {
        return yield restoreComponentSetNode(
          nodeProps,
          parent,
          layerRecord,
          layers,
          restoredBefore,
          totalNodes,
          restoreImportedNode,
          applyProperties,
          maybeReportRestoreProgress
        );
      }
      if (shouldRestoreBooleanVectorAsFrame(nodeProps, layerRecord)) {
        nodeProps = createBooleanFrameFallbackProps(nodeProps);
      }
      nodeProps = prepareConnectorPolylineFallbackProps(nodeProps, parent);
      if (shouldPreserveVectorLayoutBoxForAutoLayout(nodeProps, parent)) {
        nodeProps = markVectorAutoLayoutBox(nodeProps);
      }
      const newNode = yield createNodeFromData(nodeProps);
      if (!newNode) return 0;
      try {
        if (!appendRestoredNode(parent, newNode)) return 0;
        yield applyProperties(newNode, nodeProps);
      } catch (error) {
        console.warn("Unable to restore node, removing partial node:", (nodeProps == null ? void 0 : nodeProps.name) || layerRecord.name || nodeId, error);
        safeRemove(newNode);
        return 0;
      }
      let restoredCount = 1;
      const currentCount = restoredBefore + restoredCount;
      yield maybeReportRestoreProgress(currentCount, totalNodes, "\u6B63\u5728\u8FD8\u539F\uFF1A" + (nodeProps.name || layerRecord.name));
      const childIds = nodeProps.omitChildrenOnRestore ? [] : layerRecord.childIds || [];
      if (canContainRestoredChildren(newNode)) {
        for (const childId of childIds) {
          restoredCount += yield restoreImportedNode(childId, newNode, layers, restoredBefore + restoredCount, totalNodes);
        }
      }
      return restoredCount;
    });
  }
  function canContainRestoredChildren(node) {
    return !!node && "appendChild" in node;
  }
})();
