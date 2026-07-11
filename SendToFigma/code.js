"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defProps = Object.defineProperties;
  var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __pow = Math.pow;
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
  function describeError(error) {
    if (!error) return "Unknown error";
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack ? error.stack.split("\n").slice(0, 5).join("\n") : void 0
      };
    }
    if (typeof error === "object") {
      try {
        return JSON.parse(JSON.stringify(error));
      } catch (_) {
        return String(error);
      }
    }
    return String(error);
  }
  function finiteNumber(value, fallback = 0) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallback;
  }
  function safeRead(reader, fallback) {
    try {
      const value = reader();
      return value !== void 0 ? value : fallback;
    } catch (_) {
      return fallback;
    }
  }
  function yieldToEventLoop() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  function isOutOfMemoryError(error) {
    if (!error) return false;
    const msg = String(error.message || error || "").toLowerCase();
    return msg.includes("out of memory") || msg.includes("oom") || msg.includes("allocation failed");
  }
  function cloneJsonCompatible(value, fallback) {
    if (value === void 0 || value === null) return fallback;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return fallback;
    }
  }

  // src/state.ts
  var SendToFigmaState = class {
    constructor() {
      this.totalNodes = 0;
      this.processedNodes = 0;
      this.loadingNotify = null;
      // NotificationHandler
      this.lastNotifyAt = 0;
      this.exportInProgress = false;
      this.cachedLayerRules = null;
      this.layerRulesBySourceType = null;
      this.layerRulesLoadPromise = null;
      this.activeImageAssetContext = null;
      this.exportTransferAckResolvers = {};
      this.exportFileAckResolvers = {};
      this.exportDebugState = { phase: "idle" };
      this.activeExportStats = null;
      this.activeExportProgress = null;
    }
    logDiagnostic(level, message, payload) {
      if (level === "error") {
        console.error(message, payload);
      } else if (level === "warn") {
        console.warn(message, payload);
      }
    }
    setExportDebugState(nextState) {
      this.exportDebugState.phase = nextState.phase;
      this.exportDebugState.page = nextState.page;
      this.exportDebugState.node = nextState.node;
      this.exportDebugState.nodeComplexity = nextState.nodeComplexity;
      this.exportDebugState.parentId = nextState.parentId;
      this.exportDebugState.nodeIndex = nextState.nodeIndex;
      this.exportDebugState.file = nextState.file;
      this.exportDebugState.transferId = nextState.transferId;
      this.exportDebugState.fileIndex = nextState.fileIndex;
      this.exportDebugState.chunkIndex = nextState.chunkIndex;
      this.exportDebugState.fileSize = nextState.fileSize;
      this.exportDebugState.streamedBytes = nextState.streamedBytes;
      this.exportDebugState.processedNodes = this.processedNodes;
      this.exportDebugState.totalNodes = this.totalNodes;
    }
    resetExportStats(options, pageCount, rootCount) {
      this.totalNodes = 0;
      this.processedNodes = 0;
      this.activeExportStats = {
        startedAt: Date.now(),
        scope: options.scope,
        transferMode: options.transferMode,
        pageCount,
        rootCount,
        totalNodes: 0,
        processedNodes: 0,
        scanMs: 0,
        exportMs: 0,
        assetMs: 0,
        manifestMs: 0,
        ackMs: 0,
        files: 0,
        chunks: 0,
        bytes: 0,
        layerChunkFiles: 0,
        layerRecords: 0,
        splitPackages: 0,
        imageAssets: 0,
        missingImageAssets: 0,
        progressPosts: 0,
        progressYields: 0
      };
      this.activeExportProgress = {
        lastCurrent: 0,
        lastPostedAt: Date.now()
      };
    }
    timeExportPhase(phase, action) {
      return __async(this, null, function* () {
        const startedAt = Date.now();
        try {
          return yield action();
        } finally {
          if (this.activeExportStats) {
            this.activeExportStats[phase] += Date.now() - startedAt;
          }
        }
      });
    }
    noteExportFileTransfer(file, size, totalChunks) {
      if (!this.activeExportStats) return;
      this.activeExportStats.files++;
      this.activeExportStats.chunks += totalChunks;
      this.activeExportStats.bytes += size;
      if (file.path.indexOf("/layers/layers-") !== -1) {
        this.activeExportStats.layerChunkFiles++;
      }
    }
    noteExportLayerRecord() {
      if (this.activeExportStats) this.activeExportStats.layerRecords++;
    }
    noteExportSplitPackage() {
      if (this.activeExportStats) this.activeExportStats.splitPackages++;
    }
    updateExportStatsFromManifest(manifest) {
      if (!this.activeExportStats) return;
      this.activeExportStats.totalNodes = this.totalNodes > 0 ? this.totalNodes : this.processedNodes;
      this.activeExportStats.processedNodes = this.processedNodes;
      if (manifest) {
        this.activeExportStats.imageAssets = manifest.stats.imageAssetCount;
        this.activeExportStats.missingImageAssets = manifest.stats.missingImageAssetCount;
      }
    }
    logExportPerformanceSummary(label, manifest) {
      if (!this.activeExportStats) return;
      this.updateExportStatsFromManifest(manifest);
    }
    postUI(message) {
      try {
        mg.ui.postMessage(message);
      } catch (error) {
        console.warn("Unable to post message to SendToFigma UI:", error);
      }
    }
    postProgressUI(message) {
      this.postUI(message);
    }
    maybeReportExportProgress(current, total, label, force = false) {
      return __async(this, null, function* () {
        const now = Date.now();
        const state2 = this.activeExportProgress || {
          lastCurrent: 0,
          lastPostedAt: 0
        };
        const shouldPost = force || current >= total || current - state2.lastCurrent >= 100 || // EXPORT_PROGRESS_EVERY_LAYERS
        now - state2.lastPostedAt >= 200;
        if (!shouldPost) return;
        this.postProgressUI({
          type: "progress",
          phase: "exporting",
          current,
          total,
          label
        });
        state2.lastCurrent = current;
        state2.lastPostedAt = now;
        this.activeExportProgress = state2;
        if (this.activeExportStats) {
          this.activeExportStats.progressPosts++;
          this.activeExportStats.progressYields++;
        }
        yield yieldToEventLoop();
      });
    }
  };
  var state = new SendToFigmaState();

  // ../shared/layerRulesConfig.ts
  var LAYER_RULES_SCHEMA = "mastergo2figma.layer-conversion-rules.v1";
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
  function createLayerRuleIndex(config) {
    const result = {};
    for (const sourceType in config.rules) {
      if (Object.prototype.hasOwnProperty.call(config.rules, sourceType)) {
        result[sourceType] = config.rules[sourceType];
      }
    }
    return result;
  }
  function initializeRules() {
    state.cachedLayerRules = {
      config: DEFAULT_LAYER_CONVERSION_CONFIG,
      fileName: "\u5185\u7F6E\u8F6C\u6362\u89C4\u5219",
      importedAt: ""
    };
    state.layerRulesBySourceType = createLayerRuleIndex(DEFAULT_LAYER_CONVERSION_CONFIG);
  }
  function startLayerRulesLoad() {
    if (!state.layerRulesLoadPromise) {
      state.layerRulesLoadPromise = (() => __async(null, null, function* () {
        initializeRules();
      }))();
    }
    return state.layerRulesLoadPromise;
  }
  function ensureLayerRulesLoaded() {
    return __async(this, null, function* () {
      yield startLayerRulesLoad();
    });
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
  function getLayerRule(sourceType) {
    if (!sourceType || !state.layerRulesBySourceType) return null;
    return state.layerRulesBySourceType[sourceType] || null;
  }
  function getRuleRestoreType(sourceType) {
    const rule = getLayerRule(sourceType);
    return rule ? rule.restoreType : sourceType;
  }
  function getRestoreType(sourceType) {
    return getRuleRestoreType(sourceType);
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
  function createConnectorVectorNetwork(start, end, startEndpoint, endEndpoint, lineType, cornerRadius, startStrokeCap, endStrokeCap) {
    const points = createConnectorRoutePoints(start, end, startEndpoint, endEndpoint, lineType);
    const vertices = points.map((point, index) => {
      const vertex = { x: point.x, y: point.y };
      if (index === 0) vertex.strokeCap = normalizeConnectorVectorStrokeCap(startStrokeCap);
      if (index === points.length - 1) vertex.strokeCap = normalizeConnectorVectorStrokeCap(endStrokeCap);
      if (index > 0 && index < points.length - 1) {
        const radius = getConnectorCornerRadius(points, index, cornerRadius);
        if (radius > 0) vertex.cornerRadius = radius;
      }
      return vertex;
    });
    const segments = [];
    for (let index = 0; index < points.length - 1; index++) {
      segments.push({
        start: index,
        end: index + 1,
        tangentStart: { x: 0, y: 0 },
        tangentEnd: { x: 0, y: 0 }
      });
    }
    return { vertices, segments, regions: [] };
  }

  // src/imageExporter.ts
  function padNumber(value) {
    const text = String(value);
    if (text.length >= 3) return text;
    return "000".slice(0, 3 - text.length) + text;
  }
  function normalizeImageScaleModeForFigma(value) {
    if (value === "FILL" || value === "FIT" || value === "CROP" || value === "TILE") return value;
    if (value === "STRETCH") return "FILL";
    if (value === "CENTER") return "FIT";
    return "FILL";
  }
  function registerImageAsset(sourceRef) {
    const context = state.activeImageAssetContext;
    const existing = context.bySourceRef[sourceRef];
    if (existing) return existing;
    const index = context.assets.length + 1;
    const key = `image-${padNumber(index)}`;
    const fileName = `${key}.bin`;
    const asset = {
      key,
      sourceRef,
      index,
      fileName,
      path: `assets/${fileName}`,
      bytes: null,
      missing: false
    };
    context.bySourceRef[sourceRef] = asset;
    context.assets.push(asset);
    return asset;
  }
  function markMissingImageFill(fill, fileName, shouldCount = true) {
    fill.imageRef = fileName;
    fill.missingAsset = true;
    if (shouldCount && state.activeImageAssetContext) {
      state.activeImageAssetContext.missingImageAssetCount++;
    }
  }
  function createImageFillJson(fill) {
    var _a, _b;
    const result = {
      "blendMode": processBlendMode(fill.blendMode),
      "opacity": (_a = fill.alpha) != null ? _a : 1,
      "type": "IMAGE",
      "scaleMode": normalizeImageScaleModeForFigma(fill.scaleMode),
      "visible": (_b = fill.isVisible) != null ? _b : true
    };
    if (fill.filters) result.filters = fill.filters;
    if (fill.rotation !== void 0) result.rotation = finiteNumber(fill.rotation, 0);
    if (fill.ratio !== void 0) result.ratio = finiteNumber(fill.ratio, 1);
    const sourceRef = typeof fill.imageRef === "string" ? fill.imageRef : "";
    if (!sourceRef || !state.activeImageAssetContext) {
      markMissingImageFill(result, "missing-image");
      return result;
    }
    const asset = registerImageAsset(sourceRef);
    result.imageRef = asset.key;
    return result;
  }
  function detectImageExtension(bytes) {
    if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) {
      return "png";
    }
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpg";
    if (bytes.length >= 3 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70) return "gif";
    if (bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 71 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) {
      return "webp";
    }
    return "bin";
  }
  function markImageAssetMissing(asset, context, reason, error) {
    asset.missing = true;
    asset.bytes = null;
    asset.fileName = `missing-image-${padNumber(asset.index)}.png`;
    asset.path = `assets/${asset.fileName}`;
    context.missingImageAssetCount++;
    state.logDiagnostic("warn", "[MasterGo2Figma] Unable to export image asset", {
      reason,
      sourceRef: asset.sourceRef,
      assetKey: asset.key,
      error: describeError(error),
      debugState: state.exportDebugState
    });
  }
  function loadAndStreamImageAsset(asset, context, transfer) {
    return __async(this, null, function* () {
      let bytes = null;
      try {
        state.setExportDebugState({
          phase: "asset:get-image",
          file: asset.path,
          transferId: transfer.transferId,
          fileIndex: transfer.fileIndex,
          streamedBytes: transfer.streamedBytes
        });
        const image = mg.getImageByHref(asset.sourceRef);
        if (!image || typeof image.getBytesAsync !== "function") throw new Error("\u56FE\u7247\u8D44\u6E90\u4E0D\u53EF\u8BFB\u53D6");
        state.setExportDebugState({
          phase: "asset:get-bytes",
          file: asset.path,
          transferId: transfer.transferId,
          fileIndex: transfer.fileIndex,
          streamedBytes: transfer.streamedBytes
        });
        bytes = yield image.getBytesAsync();
        if (!bytes || bytes.length === 0) throw new Error("\u56FE\u7247\u8D44\u6E90\u4E3A\u7A7A");
      } catch (error) {
        markImageAssetMissing(asset, context, "read", error);
        return;
      }
      const extension = detectImageExtension(bytes);
      asset.bytes = bytes;
      asset.fileName = `image-${padNumber(asset.index)}.${extension}`;
      asset.path = `assets/${asset.fileName}`;
      try {
        yield streamExportFileToUI(transfer, {
          path: asset.path,
          bytes
        });
      } catch (error) {
        asset.bytes = null;
        state.logDiagnostic("error", "[MasterGo2Figma] Unable to transfer image asset", {
          sourceRef: asset.sourceRef,
          assetKey: asset.key,
          path: asset.path,
          error: describeError(error),
          debugState: state.exportDebugState
        });
        throw error;
      }
    });
  }

  // src/serializers/universal.ts
  function readNodeProperty(node, property, fallback) {
    try {
      const value = node ? node[property] : void 0;
      return value === void 0 || value === null ? fallback : value;
    } catch (error) {
      if (isOutOfMemoryError(error)) {
        state.logDiagnostic("error", "[MasterGo2Figma] Node property read OOM", {
          property,
          node: getNodeProbe(node),
          error: describeError(error),
          debugState: state.exportDebugState
        });
      }
      return fallback;
    }
  }
  function getNodeProbe(node) {
    if (!node) return { id: "", name: "", type: "NULL" };
    return {
      id: String(node.id || ""),
      name: String(node.name || "Untitled"),
      type: String(node.type || "UNKNOWN")
    };
  }
  function clamp01(value, fallback = 0) {
    const numberValue = finiteNumber(value, fallback);
    if (numberValue < 0) return 0;
    if (numberValue > 1) return 1;
    return numberValue;
  }
  function cloneRgbColor(color) {
    return {
      r: finiteNumber(color && color.r, 0),
      g: finiteNumber(color && color.g, 0),
      b: finiteNumber(color && color.b, 0)
    };
  }
  function cloneRgbaColor(color) {
    return {
      r: finiteNumber(color && color.r, 0),
      g: finiteNumber(color && color.g, 0),
      b: finiteNumber(color && color.b, 0),
      a: clamp01(color && color.a, 1)
    };
  }
  function cloneVector2(point) {
    return {
      x: finiteNumber(point && point.x, 0),
      y: finiteNumber(point && point.y, 0)
    };
  }
  function cloneGradientStops(stops) {
    if (!Array.isArray(stops)) return [];
    return stops.map((stop) => ({
      position: clamp01(stop && stop.position, 0),
      color: cloneRgbaColor(stop && stop.color)
    }));
  }
  function matrixMultiplication(m1, m2) {
    let res = [];
    for (let i = 0; i < m1.length; i++) {
      res[i] = [];
      for (let j = 0; j < m2[0].length; j++) {
        let sum = 0;
        for (let k = 0; k < m2.length; k++) {
          sum += m1[i][k] * m2[k][j];
        }
        res[i][j] = sum;
      }
    }
    return res;
  }
  function getResultArrayByTwoPoint(points) {
    if (points === void 0 || points.length < 2) {
      return [[1, 0, 0], [0, 1, 0]];
    }
    const first = cloneVector2(points[0]);
    const second = cloneVector2(points[1]);
    const x3 = first.x, y3 = first.y, x4 = second.x, y4 = second.y;
    const m1 = [[1, 0, 0], [0, 1, 0.5], [0, 0, 1]];
    const len = Math.sqrt(__pow(x4 - x3, 2) + __pow(y4 - y3, 2));
    if (!Number.isFinite(len) || len <= 0) return [[1, 0, 0], [0, 1, 0]];
    const m2 = [[1 / len, 0, 0], [0, 1, 0], [0, 0, 1]];
    const sina = (y3 - y4) / len, cosa = (x4 - x3) / len;
    const m3 = [[cosa, -sina, 0], [sina, cosa, 0], [0, 0, 1]];
    const m4 = [[1, 0, -x3], [0, 1, -y3], [0, 0, 1]];
    const m12 = matrixMultiplication(m2, m1);
    const m123 = matrixMultiplication(m12, m3);
    const m1234 = matrixMultiplication(m123, m4);
    return [m1234[0], m1234[1]];
  }
  function getResultArrayByThreePoints(points) {
    if (points === void 0 || points.length < 2) {
      return [[0, 1, 0], [-1, 0, 1]];
    }
    const p0 = cloneVector2(points[0]);
    const p1 = cloneVector2(points[1]);
    const ux = p1.x - p0.x, uy = p1.y - p0.y;
    const p2 = points.length >= 3 ? cloneVector2(points[2]) : { x: p0.x - uy, y: p0.y + ux };
    const vx = p2.x - p0.x, vy = p2.y - p0.y;
    const det = ux * vy - vx * uy;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-9) {
      return [[0, 1, 0], [-1, 0, 1]];
    }
    const inv = 0.5 / det;
    const a00 = vy * inv, a01 = -vx * inv;
    const a10 = -uy * inv, a11 = ux * inv;
    const t0 = 0.5 - (a00 * p0.x + a01 * p0.y);
    const t1 = 0.5 - (a10 * p0.x + a11 * p0.y);
    const nz = (n) => n === 0 ? 0 : n;
    return [[nz(a00), nz(a01), nz(t0)], [nz(a10), nz(a11), nz(t1)]];
  }
  function isFiniteTransform(t) {
    return Array.isArray(t) && t.length >= 2 && Array.isArray(t[0]) && t[0].length >= 3 && Array.isArray(t[1]) && t[1].length >= 3 && Number.isFinite(t[0][0]) && Number.isFinite(t[0][1]) && Number.isFinite(t[0][2]) && Number.isFinite(t[1][0]) && Number.isFinite(t[1][1]) && Number.isFinite(t[1][2]);
  }
  function applyAffine(m, p) {
    return {
      x: m[0][0] * p.x + m[0][1] * p.y + m[0][2],
      y: m[1][0] * p.x + m[1][1] * p.y + m[1][2]
    };
  }
  function invertAffine(m) {
    const a = m[0][0], b = m[0][1], e = m[0][2];
    const c = m[1][0], d = m[1][1], f = m[1][2];
    const det = a * d - b * c;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
    const ia = d / det, ib = -b / det;
    const ic = -c / det, id = a / det;
    return [[ia, ib, -(ia * e + ib * f)], [ic, id, -(ic * e + id * f)]];
  }
  function recoverMinorAxisEnd(p0, p1, m) {
    const mi = invertAffine(m);
    if (!mi) return null;
    const qc = applyAffine(m, p0);
    const q1 = applyAffine(m, p1);
    const dx = q1.x - qc.x, dy = q1.y - qc.y;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || dx === 0 && dy === 0) return null;
    const perp = { x: qc.x - dy, y: qc.y + dx };
    const end = applyAffine(mi, perp);
    if (!Number.isFinite(end.x) || !Number.isFinite(end.y)) return null;
    return end;
  }
  function resolveGradientTransform(paint) {
    const points = paint && paint.gradientHandlePositions || [];
    if (paint && paint.type === "GRADIENT_LINEAR") {
      return getResultArrayByTwoPoint(points);
    }
    if (points.length >= 3) {
      return getResultArrayByThreePoints(points);
    }
    if (points.length >= 2 && isFiniteTransform(paint && paint.transform)) {
      const p0 = cloneVector2(points[0]);
      const p1 = cloneVector2(points[1]);
      const minorEnd = recoverMinorAxisEnd(p0, p1, paint.transform);
      if (minorEnd) {
        return getResultArrayByThreePoints([p0, p1, minorEnd]);
      }
    }
    return getResultArrayByThreePoints(points);
  }
  function processBlendMode(blendMode) {
    if (!blendMode) return "NORMAL";
    const value = String(blendMode).toUpperCase();
    if (value === "PASS_THROUGH") return "PASS_THROUGH";
    if (value === "NORMAL") return "NORMAL";
    if (value === "DARKEN") return "DARKEN";
    if (value === "MULTIPLY") return "MULTIPLY";
    if (value === "COLOR_BURN") return "COLOR_BURN";
    if (value === "LIGHTEN") return "LIGHTEN";
    if (value === "SCREEN") return "SCREEN";
    if (value === "COLOR_DODGE") return "COLOR_DODGE";
    if (value === "OVERLAY") return "OVERLAY";
    if (value === "SOFT_LIGHT") return "SOFT_LIGHT";
    if (value === "HARD_LIGHT") return "HARD_LIGHT";
    if (value === "DIFFERENCE") return "DIFFERENCE";
    if (value === "EXCLUSION") return "EXCLUSION";
    if (value === "HUE") return "HUE";
    if (value === "SATURATION") return "SATURATION";
    if (value === "COLOR") return "COLOR";
    if (value === "LUMINOSITY") return "LUMINOSITY";
    if (value === "PLUS_DARKER") return "PLUS_DARKER";
    if (value === "PLUS_LIGHTER") return "PLUS_LIGHTER";
    return "NORMAL";
  }
  function fillsAndStrokes2Json(fills, strokes) {
    const resultFills = [];
    if (Array.isArray(fills)) {
      for (const fill of fills) {
        let tempResultFill = {};
        if (fill.type === "SOLID") {
          tempResultFill = {
            "type": fill.type,
            "visible": fill.isVisible,
            "opacity": clamp01(fill.color && fill.color.a, 1),
            "blendMode": processBlendMode(fill.blendMode),
            "color": cloneRgbColor(fill.color)
          };
        } else if (fill.type === "GRADIENT_LINEAR") {
          tempResultFill = {
            "type": fill.type,
            "visible": fill.isVisible,
            "opacity": clamp01(fill.alpha, 1),
            "blendMode": processBlendMode(fill.blendMode),
            "gradientStops": cloneGradientStops(fill.gradientStops),
            "gradientTransform": resolveGradientTransform(fill)
          };
        } else if (fill.type === "GRADIENT_RADIAL" || fill.type === "GRADIENT_ANGULAR" || fill.type === "GRADIENT_DIAMOND") {
          tempResultFill = {
            "type": fill.type,
            "visible": fill.isVisible,
            "opacity": clamp01(fill.alpha, 1),
            "blendMode": processBlendMode(fill.blendMode),
            "gradientStops": cloneGradientStops(fill.gradientStops),
            "gradientTransform": resolveGradientTransform(fill)
          };
        } else if (fill.type === "IMAGE") {
          tempResultFill = createImageFillJson(fill);
        }
        if (tempResultFill.type) resultFills.push(tempResultFill);
      }
    }
    const resultStrokes = [];
    if (Array.isArray(strokes)) {
      for (const stroke of strokes) {
        let tempResultStroke = {};
        if (stroke.type === "SOLID") {
          tempResultStroke = {
            "type": stroke.type,
            "visible": stroke.isVisible,
            "opacity": clamp01(stroke.color && stroke.color.a, 1),
            "blendMode": processBlendMode(stroke.blendMode),
            "color": cloneRgbColor(stroke.color)
          };
        } else if (stroke.type === "GRADIENT_LINEAR") {
          tempResultStroke = {
            "type": stroke.type,
            "visible": stroke.isVisible,
            "opacity": clamp01(stroke.alpha, 1),
            "blendMode": processBlendMode(stroke.blendMode),
            "gradientStops": cloneGradientStops(stroke.gradientStops),
            "gradientTransform": resolveGradientTransform(stroke)
          };
        } else if (stroke.type === "GRADIENT_RADIAL" || stroke.type === "GRADIENT_ANGULAR" || stroke.type === "GRADIENT_DIAMOND") {
          tempResultStroke = {
            "type": stroke.type,
            "visible": stroke.isVisible,
            "opacity": clamp01(stroke.alpha, 1),
            "blendMode": processBlendMode(stroke.blendMode),
            "gradientStops": cloneGradientStops(stroke.gradientStops),
            "gradientTransform": resolveGradientTransform(stroke)
          };
        } else if (stroke.type === "IMAGE") {
          tempResultStroke = createImageFillJson(stroke);
        }
        if (tempResultStroke.type) resultStrokes.push(tempResultStroke);
      }
    }
    return { fills: resultFills, strokes: resultStrokes };
  }
  function getLayoutMode(node) {
    const mode = readNodeProperty(node, "layoutMode", "NONE");
    if (mode === "HORIZONTAL" || mode === "VERTICAL") return mode;
    const flexMode = readAutoLayoutProperty(node, "flexMode", "NONE");
    if (flexMode === "HORIZONTAL" || flexMode === "VERTICAL") return flexMode;
    const direction = readAutoLayoutProperty(node, "direction", "NONE");
    if (direction === "ROW") return "HORIZONTAL";
    if (direction === "COLUMN") return "VERTICAL";
    return "NONE";
  }
  function getAxisAlign(value) {
    if (value === "MIN" || value === "CENTER" || value === "MAX" || value === "SPACE_BETWEEN") return value;
    if (value === "START" || value === "FLEX_START") return "MIN";
    if (value === "END" || value === "FLEX_END") return "MAX";
    if (value === "SPACING_BETWEEN") return "SPACE_BETWEEN";
    return "MIN";
  }
  function getCounterAxisAlignContent(node) {
    const value = readNodeProperty(node, "counterAxisAlignContent", readAutoLayoutProperty(node, "crossAxisAlignContent", "AUTO"));
    if (value === "AUTO" || value === "SPACE_BETWEEN") return value;
    return "AUTO";
  }
  function getLayoutAlign(value) {
    if (value === "INHERIT" || value === "MIN" || value === "CENTER" || value === "MAX" || value === "STRETCH") return value;
    if (value === "AUTO") return "INHERIT";
    if (value === "START" || value === "FLEX_START") return "MIN";
    if (value === "END" || value === "FLEX_END") return "MAX";
    return "INHERIT";
  }
  function readAutoLayoutProperty(node, property, fallback) {
    const direct = readNodeProperty(node, property, void 0);
    if (direct !== void 0 && direct !== null) return direct;
    const autoLayout = readNodeProperty(node, "autoLayout", null);
    if (autoLayout && autoLayout[property] !== void 0 && autoLayout[property] !== null) return autoLayout[property];
    const layout = readNodeProperty(node, "layout", null);
    const layoutAuto = layout && layout.autoLayout;
    if (layoutAuto && layoutAuto[property] !== void 0 && layoutAuto[property] !== null) return layoutAuto[property];
    return fallback;
  }
  function readAutoLayoutNumber(node, property, fallback = 0) {
    const value = readAutoLayoutProperty(node, property, fallback);
    if (typeof value === "number") return value;
    if (value && typeof value === "object") {
      if (typeof value.value === "number") return value.value;
      if (typeof value.rawValue === "number") return value.rawValue;
    }
    return finiteNumber(value, fallback);
  }
  function getPrimaryAxisSizingMode(node) {
    return readNodeProperty(
      node,
      "primaryAxisSizingMode",
      readNodeProperty(
        node,
        "mainAxisSizingMode",
        readAutoLayoutProperty(node, "mainAxisSizingMode", "FIXED")
      )
    );
  }
  function getCounterAxisSizingMode(node) {
    return readNodeProperty(
      node,
      "counterAxisSizingMode",
      readNodeProperty(
        node,
        "crossAxisSizingMode",
        readAutoLayoutProperty(node, "crossAxisSizingMode", "FIXED")
      )
    );
  }
  function getRelativeLayoutTransform(selection) {
    return cloneTransform(readNodeProperty(selection, "relativeTransform", [[1, 0, 0], [0, 1, 0]]));
  }
  function getUniversalProperty(selection, sourceType, restoreType) {
    const resolvedSourceType = sourceType || readNodeProperty(selection, "type", "UNKNOWN");
    const resolvedRestoreType = restoreType || getRestoreType(resolvedSourceType);
    const layoutTransform = getRelativeLayoutTransform(selection);
    const fills = readNodeProperty(selection, "fills", []);
    const strokes = readNodeProperty(selection, "strokes", []);
    const tFS = fillsAndStrokes2Json(fills, strokes);
    const fourCR = {
      tl: readNodeProperty(selection, "topLeftRadius", 0) || 0,
      tr: readNodeProperty(selection, "topRightRadius", 0) || 0,
      bl: readNodeProperty(selection, "bottomLeftRadius", 0) || 0,
      br: readNodeProperty(selection, "bottomRightRadius", 0) || 0
    };
    let resCR = readNodeProperty(selection, "cornerRadius", 0) || 0;
    if (String(resCR) === "Symbol(mg.mixed)") resCR = -1;
    const resCS = readNodeProperty(selection, "cornerSmooth", 0) || 0;
    const effectsArray = [];
    const effects = readNodeProperty(selection, "effects", []);
    for (const tE of effects) {
      if (tE.type === "DROP_SHADOW" || tE.type === "INNER_SHADOW") {
        effectsArray.push({
          "type": tE.type,
          "color": cloneRgbaColor(tE.color),
          "offset": cloneVector2(tE.offset),
          "radius": finiteNumber(tE.radius, 0),
          "spread": finiteNumber(tE.spread, 0),
          "visible": tE.isVisible,
          "blendMode": processBlendMode(tE.blendMode)
        });
      } else if (tE.type === "LAYER_BLUR" || tE.type === "BACKGROUND_BLUR") {
        effectsArray.push({
          "type": tE.type,
          "radius": finiteNumber(tE.radius, 0),
          "visible": tE.isVisible
        });
      }
    }
    return {
      "type": resolvedRestoreType,
      "sourceType": resolvedSourceType,
      "restoreType": resolvedRestoreType,
      "id": readNodeProperty(selection, "id", ""),
      "name": readNodeProperty(selection, "name", "Untitled"),
      "parentID": safeRead(() => {
        var _a;
        return selection.parent && selection.parent.type === "PAGE" ? null : (_a = selection.parent) == null ? void 0 : _a.id;
      }, null),
      "constraints": cloneJsonCompatible(readNodeProperty(selection, "constraints", void 0), void 0),
      "exportSettings": cloneJsonCompatible(readNodeProperty(selection, "exportSettings", []), []),
      // NOTE: "scence" is a historical typo in the schema that cannot be changed to maintain backwards compatibility
      "scence": {
        "visible": readNodeProperty(selection, "isVisible", true),
        "locked": readNodeProperty(selection, "isLocked", false)
      },
      "blend": {
        "opacity": readNodeProperty(selection, "opacity", 1),
        "isMask": readNodeProperty(selection, "isMask", false) || false,
        "blendMode": processBlendMode(readNodeProperty(selection, "blendMode", "NORMAL")),
        "effects": effectsArray
      },
      "corner": {
        "topLeftRadius": fourCR.tl,
        "topRightRadius": fourCR.tr,
        "bottomLeftRadius": fourCR.bl,
        "bottomRightRadius": fourCR.br,
        "cornerRadius": resCR,
        "cornerSmoothing": resCS
      },
      "geometry": {
        "fills": tFS.fills,
        "strokes": tFS.strokes,
        "strokeWeight": readNodeProperty(selection, "strokeWeight", 0) || 0,
        "strokeAlign": readNodeProperty(selection, "strokeAlign", "CENTER"),
        "strokeJoin": readNodeProperty(selection, "strokeJoin", "MITER"),
        "dashPattern": cloneJsonCompatible(readNodeProperty(selection, "strokeDashes", []), []),
        "strokeCap": normalizeMasterGoStrokeCapForFigma(readNodeProperty(selection, "strokeCap", "NONE")),
        "strokeTopWeight": selection.strokeTopWeight !== void 0 ? readNodeProperty(selection, "strokeTopWeight", 0) : void 0,
        "strokeBottomWeight": selection.strokeBottomWeight !== void 0 ? readNodeProperty(selection, "strokeBottomWeight", 0) : void 0,
        "strokeLeftWeight": selection.strokeLeftWeight !== void 0 ? readNodeProperty(selection, "strokeLeftWeight", 0) : void 0,
        "strokeRightWeight": selection.strokeRightWeight !== void 0 ? readNodeProperty(selection, "strokeRightWeight", 0) : void 0
      },
      "layout": {
        "relativeTransform": layoutTransform,
        "x": layoutTransform[0][2],
        "y": layoutTransform[1][2],
        "rotation": -readNodeProperty(selection, "rotation", 0) || 0,
        "width": readNodeProperty(selection, "width", 0),
        "height": readNodeProperty(selection, "height", 0),
        "constrainProportions": readNodeProperty(selection, "constrainProportions", false) || false,
        "layoutMode": getLayoutMode(selection),
        "itemSpacing": readAutoLayoutNumber(selection, "itemSpacing", 0),
        "paddingLeft": readAutoLayoutNumber(selection, "paddingLeft", 0),
        "paddingRight": readAutoLayoutNumber(selection, "paddingRight", 0),
        "paddingTop": readAutoLayoutNumber(selection, "paddingTop", 0),
        "paddingBottom": readAutoLayoutNumber(selection, "paddingBottom", 0),
        "primaryAxisAlignItems": getAxisAlign(readNodeProperty(selection, "primaryAxisAlignItems", readAutoLayoutProperty(selection, "mainAxisAlignItems", "MIN"))),
        "counterAxisAlignItems": getAxisAlign(readNodeProperty(selection, "counterAxisAlignItems", readAutoLayoutProperty(selection, "crossAxisAlignItems", "MIN"))),
        "counterAxisAlignContent": getCounterAxisAlignContent(selection),
        "primaryAxisSizingMode": getPrimaryAxisSizingMode(selection),
        "counterAxisSizingMode": getCounterAxisSizingMode(selection),
        "itemReverseZIndex": readNodeProperty(selection, "itemReverseZIndex", readAutoLayoutProperty(selection, "itemReverseZIndex", false)) || false,
        "strokesIncludedInLayout": readNodeProperty(selection, "strokesIncludedInLayout", readAutoLayoutProperty(selection, "strokesIncludedInLayout", false)) || false,
        "layoutAlign": getLayoutAlign(readNodeProperty(selection, "layoutAlign", readNodeProperty(selection, "alignSelf", "INHERIT"))),
        "layoutGrow": readNodeProperty(selection, "layoutGrow", readNodeProperty(selection, "flexGrow", 0)),
        "layoutPositioning": readNodeProperty(selection, "layoutPositioning", "AUTO")
      }
    };
  }

  // ../shared/vectorUtils.ts
  function normalizeVectorWindingRule(value) {
    if (value === "Evenodd" || value === "EVENODD") return "EVENODD";
    if (value === "Nonzero" || value === "NONZERO") return "NONZERO";
    return "NONZERO";
  }
  function normalizeVectorWindingRuleForFigma(value) {
    return normalizeVectorWindingRule(value);
  }

  // src/serializers/vector.ts
  function normalizeVectorRegionLoops(loops) {
    if (!Array.isArray(loops)) return [];
    const result = [];
    for (const loop of loops) {
      if (!Array.isArray(loop)) continue;
      const segmentIndexes = loop.map((value) => Number(value)).filter((value) => Number.isFinite(value));
      if (segmentIndexes.length > 0) result.push(segmentIndexes);
    }
    return result;
  }
  function normalizeVectorRegions(regions) {
    if (!Array.isArray(regions)) return [];
    const result = [];
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
  function cloneVectorNetworkForExport(vectorNetwork) {
    if (!vectorNetwork || typeof vectorNetwork !== "object") return void 0;
    return {
      vertices: cloneJsonCompatible(vectorNetwork.vertices, []),
      segments: cloneJsonCompatible(vectorNetwork.segments, []),
      regions: normalizeVectorRegions(vectorNetwork.regions)
    };
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
  function applyUniformVectorStrokeCap(resultStruct, vectorNetwork) {
    const strokeCap = getUniformOpenVectorStrokeCap(vectorNetwork);
    if (!strokeCap || !resultStruct.geometry || resultStruct.geometry.strokeCap !== "NONE") return;
    resultStruct.geometry.strokeCap = strokeCap;
  }
  function transPenNode(selection, sourceType, restoreType) {
    const universalStruct = getUniversalProperty(selection, sourceType, restoreType);
    const originJson = selection.penNetwork;
    if (!originJson || !originJson.ctrlNodes || !originJson.nodes || !originJson.paths) {
      const vectorNetwork = cloneVectorNetworkForExport(selection.vectorNetwork);
      const resultStruct2 = Object.assign(vectorNetwork ? { vectorNetwork } : {}, universalStruct);
      resultStruct2.type = restoreType || getRuleRestoreType(sourceType || selection.type);
      applyUniformVectorStrokeCap(resultStruct2, vectorNetwork);
      return resultStruct2;
    }
    const originCtrlNodes = originJson.ctrlNodes;
    const originNodes = originJson.nodes;
    const originPaths = originJson.paths;
    const resultSegments = [];
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

  // src/serializers/shapes.ts
  function transEllipseNode(selection) {
    const universalStruct = getUniversalProperty(selection);
    const otherStruct = { "arcData": cloneJsonCompatible(selection.arcData, void 0) };
    return Object.assign(otherStruct, universalStruct);
  }
  function transStarNode(selection) {
    const universalStruct = getUniversalProperty(selection);
    const otherStruct = {
      "pointCount": selection.pointCount,
      "innerRadius": selection.innerRadius
    };
    return Object.assign(otherStruct, universalStruct);
  }
  function transPolygonNode(selection) {
    const universalStruct = getUniversalProperty(selection);
    const otherStruct = { "pointCount": selection.pointCount };
    return Object.assign(otherStruct, universalStruct);
  }

  // src/serializers/text.ts
  var FONT_STYLE_NAME_MAP = {
    "SemiBold": "Semi Bold",
    "ExtraBold": "Extra Bold",
    "ExtraLight": "Extra Light",
    "ExtraBlack": "Extra Black",
    "DemiBold": "Demi Bold",
    "UltraLight": "Ultra Light",
    "UltraBold": "Ultra Bold",
    "UltraBlack": "Ultra Black"
  };
  function normalizeExportFontName(fontName) {
    if (!fontName) return fontName;
    let { family, style } = fontName;
    if (family === "AlibabaPuHuiTi") family = "Alibaba PuHuiTi";
    if (style && FONT_STYLE_NAME_MAP[style]) style = FONT_STYLE_NAME_MAP[style];
    return family === fontName.family && style === fontName.style ? fontName : { family, style };
  }
  function parseTextStyleRange(entry, charLength) {
    if (!entry || typeof entry !== "object") return null;
    const range = entry.range && typeof entry.range === "object" ? entry.range : entry;
    let start;
    let end;
    if (typeof range.startIndex === "number" && typeof range.endIndex === "number") {
      start = range.startIndex;
      end = range.endIndex;
    } else if (typeof range.start === "number" && typeof range.end === "number") {
      start = range.start;
      end = range.end;
    } else if (typeof range.start === "number" && typeof range.length === "number") {
      start = range.start;
      end = range.start + range.length;
    }
    if (start === void 0 || end === void 0) return null;
    start = Math.max(0, Math.floor(start));
    end = Math.min(charLength, Math.floor(end));
    if (!(end > start)) return null;
    return { start, end };
  }
  function buildStyledTextSegment(entry, range) {
    const style = entry.textStyle || {};
    const segment = {
      start: range.start,
      end: range.end,
      fontName: normalizeExportFontName(cloneJsonCompatible(style.fontName, void 0)),
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      textCase: style.textCase,
      textDecoration: style.textDecoration,
      letterSpacing: cloneJsonCompatible(style.letterSpacing, style.letterSpacing),
      lineHeight: cloneJsonCompatible(style.lineHeight, style.lineHeight)
    };
    const runFills = Array.isArray(entry.fills) ? entry.fills : null;
    if (runFills && runFills.length > 0) {
      const normalized = runFills.map(
        (f) => f && f.blendMode === "PASS_THROUGH" ? __spreadProps(__spreadValues({}, f), { blendMode: "NORMAL" }) : f
      );
      const fills = fillsAndStrokes2Json(normalized, []).fills;
      if (fills.length > 0) segment.fills = fills;
    }
    return segment;
  }
  function buildStyledTextSegments(textStyles, charLength) {
    if (!Array.isArray(textStyles) || textStyles.length < 2 || charLength <= 0) return void 0;
    const segments = [];
    for (const entry of textStyles) {
      const range = parseTextStyleRange(entry, charLength);
      if (!range) continue;
      segments.push(buildStyledTextSegment(entry, range));
    }
    return segments.length > 0 ? segments : void 0;
  }
  function transTextNode(selection) {
    var _a, _b, _c;
    const universalStruct = getUniversalProperty(selection);
    const textStyles = readNodeProperty(selection, "textStyles", []);
    const tempFontName = normalizeExportFontName(cloneJsonCompatible((_b = (_a = textStyles == null ? void 0 : textStyles[0]) == null ? void 0 : _a.textStyle) == null ? void 0 : _b.fontName, void 0));
    const style = ((_c = textStyles == null ? void 0 : textStyles[0]) == null ? void 0 : _c.textStyle) || {};
    const characters = readNodeProperty(selection, "characters", "");
    const otherStruct = {
      "textAlignHorizontal": readNodeProperty(selection, "textAlignHorizontal", "LEFT"),
      "textAlignVertical": readNodeProperty(selection, "textAlignVertical", "TOP"),
      "textAutoResize": readNodeProperty(selection, "textAutoResize", "NONE"),
      "paragraphIndent": 0,
      "paragraphSpacing": readNodeProperty(selection, "paragraphSpacing", 0),
      "autoRename": false,
      "characters": characters,
      "fontSize": style.fontSize,
      "fontName": tempFontName,
      "fontWeight": style.fontWeight,
      "textCase": style.textCase,
      "textDecoration": style.textDecoration,
      "letterSpacing": cloneJsonCompatible(style.letterSpacing, style.letterSpacing),
      "lineHeight": cloneJsonCompatible(style.lineHeight, style.lineHeight)
    };
    const styledTextSegments = buildStyledTextSegments(textStyles, typeof characters === "string" ? characters.length : 0);
    if (styledTextSegments) otherStruct.styledTextSegments = styledTextSegments;
    return Object.assign(otherStruct, universalStruct);
  }

  // src/serializers/connector.ts
  function normalizeConnectorEndpoint(endpoint) {
    if (!endpoint || typeof endpoint !== "object") return void 0;
    const result = {};
    if (endpoint.position) {
      result.position = {
        x: Number(endpoint.position.x) || 0,
        y: Number(endpoint.position.y) || 0
      };
    }
    if (typeof endpoint.endpointNodeId === "string" && endpoint.endpointNodeId) {
      result.endpointNodeId = endpoint.endpointNodeId;
    }
    if (typeof endpoint.magnet === "string" && endpoint.magnet) {
      result.magnet = endpoint.magnet;
    }
    return result.position || result.endpointNodeId ? result : void 0;
  }
  function absolutePointToNodeLocal(node, point) {
    const transform = safeRead(() => node.absoluteTransform, null);
    if (!transform || !transform[0] || !transform[1]) return { x: Number(point.x) || 0, y: Number(point.y) || 0 };
    const a = Number(transform[0][0]) || 0;
    const c = Number(transform[0][1]) || 0;
    const e = Number(transform[0][2]) || 0;
    const b = Number(transform[1][0]) || 0;
    const d = Number(transform[1][1]) || 0;
    const f = Number(transform[1][2]) || 0;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-6) return { x: (Number(point.x) || 0) - e, y: (Number(point.y) || 0) - f };
    const dx = (Number(point.x) || 0) - e;
    const dy = (Number(point.y) || 0) - f;
    return {
      x: (d * dx - c * dy) / det,
      y: (-b * dx + a * dy) / det
    };
  }
  function connectorEndpointToLocalPoint(selection, endpoint, isStart) {
    const point = endpoint && endpoint.position ? endpoint.position : null;
    if (point) return absolutePointToNodeLocal(selection, point);
    const width = Number(safeRead(() => selection.width, 0)) || 0;
    const height = Number(safeRead(() => selection.height, 0)) || 0;
    return isStart ? { x: 0, y: 0 } : { x: width, y: height };
  }
  function transConnectorNode(selection) {
    const universalStruct = getUniversalProperty(selection, "CONNECTOR", "CONNECTOR");
    const connectorStart = normalizeConnectorEndpoint(selection.connectorStart);
    const connectorEnd = normalizeConnectorEndpoint(selection.connectorEnd);
    const connectorLineType = selection.connectorLineType || "ELBOWED";
    const connectorCornerRadius = selection.cornerRadius || 0;
    const connectorStartStrokeCap = selection.connectorStartStrokeCap || "NONE";
    const connectorEndStrokeCap = selection.connectorEndStrokeCap || "NONE";
    const otherStruct = {
      "connectorStart": connectorStart,
      "connectorEnd": connectorEnd,
      "connectorStartLocal": connectorEndpointToLocalPoint(selection, connectorStart, true),
      "connectorEndLocal": connectorEndpointToLocalPoint(selection, connectorEnd, false),
      "connectorStartStrokeCap": connectorStartStrokeCap,
      "connectorEndStrokeCap": connectorEndStrokeCap,
      "connectorLineType": connectorLineType,
      "connectorCornerRadius": connectorCornerRadius,
      "vectorNetwork": void 0
    };
    otherStruct.vectorNetwork = createConnectorVectorNetwork(
      otherStruct.connectorStartLocal,
      otherStruct.connectorEndLocal,
      connectorStart,
      connectorEnd,
      connectorLineType,
      connectorCornerRadius,
      connectorStartStrokeCap,
      connectorEndStrokeCap
    );
    return Object.assign(otherStruct, universalStruct);
  }

  // src/serializers/container.ts
  function transFrameNode(selection, sourceType) {
    const universalStruct = getUniversalProperty(selection, sourceType);
    const otherStruct = { "clipsContent": selection.clipsContent };
    return Object.assign(otherStruct, universalStruct);
  }
  function transGroupNode(selection) {
    const universalStruct = getUniversalProperty(selection, "GROUP", "GROUP");
    const otherStruct = { "clipsContent": false };
    return Object.assign(otherStruct, universalStruct);
  }
  function transBONode(node) {
    const json = transPenNode(node, "BOOLEAN_OPERATION", getRuleRestoreType("BOOLEAN_OPERATION"));
    json.booleanOperation = safeRead(() => node.booleanOperation, "UNION");
    return json;
  }
  function transBooleanTreeNode(node, restoreType) {
    const json = getUniversalProperty(node, "BOOLEAN_OPERATION", restoreType);
    json.booleanOperation = safeRead(() => node.booleanOperation, "UNION");
    return json;
  }

  // src/exportConfig.ts
  var EXPORT_TRANSFER_CHUNK_SIZE = 64 * 1024;
  var EXPORT_TEXT_CHUNK_CHAR_LIMIT = 16 * 1024;
  var EXPORT_TRANSFER_YIELD_EVERY_CHUNKS = 32;
  var EXPORT_FILE_YIELD_EVERY_FILES = 25;
  var EXPORT_ASSET_YIELD_EVERY_ASSETS = 8;
  var LAYER_CHUNK_MAX_RECORDS = 16;
  var LAYER_CHUNK_MAX_BYTES = 64 * 1024;
  var PAGE_SEGMENT_TARGET_LAYERS = 8e3;
  var EXPORT_SCAN_YIELD_EVERY_NODES = 500;
  var EXPORT_FILE_ACK_TIMEOUT_MS = 6e4;
  var EXPORT_TRANSFER_ACK_TIMEOUT_MS = 12e4;
  var SVG_FALLBACK_MAX_NODES = 48;
  var SVG_FALLBACK_MAX_AREA = 64 * 1024;
  var SVG_FALLBACK_MAX_DIMENSION = 256;
  var SVG_FALLBACK_MAX_BYTES = 64 * 1024;
  var SVG_FALLBACK_MAX_DOCUMENT_NODES = 5e3;
  var STRINGIFY_RECORD_WARN_BYTES = 48 * 1024;

  // src/nodeSerializer.ts
  function hasUsableVectorNetwork(vectorNetwork) {
    return !!(vectorNetwork && Array.isArray(vectorNetwork.vertices) && vectorNetwork.vertices.length > 0 && Array.isArray(vectorNetwork.segments));
  }
  function createFallbackNodeJson(node, sourceType) {
    const resolvedSourceType = sourceType || safeRead(() => node.type, "UNKNOWN");
    const restoreType = getRuleRestoreType(resolvedSourceType);
    const layoutTransform = safeRead(() => cloneTransform(node.relativeTransform), [[1, 0, 0], [0, 1, 0]]);
    return {
      type: restoreType,
      sourceType: resolvedSourceType,
      restoreType,
      id: safeRead(() => node.id, ""),
      name: safeRead(() => node.name, "Untitled"),
      parentID: safeRead(() => {
        var _a;
        return node.parent && node.parent.type === "PAGE" ? null : (_a = node.parent) == null ? void 0 : _a.id;
      }, null),
      constraints: cloneJsonCompatible(safeRead(() => node.constraints, void 0), void 0),
      exportSettings: [],
      scence: {
        visible: safeRead(() => node.isVisible, true),
        locked: safeRead(() => node.isLocked, false)
      },
      blend: {
        opacity: safeRead(() => node.opacity, 1),
        isMask: safeRead(() => node.isMask, false),
        blendMode: "NORMAL",
        effects: []
      },
      corner: {
        topLeftRadius: 0,
        topRightRadius: 0,
        bottomLeftRadius: 0,
        bottomRightRadius: 0,
        cornerRadius: 0,
        cornerSmoothing: 0
      },
      geometry: {
        fills: [],
        strokes: [],
        strokeWeight: 0,
        strokeAlign: "CENTER",
        strokeJoin: "MITER",
        dashPattern: [],
        strokeCap: "NONE",
        strokeTopWeight: void 0,
        strokeBottomWeight: void 0,
        strokeLeftWeight: void 0,
        strokeRightWeight: void 0
      },
      layout: {
        relativeTransform: layoutTransform,
        x: layoutTransform[0][2],
        y: layoutTransform[1][2],
        rotation: safeRead(() => -(node.rotation || 0), 0),
        width: safeRead(() => node.width, 0),
        height: safeRead(() => node.height, 0),
        constrainProportions: false,
        layoutMode: "NONE",
        itemSpacing: 0,
        paddingLeft: 0,
        paddingRight: 0,
        paddingTop: 0,
        paddingBottom: 0,
        primaryAxisAlignItems: "MIN",
        counterAxisAlignItems: "MIN",
        counterAxisAlignContent: "AUTO",
        primaryAxisSizingMode: "FIXED",
        counterAxisSizingMode: "FIXED",
        itemReverseZIndex: false,
        strokesIncludedInLayout: false,
        layoutAlign: "INHERIT",
        layoutGrow: 0,
        layoutPositioning: "AUTO"
      },
      fallbackExport: true
    };
  }
  function analyseNodes(node, sourceType) {
    try {
      return analyseNodesUnsafe(node, sourceType);
    } catch (error) {
      if (isOutOfMemoryError(error)) {
        state.logDiagnostic("error", "[MasterGo2Figma] Analyse node OOM", {
          node: getNodeProbe(node),
          sourceType,
          error: describeError(error)
        });
        throw error;
      }
      state.logDiagnostic("warn", "[MasterGo2Figma] Unable to fully analyse node, exporting fallback", {
        node: getNodeProbe(node),
        sourceType,
        error: describeError(error),
        debugState: state.exportDebugState
      });
      return createFallbackNodeJson(node, sourceType);
    }
  }
  function analyseNodesUnsafe(node, sourceType) {
    const resolvedSourceType = sourceType || node.type;
    const rule = getLayerRule(resolvedSourceType) || getLayerRule(node.type);
    if (!rule) {
      console.warn("Unsupported layer type:", resolvedSourceType, node.type);
      return {};
    }
    let nodeJson;
    if (rule.sendStrategy === "flattenBoolean") nodeJson = transBONode(node);
    else if (rule.sendStrategy === "booleanTree") nodeJson = transBooleanTreeNode(node, rule.restoreType);
    else if (rule.sendStrategy === "penNetwork") nodeJson = transPenNode(node, resolvedSourceType, rule.restoreType);
    else if (rule.sendStrategy === "ellipseArc") nodeJson = transEllipseNode(node);
    else if (rule.sendStrategy === "text") nodeJson = transTextNode(node);
    else if (rule.sendStrategy === "star") nodeJson = transStarNode(node);
    else if (rule.sendStrategy === "polygon") nodeJson = transPolygonNode(node);
    else if (rule.sendStrategy === "connector") nodeJson = transConnectorNode(node);
    else if (rule.sendStrategy === "frameLike") nodeJson = transFrameNode(node, resolvedSourceType);
    else if (rule.sendStrategy === "groupLike") nodeJson = transGroupNode(node);
    else nodeJson = getUniversalProperty(node, resolvedSourceType, rule.restoreType);
    if (rule.visualFrameSource && nodeJson && typeof nodeJson === "object") {
      nodeJson.shellPlaceholder = true;
    }
    return nodeJson;
  }
  function countExportableSubtreeNodes(node) {
    let count = 1;
    const children = getSafeExportableChildren(node);
    for (const child of children) {
      count += countExportableSubtreeNodes(child);
      if (count > SVG_FALLBACK_MAX_NODES) return count;
    }
    return count;
  }
  function tryExportSvgMarkup(node, label) {
    return __async(this, null, function* () {
      if (state.totalNodes === 0 && label !== "Boolean") return "";
      if (state.totalNodes > SVG_FALLBACK_MAX_DOCUMENT_NODES) return "";
      const subtreeNodeCount = countExportableSubtreeNodes(node);
      const width = Number(safeRead(() => node.width, 0)) || 0;
      const height = Number(safeRead(() => node.height, 0)) || 0;
      const area = Math.abs(width * height);
      if (subtreeNodeCount <= SVG_FALLBACK_MAX_NODES && area <= SVG_FALLBACK_MAX_AREA && Math.max(Math.abs(width), Math.abs(height)) <= SVG_FALLBACK_MAX_DIMENSION) {
        try {
          const svg = yield node.exportAsync({ format: "SVG" });
          if (typeof svg === "string" && svg.trim()) {
            if (svg.length > SVG_FALLBACK_MAX_BYTES) {
              console.warn(`[MasterGo2Figma] ${label} SVG fallback skipped because SVG is too large: ${getNodeDebugLabel(node)}, bytes=${svg.length}`);
              return "";
            }
            return svg;
          }
        } catch (error) {
          console.warn(`Unable to export ${label} as SVG fallback:`, getNodeDebugLabel(node), error);
        }
      }
      return "";
    });
  }
  function clearNodePaint(nodeJson) {
    if (!nodeJson.geometry) return;
    nodeJson.geometry.fills = [];
    nodeJson.geometry.strokes = [];
    nodeJson.geometry.strokeWeight = 0;
    nodeJson.geometry.strokeTopWeight = void 0;
    nodeJson.geometry.strokeBottomWeight = void 0;
    nodeJson.geometry.strokeLeftWeight = void 0;
    nodeJson.geometry.strokeRightWeight = void 0;
  }
  function markBooleanAsFrameFallback(nodeJson) {
    nodeJson.type = "FRAME";
    nodeJson.restoreType = "FRAME";
    nodeJson.receiveCreateOverride = "FRAME";
    nodeJson.booleanFallback = "frameContainer";
    nodeJson.clipsContent = false;
    clearNodePaint(nodeJson);
  }
  function enrichBooleanOperationExport(node, nodeJson, childNodes) {
    return __async(this, null, function* () {
      if (!nodeJson || safeRead(() => node.type, "") !== "BOOLEAN_OPERATION") return;
      const rule = getLayerRule("BOOLEAN_OPERATION");
      if (rule && rule.sendStrategy === "booleanTree") {
        return;
      }
      if (hasUsableVectorNetwork(nodeJson.vectorNetwork) || childNodes.length === 0) return;
      markBooleanAsFrameFallback(nodeJson);
    });
  }
  function hasVisibleFill(fills) {
    if (!Array.isArray(fills)) return false;
    return fills.some((fill) => fill && fill.type && fill.visible !== false && (fill.opacity === void 0 || fill.opacity > 0));
  }
  function shouldUseSvgFallbackForFilledVector(nodeJson) {
    if (!nodeJson || nodeJson.receiveCreateOverride || nodeJson.svgFallback) return false;
    if (nodeJson.sourceType !== "PEN" && nodeJson.sourceType !== "VECTOR") return false;
    if (!hasVisibleFill(nodeJson.geometry && nodeJson.geometry.fills)) return false;
    const vectorNetwork = nodeJson.vectorNetwork;
    if (!vectorNetwork || !Array.isArray(vectorNetwork.segments) || vectorNetwork.segments.length < 2) return false;
    if (Array.isArray(vectorNetwork.regions) && vectorNetwork.regions.length > 0) return false;
    return true;
  }
  function enrichFilledVectorExport(node, nodeJson) {
    return __async(this, null, function* () {
      if (!shouldUseSvgFallbackForFilledVector(nodeJson)) return;
      const svg = yield tryExportSvgMarkup(node, "Filled vector");
      if (!svg) return;
      nodeJson.svgMarkup = svg;
      nodeJson.svgFallback = true;
      nodeJson.receiveCreateOverride = "SVG";
      nodeJson.vectorFallback = "svgMissingRegions";
    });
  }
  function getRawChildCount(node) {
    return safeRead(() => {
      const children = node && node.children;
      return children && typeof children.length === "number" ? children.length : void 0;
    }, void 0);
  }
  function createNodeComplexitySnapshot(node, childNodes, nodeJson) {
    const vectorNetwork = nodeJson && nodeJson.vectorNetwork ? nodeJson.vectorNetwork : null;
    const regions = vectorNetwork && Array.isArray(vectorNetwork.regions) ? vectorNetwork.regions : void 0;
    return {
      id: safeRead(() => node.id, "unknown-id"),
      name: safeRead(() => node.name, "Untitled"),
      type: safeRead(() => node.type, "UNKNOWN"),
      sourceType: nodeJson && typeof nodeJson.sourceType === "string" ? nodeJson.sourceType : void 0,
      restoreType: nodeJson && typeof nodeJson.restoreType === "string" ? nodeJson.restoreType : void 0,
      width: safeRead(() => Number(node.width), void 0),
      height: safeRead(() => Number(node.height), void 0),
      childCount: childNodes ? childNodes.length : getRawChildCount(node),
      rawChildCount: getRawChildCount(node),
      textLength: nodeJson && typeof nodeJson.characters === "string" ? nodeJson.characters.length : void 0,
      fillCount: nodeJson && nodeJson.geometry && Array.isArray(nodeJson.geometry.fills) ? nodeJson.geometry.fills.length : void 0,
      strokeCount: nodeJson && nodeJson.geometry && Array.isArray(nodeJson.geometry.strokes) ? nodeJson.geometry.strokes.length : void 0,
      effectCount: nodeJson && nodeJson.blend && Array.isArray(nodeJson.blend.effects) ? nodeJson.blend.effects.length : void 0,
      vectorNetwork: vectorNetwork ? {
        vertices: Array.isArray(vectorNetwork.vertices) ? vectorNetwork.vertices.length : void 0,
        segments: Array.isArray(vectorNetwork.segments) ? vectorNetwork.segments.length : void 0,
        regions: regions ? regions.length : void 0,
        loops: regions ? regions.reduce((sum, region) => sum + (region && Array.isArray(region.loops) ? region.loops.length : 0), 0) : void 0
      } : void 0
    };
  }
  function getNodeDebugLabel(node) {
    const nodeId = safeRead(() => node.id, "");
    const nodeType = safeRead(() => node.type, "");
    if (node && node.id) {
      return `[HostNode: ${safeRead(() => node.name, "Untitled")} (${nodeType}, id=${nodeId})]`;
    }
    return `[JSON-Payload: ${safeRead(() => node.name, "Untitled")} (${nodeType}, id=${nodeId})]`;
  }
  function stringifyLayerPayload(payload, node, getNodeComplexity) {
    try {
      return JSON.stringify(payload);
    } catch (error) {
      const fatalOom = isOutOfMemoryError(error);
      state.logDiagnostic(fatalOom ? "error" : "warn", fatalOom ? "[MasterGo2Figma] Stringify OOM" : "[MasterGo2Figma] Stringify failed, exporting fallback", {
        error: describeError(error),
        complexity: getNodeComplexity ? getNodeComplexity() : createNodeComplexitySnapshot(node)
      });
      if (fatalOom) throw error;
      const fallbackPayload = __spreadProps(__spreadValues({}, payload), {
        props: createFallbackNodeJson(node, safeRead(() => node.type, "UNKNOWN"))
      });
      return JSON.stringify(fallbackPayload);
    }
  }
  function isRecoverableNodeExportError(error) {
    if (isOutOfMemoryError(error)) return false;
    if (error && error.code === UI_TRANSFER_ERROR_CODE) return false;
    let message = "";
    try {
      message = String(error && error.message !== void 0 ? error.message : error).toLowerCase();
    } catch (_) {
      message = "";
    }
    if (message.indexOf("ui zip") !== -1 || message.indexOf("timed out waiting for ui zip") !== -1) return false;
    return true;
  }
  function markLayerWritten(chunk, nodeId) {
    if (nodeId) chunk.writtenNodeIds[nodeId] = true;
  }
  function summarizeTransfer(transfer) {
    return {
      transferId: transfer.transferId,
      filename: transfer.filename,
      fileIndex: transfer.fileIndex,
      postedChunks: transfer.postedChunks,
      streamedBytes: transfer.streamedBytes
    };
  }
  function appendFallbackLayerRecord(node, page, parentId, index, pageIndex, chunk, transfer) {
    return __async(this, null, function* () {
      const nodeId = safeRead(() => node.id, `node-fallback-${pageIndex.layerCount + 1}`);
      const fallbackJson = createFallbackNodeJson(node);
      const layerRecord = {
        id: nodeId,
        pageId: safeRead(() => page.id, ""),
        parentId,
        index,
        name: safeRead(() => node.name, "Untitled (Fallback)"),
        childIds: [],
        props: fallbackJson
      };
      const recordJson = stringifyLayerPayload(layerRecord, node, () => createNodeComplexitySnapshot(node, [], fallbackJson));
      pageIndex.layerCount++;
      state.noteExportLayerRecord();
      yield appendLayerRecord(recordJson, pageIndex, chunk, transfer);
      markLayerWritten(chunk, nodeId);
    });
  }
  function collectSingleNodeExport(node, page, pageFolder, parentId, index, pageIndex, chunk, transfer, relation) {
    return __async(this, null, function* () {
      state.processedNodes++;
      let phase = "start";
      const nodeId = safeRead(() => node.id, `node-${pageIndex.layerCount + 1}`);
      const nodeName = safeRead(() => node.name, "Untitled");
      const nodeType = safeRead(() => node.type, "");
      const nodeDebug = safeRead(() => !!(node && node.id), false) ? `[HostNode: ${nodeName} (${nodeType}, id=${nodeId})]` : `[JSON-Payload: ${nodeName} (${nodeType}, id=${nodeId})]`;
      const pageName = pageIndex.name;
      let recordAppended = false;
      let childNodes = [];
      let shouldExportChildren = false;
      const setNodeDebug = (nextPhase, nodeComplexity) => {
        phase = nextPhase;
        state.setExportDebugState({
          phase: `node:${nextPhase}`,
          page: pageName,
          node: nodeDebug,
          nodeComplexity,
          parentId,
          nodeIndex: index,
          transferId: transfer.transferId,
          fileIndex: transfer.fileIndex,
          streamedBytes: transfer.streamedBytes
        });
      };
      try {
        setNodeDebug("read-children");
        childNodes = getSafeExportableChildren(node);
        setNodeDebug("analyse");
        let nodeJson = analyseNodes(node);
        setNodeDebug("enrich-boolean");
        yield enrichBooleanOperationExport(node, nodeJson, childNodes);
        setNodeDebug("enrich-vector");
        yield enrichFilledVectorExport(node, nodeJson);
        setNodeDebug("override-layout");
        overrideExportLayoutFromSourceNode(nodeJson, node);
        setNodeDebug("build-record");
        shouldExportChildren = !nodeJson || !nodeJson.omitChildrenOnRestore;
        const childIds = shouldExportChildren ? childNodes.map((child) => safeRead(() => child.id, "")) : [];
        const omittedChildNodeCount = !shouldExportChildren && nodeJson && nodeJson.omittedChildNodeCount ? nodeJson.omittedChildNodeCount : 0;
        let layerRecord = {
          id: nodeId,
          pageId: safeRead(() => page.id, ""),
          parentId,
          index,
          name: nodeName,
          childIds,
          props: nodeJson
        };
        const exportedChildCount = childNodes.length;
        const getNodeComplexity = () => {
          const snapshot = createNodeComplexitySnapshot(node, void 0, nodeJson);
          snapshot.childCount = exportedChildCount;
          return snapshot;
        };
        childNodes = [];
        setNodeDebug("stringify");
        let recordJson = stringifyLayerPayload(layerRecord, node, getNodeComplexity);
        const recordBytes = recordJson.length;
        if (recordBytes >= STRINGIFY_RECORD_WARN_BYTES) {
          state.logDiagnostic("warn", "[MasterGo2Figma] Large layer record", {
            page: pageName,
            node: nodeDebug,
            recordBytes,
            chunkBytes: chunk.bytes,
            chunkRecords: chunk.recordJsons.length,
            complexity: getNodeComplexity(),
            transfer: summarizeTransfer(transfer)
          });
        }
        layerRecord = null;
        nodeJson = null;
        pageIndex.layerCount++;
        state.noteExportLayerRecord();
        setNodeDebug("append-record");
        yield appendLayerRecord(recordJson, pageIndex, chunk, transfer);
        markLayerWritten(chunk, nodeId);
        recordAppended = true;
        if (omittedChildNodeCount) {
          state.processedNodes += omittedChildNodeCount;
        }
        setNodeDebug("progress");
        yield state.maybeReportExportProgress(state.processedNodes, state.totalNodes, "\u6B63\u5728\u5BFC\u51FA\u56FE\u5C42...");
        recordJson = null;
        childNodes = null;
        return { nodeId, shouldExportChildren, childIds };
      } catch (error) {
        const fatalOom = isOutOfMemoryError(error);
        state.logDiagnostic("error", fatalOom ? `[MasterGo2Figma] Fatal node OOM, stopping export: ${nodeId}` : `[MasterGo2Figma] Node export failed: ${nodeId}`, {
          phase,
          error: describeError(error),
          nodeId,
          page: pageName,
          debugState: state.exportDebugState
        });
        if (fatalOom) throw error;
        if (isRecoverableNodeExportError(error)) {
          if (nodeId && chunk.writtenNodeIds[nodeId]) {
            return null;
          }
          try {
            yield appendFallbackLayerRecord(node, page, parentId, index, pageIndex, chunk, transfer);
          } catch (fallbackError) {
            state.logDiagnostic("error", "[MasterGo2Figma] Recoverable node fallback failed, skipping node", {
              relation,
              parentId,
              node: getNodeProbe(node),
              originalError: describeError(error),
              fallbackError: describeError(fallbackError)
            });
          }
        } else {
          throw error;
        }
        return null;
      }
    });
  }
  function overrideExportLayoutFromSourceNode(nodeJson, node) {
    if (!nodeJson || !nodeJson.layout) return;
    try {
      const layoutTransform = cloneTransform(node.relativeTransform);
      nodeJson.layout.relativeTransform = layoutTransform;
      nodeJson.layout.x = layoutTransform[0][2];
      nodeJson.layout.y = layoutTransform[1][2];
      nodeJson.layout.rotation = -safeRead(() => node.rotation, 0) || 0;
      nodeJson.layout.width = safeRead(() => node.width, 0);
      nodeJson.layout.height = safeRead(() => node.height, 0);
    } catch (error) {
      if (isOutOfMemoryError(error)) throw error;
      state.logDiagnostic("warn", "[MasterGo2Figma] Unable to override layout properties for export, using analysed properties", {
        node: getNodeProbe(node),
        error: describeError(error)
      });
    }
  }

  // src/nodeTraverser.ts
  var INTERNAL_PROPS_PREFIX = "[PROPS]";
  var SIBLING_PROPS_PREFIX = "[PROPS_SIBLING]";
  function isGeneratedCarrierName(name) {
    return name.startsWith(INTERNAL_PROPS_PREFIX) || name.startsWith(SIBLING_PROPS_PREFIX);
  }
  function getExportableChildren(node) {
    const rawChildren = safeRead(() => node.children, null);
    if (!rawChildren) return [];
    const result = [];
    const count = safeRead(() => rawChildren.length, 0);
    for (let i = 0; i < count; i++) {
      try {
        const child = rawChildren[i];
        if (child && !isGeneratedCarrierName(safeRead(() => child.name, ""))) {
          result.push(child);
        }
      } catch (error) {
        if (isOutOfMemoryError(error)) {
          state.logDiagnostic("error", "[MasterGo2Figma] Child access OOM", {
            parent: getNodeProbe(node),
            childIndex: i,
            error: describeError(error)
          });
          throw error;
        }
      }
    }
    return result;
  }
  function getSafeExportableChildren(node) {
    try {
      return getExportableChildren(node);
    } catch (error) {
      if (isOutOfMemoryError(error)) throw error;
      state.logDiagnostic("warn", "[MasterGo2Figma] Unable to read children for export", {
        node: getNodeProbe(node),
        error: describeError(error)
      });
      return [];
    }
  }
  function collectSubtreeIterative(rootNode, page, pageFolder, parentId, rootIndex, pageIndexRecord, chunk, transfer, relation) {
    return __async(this, null, function* () {
      const rootNodeId = safeRead(() => rootNode.id, "");
      if (!rootNodeId) return;
      const stack = [{
        nodeId: rootNodeId,
        parentId,
        index: rootIndex,
        relation
      }];
      while (stack.length > 0) {
        const item = stack.pop();
        const { nodeId, parentId: currentParentId, index: currentIndex, relation: currentRelation } = item;
        try {
          const node = mg.getNodeById(nodeId);
          if (!node) {
            state.logDiagnostic("warn", `[MasterGo2Figma] DFS node not found by ID: ${nodeId}`, {
              nodeId,
              debugState: state.exportDebugState
            });
            continue;
          }
          const result = yield collectSingleNodeExport(
            node,
            page,
            pageFolder,
            currentParentId,
            currentIndex,
            pageIndexRecord,
            chunk,
            transfer,
            currentRelation
          );
          if (result && result.shouldExportChildren && result.childIds && result.childIds.length > 0) {
            for (let i = result.childIds.length - 1; i >= 0; i--) {
              const childId = result.childIds[i];
              if (childId) {
                stack.push({
                  nodeId: childId,
                  parentId: result.nodeId,
                  index: i,
                  relation: "child"
                });
              }
            }
          }
        } catch (error) {
          if (isOutOfMemoryError(error)) throw error;
          state.logDiagnostic("error", `[MasterGo2Figma] Iterative DFS node traversal failed: ${nodeId}`, {
            error: describeError(error),
            nodeId,
            debugState: state.exportDebugState
          });
        }
      }
    });
  }

  // src/transferStream.ts
  var EXPORT_TARGET_ZIP = "zip";
  var EXPORT_TARGET_LOCAL_RELAY = "local-relay";
  var SEND_TEXT_CHUNKS_AS_BYTES = true;
  var ENABLE_IMAGE_EXPORT = true;
  var ENABLE_SPLIT_EXPORT = true;
  var UI_TRANSFER_ERROR_CODE = "UI_TRANSFER";
  function uiTransferError(message) {
    const error = new Error(message);
    error.code = UI_TRANSFER_ERROR_CODE;
    return error;
  }
  function safeStringifyForLog(value) {
    try {
      return JSON.stringify(value);
    } catch (_) {
      return "[Unstringifyable Object]";
    }
  }
  function getExportFileAckKey(transferId, index) {
    return `${transferId}:${index}`;
  }
  function getExportTransferMessageMeta(transfer) {
    return {
      target: transfer.target,
      relayUrl: transfer.relayUrl || ""
    };
  }
  function startExportTransfer(transfer) {
    state.postUI(__spreadValues({
      type: "export-transfer-start",
      transferId: transfer.transferId,
      filename: transfer.filename,
      fileCount: 0,
      totalBytes: 0
    }, getExportTransferMessageMeta(transfer)));
  }
  function abortExportFileToUI(transfer, index, path, error) {
    try {
      state.postUI(__spreadValues({
        type: "export-file-abort",
        transferId: transfer.transferId,
        index,
        path,
        reason: safeStringifyForLog(describeError(error))
      }, getExportTransferMessageMeta(transfer)));
    } catch (abortError) {
      state.logDiagnostic("warn", "[MasterGo2Figma] Unable to send export-file-abort", {
        abortError: describeError(abortError),
        originalError: describeError(error),
        transfer: summarizeTransfer2(transfer),
        file: { index, path }
      });
    }
  }
  function clearPendingExportFileAck(transfer, index) {
    const key = getExportFileAckKey(transfer.transferId, index);
    const resolver = state.exportFileAckResolvers[key];
    if (!resolver) return;
    clearTimeout(resolver.timeoutId);
    delete state.exportFileAckResolvers[key];
  }
  function waitForExportFileAck(transfer, index, path, timeoutMs = EXPORT_FILE_ACK_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const key = getExportFileAckKey(transfer.transferId, index);
      const timeoutId = setTimeout(() => {
        delete state.exportFileAckResolvers[key];
        reject(uiTransferError(`Timed out waiting for UI file ack: ${path}`));
      }, timeoutMs);
      state.exportFileAckResolvers[key] = {
        resolve,
        reject,
        timeoutId,
        path
      };
    });
  }
  function drainPendingExportFileAck(transfer) {
    return __async(this, null, function* () {
      const pending = transfer.pendingFileAck;
      if (!pending) return;
      transfer.pendingFileAck = null;
      yield pending.promise;
      state.noteExportFileTransfer({ path: pending.path }, pending.size, pending.totalChunks);
    });
  }
  function streamExportFileToUI(transfer, file) {
    return __async(this, null, function* () {
      yield drainPendingExportFileAck(transfer);
      const index = transfer.fileIndex++;
      const canSendTextAsBytes = file.bytes === void 0 && SEND_TEXT_CHUNKS_AS_BYTES && typeof TextEncoder !== "undefined";
      const kind = file.bytes !== void 0 || canSendTextAsBytes ? "bytes" : "content";
      const contentParts = file.contentParts || (file.content !== void 0 ? [file.content] : []);
      const size = kind === "bytes" ? file.bytes ? file.bytes.length : contentParts.reduce((sum, part) => sum + part.length, 0) : contentParts.reduce((sum, part) => sum + part.length, 0);
      const totalChunks = kind === "bytes" ? Math.ceil(size / EXPORT_TRANSFER_CHUNK_SIZE) : Math.max(1, Math.ceil(size / EXPORT_TEXT_CHUNK_CHAR_LIMIT));
      let fileStarted = false;
      let fileEnded = false;
      try {
        state.setExportDebugState({
          phase: "transfer:file-start",
          file: file.path,
          transferId: transfer.transferId,
          fileIndex: index,
          fileSize: size,
          streamedBytes: transfer.streamedBytes
        });
        state.postUI(__spreadValues({
          type: "export-file-start",
          transferId: transfer.transferId,
          index,
          path: file.path,
          kind,
          size,
          totalChunks
        }, getExportTransferMessageMeta(transfer)));
        fileStarted = true;
        if (file.bytes !== void 0) {
          const bytes = file.bytes || new Uint8Array(0);
          for (let offset = 0, chunkIndex = 0; offset < bytes.length; offset += EXPORT_TRANSFER_CHUNK_SIZE, chunkIndex++) {
            state.setExportDebugState({
              phase: "transfer:bytes-chunk",
              file: file.path,
              transferId: transfer.transferId,
              fileIndex: index,
              chunkIndex,
              fileSize: size,
              streamedBytes: transfer.streamedBytes
            });
            state.postUI(__spreadValues({
              type: "export-file-chunk",
              transferId: transfer.transferId,
              index,
              chunkIndex,
              bytes: bytes.slice(offset, offset + EXPORT_TRANSFER_CHUNK_SIZE)
            }, getExportTransferMessageMeta(transfer)));
            transfer.postedChunks++;
            if (transfer.postedChunks % EXPORT_TRANSFER_YIELD_EVERY_CHUNKS === 0) yield yieldToHost();
          }
        } else {
          let chunkIndex = 0;
          const textEncoder = canSendTextAsBytes ? new TextEncoder() : null;
          const postContentChunk = (content) => __async(null, null, function* () {
            state.setExportDebugState({
              phase: textEncoder ? "transfer:content-bytes-chunk" : "transfer:content-chunk",
              file: file.path,
              transferId: transfer.transferId,
              fileIndex: index,
              chunkIndex,
              fileSize: size,
              streamedBytes: transfer.streamedBytes
            });
            const message = textEncoder ? __spreadValues({
              type: "export-file-chunk",
              transferId: transfer.transferId,
              index,
              chunkIndex,
              bytes: textEncoder.encode(content)
            }, getExportTransferMessageMeta(transfer)) : __spreadValues({
              type: "export-file-chunk",
              transferId: transfer.transferId,
              index,
              chunkIndex,
              content
            }, getExportTransferMessageMeta(transfer));
            state.postUI(message);
            chunkIndex++;
            transfer.postedChunks++;
            if (transfer.postedChunks % EXPORT_TRANSFER_YIELD_EVERY_CHUNKS === 0) yield yieldToHost();
          });
          for (const part of contentParts) {
            if (!part) continue;
            let offset = 0;
            while (offset < part.length) {
              const nextLength = Math.min(EXPORT_TEXT_CHUNK_CHAR_LIMIT, part.length - offset);
              const chunkStr = part.slice(offset, offset + nextLength);
              yield postContentChunk(chunkStr);
              offset += nextLength;
            }
          }
          if (size === 0) yield postContentChunk("");
        }
        transfer.streamedBytes += size;
        state.setExportDebugState({
          phase: "transfer:file-end",
          file: file.path,
          transferId: transfer.transferId,
          fileIndex: index,
          fileSize: size,
          streamedBytes: transfer.streamedBytes
        });
        const fileAckPromise = waitForExportFileAck(transfer, index, file.path);
        fileAckPromise.catch(() => {
        });
        state.postUI(__spreadValues({ type: "export-file-end", transferId: transfer.transferId, index }, getExportTransferMessageMeta(transfer)));
        fileEnded = true;
        transfer.pendingFileAck = { promise: fileAckPromise, index, path: file.path, size, totalChunks };
        if (index % EXPORT_FILE_YIELD_EVERY_FILES === 0) yield yieldToHost();
      } catch (error) {
        state.logDiagnostic("error", "[MasterGo2Figma] Transfer file failed", {
          error: describeError(error),
          file: {
            path: file.path,
            kind,
            index,
            size,
            started: fileStarted,
            ended: fileEnded
          },
          debugState: state.exportDebugState
        });
        if (fileStarted && !fileEnded) abortExportFileToUI(transfer, index, file.path, error);
        clearPendingExportFileAck(transfer, index);
        throw error;
      }
    });
  }
  function resolveExportFileAck(message) {
    const transferId = String(message && message.transferId || "");
    const index = Number(message && message.index);
    const key = getExportFileAckKey(transferId, index);
    const resolver = state.exportFileAckResolvers[key];
    if (!resolver) return;
    clearTimeout(resolver.timeoutId);
    delete state.exportFileAckResolvers[key];
    const ack = {
      transferId,
      index,
      success: message && message.success === true,
      path: typeof message.path === "string" ? message.path : resolver.path,
      error: typeof message.error === "string" ? message.error : void 0,
      pendingCount: typeof message.pendingCount === "number" ? message.pendingCount : void 0
    };
    if (ack.success) {
      resolver.resolve(ack);
    } else {
      resolver.reject(uiTransferError(`UI failed to write ${ack.path || resolver.path}: ${ack.error || "unknown error"}; pending=${ack.pendingCount === void 0 ? "unknown" : ack.pendingCount}`));
    }
  }
  function completeExportTransfer(transfer, manifest, isFinal = true, stats = manifest.stats) {
    state.postUI(__spreadValues({
      type: "export-transfer-complete",
      transferId: transfer.transferId,
      filename: transfer.filename,
      fileCount: transfer.fileIndex,
      totalBytes: transfer.streamedBytes,
      stats,
      isFinal
    }, getExportTransferMessageMeta(transfer)));
  }
  function resolveExportTransferAck(message) {
    const transferId = String(message && message.transferId || "");
    const resolver = state.exportTransferAckResolvers[transferId];
    if (!resolver) return;
    clearTimeout(resolver.timeoutId);
    delete state.exportTransferAckResolvers[transferId];
    const ack = {
      transferId,
      success: message && message.success === true,
      filename: typeof message.filename === "string" ? message.filename : void 0,
      error: typeof message.error === "string" ? message.error : void 0,
      pendingCount: typeof message.pendingCount === "number" ? message.pendingCount : void 0
    };
    if (ack.success) {
      resolver.resolve(ack);
    } else {
      resolver.reject(uiTransferError(`UI zip failed for ${ack.filename || transferId}: ${ack.error || "unknown error"}; pending=${ack.pendingCount === void 0 ? "unknown" : ack.pendingCount}`));
    }
  }
  function waitForExportTransferAck(transfer, timeoutMs = EXPORT_TRANSFER_ACK_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        delete state.exportTransferAckResolvers[transfer.transferId];
        reject(uiTransferError(`Timed out waiting for UI zip ack: ${transfer.filename}`));
      }, timeoutMs);
      state.exportTransferAckResolvers[transfer.transferId] = {
        resolve,
        reject,
        timeoutId
      };
    });
  }
  function yieldToHost() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  function createExportFilename(manifest) {
    const date = manifest.exportedAt.replace(/[:.]/g, "-");
    return `mastergo2figma-${manifest.scope}-${date}.zip`;
  }
  function createPageExportFilename(scope, page, pageIndex, pageCount, exportedAt, segmentIndex = 0, segmentCount = 1) {
    const date = exportedAt.replace(/[:.]/g, "-");
    const pageName = createFileSafeName(safeRead(() => page.name, ""), `page-${pageIndex + 1}`);
    const segmentName = segmentCount > 1 ? `-segment-${padNumber(segmentIndex + 1)}-of-${padNumber(segmentCount)}` : segmentCount === 0 ? `-segment-${padNumber(segmentIndex + 1)}` : "";
    return `mastergo2figma-${scope}-part-${padNumber(pageIndex + 1)}-of-${padNumber(pageCount)}${segmentName}-${pageName}-${date}.zip`;
  }
  function createFileSafeName(value, fallback) {
    const cleaned = String(value || "").trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 48);
    return cleaned || fallback;
  }
  function getExportTargets(options) {
    const pages = [...mg.document.children].filter((page) => !page.name.endsWith("_Process"));
    const selectedPageIds = new Set(options.pageIds);
    if (options.scope === "all-pages") {
      return pages.filter((page) => selectedPageIds.size === 0 || selectedPageIds.has(page.id)).map((page) => ({ page }));
    }
    if (options.scope === "partial-pages") {
      if (selectedPageIds.size === 0) throw new Error("\u8BF7\u81F3\u5C11\u9009\u62E9\u4E00\u4E2A\u9875\u9762");
      return pages.filter((page) => selectedPageIds.has(page.id)).map((page) => ({ page }));
    }
    if (options.scope === "selected") {
      const nodes = getTopLevelSelectedNodes(mg.document.currentPage.selection);
      return [{ page: mg.document.currentPage, nodes }];
    }
    return [{ page: mg.document.currentPage }];
  }
  function getTopLevelSelectedNodes(selection) {
    const selectedSet = new Set(selection.map((node) => node.id));
    return selection.filter((node) => !hasSelectedAncestor(node, selectedSet));
  }
  function hasSelectedAncestor(node, selectedSet) {
    let parent = node.parent;
    while (parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT") {
      if (selectedSet.has(parent.id)) return true;
      parent = parent.parent;
    }
    return false;
  }
  function ensureTargetNodes(target) {
    if (!target.nodes) {
      target.nodes = getSafeExportableChildren(target.page);
    }
    return target.nodes;
  }
  function clearTargetNodes(target) {
    if (target.nodes) {
      target.nodes.length = 0;
      delete target.nodes;
    }
  }
  function shouldSplitExportPackages(options, targets) {
    if (!ENABLE_SPLIT_EXPORT) return false;
    if (options.transferMode === "direct-zip") return false;
    if (targets.length > 1) return true;
    const nodes = ensureTargetNodes(targets[0]);
    return nodes.length > 1;
  }
  function createBaseExportManifest(options, pageCount) {
    return {
      schema: "mastergo2figma.package.v2",
      version: 2,
      source: "mastergo",
      documentId: mg.documentId,
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      scope: options.scope,
      pages: [],
      assets: {},
      stats: {
        pageCount,
        layerCount: 0,
        imageAssetCount: 0,
        missingImageAssetCount: 0
      }
    };
  }
  function createExportTransfer(manifest, filename, options) {
    const transferId = `export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const target = options && options.transferMode === "local-json-stream" ? EXPORT_TARGET_LOCAL_RELAY : EXPORT_TARGET_ZIP;
    return {
      transferId,
      filename: filename || createExportFilename(manifest),
      fileIndex: 0,
      postedChunks: 0,
      streamedBytes: 0,
      target,
      relayUrl: target === EXPORT_TARGET_LOCAL_RELAY && options ? options.relayUrl : void 0,
      pendingFileAck: null
    };
  }
  function summarizeTransfer2(transfer) {
    return {
      transferId: transfer.transferId,
      filename: transfer.filename,
      fileIndex: transfer.fileIndex,
      postedChunks: transfer.postedChunks,
      streamedBytes: transfer.streamedBytes
    };
  }
  function releaseExportPackageMemory(manifest, imageAssetContext) {
    manifest.pages = [];
    manifest.assets = {};
    imageAssetContext.assets.length = 0;
    imageAssetContext.bySourceRef = {};
  }
  function appendLayerRecord(recordJson, pageIndex, chunk, transfer) {
    return __async(this, null, function* () {
      const nextBytes = recordJson.length + (chunk.recordJsons.length > 0 ? 1 : 0);
      if (recordJson.length > LAYER_CHUNK_MAX_BYTES) {
        state.logDiagnostic("warn", "[MasterGo2Figma] Single layer record exceeds chunk byte target", {
          recordBytes: recordJson.length,
          chunkMaxBytes: LAYER_CHUNK_MAX_BYTES,
          page: pageIndex.name,
          transfer: summarizeTransfer2(transfer)
        });
      }
      if (chunk.recordJsons.length > 0 && (chunk.recordJsons.length >= LAYER_CHUNK_MAX_RECORDS || chunk.bytes + nextBytes > LAYER_CHUNK_MAX_BYTES)) {
        yield flushLayerChunk(pageIndex, chunk, transfer);
      }
      chunk.recordJsons.push(recordJson);
      chunk.bytes += nextBytes;
      if (chunk.recordJsons.length >= LAYER_CHUNK_MAX_RECORDS || chunk.bytes >= LAYER_CHUNK_MAX_BYTES) {
        yield flushLayerChunk(pageIndex, chunk, transfer);
      }
    });
  }
  function flushLayerChunk(pageIndex, chunk, transfer) {
    return __async(this, null, function* () {
      if (chunk.recordJsons.length === 0) return;
      const fileIndex = chunk.chunkIndex++;
      const path = `pages/${chunk.pageFolder}/layers/layers-${padNumber(fileIndex)}.json`;
      const recordCount = chunk.recordJsons.length;
      const byteCount = chunk.bytes;
      state.setExportDebugState({
        phase: "chunk:flush",
        page: pageIndex.name,
        file: path,
        transferId: transfer.transferId,
        fileIndex: transfer.fileIndex,
        chunkIndex: fileIndex,
        fileSize: byteCount,
        streamedBytes: transfer.streamedBytes
      });
      const contentParts = [
        `{"schema":"mastergo2figma.layers.v2","version":2,"pageId":${JSON.stringify(chunk.pageId)},"records":[`,
        chunk.recordJsons.join(","),
        "]}"
      ];
      yield streamExportFileToUI(transfer, { path, contentParts });
      pageIndex.layerChunks.push(path);
      chunk.recordJsons = [];
      chunk.bytes = 0;
    });
  }
  function getDocumentPageSummaries() {
    return [...mg.document.children].filter((page) => !page.name.endsWith("_Process")).map((page) => ({
      id: page.id,
      name: page.name,
      isCurrent: page.id === mg.document.currentPage.id,
      childCount: page.children.length
    }));
  }
  function createPageFolderName(page, index) {
    const label = safeRead(() => page.name, "") || safeRead(() => page.id, "page");
    return `page-${padNumber(index + 1)}-${slugifyPathPart(label)}`;
  }
  function slugifyPathPart(value) {
    const normalized = value.toLowerCase().trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 32);
    return normalized || "untitled";
  }
  function countNodes(node) {
    return __async(this, null, function* () {
      state.totalNodes++;
      state.processedNodes++;
      if (state.processedNodes % EXPORT_SCAN_YIELD_EVERY_NODES === 0) yield yieldToEventLoop();
      try {
        let childNodes = getSafeExportableChildren(node);
        for (let i = 0; i < childNodes.length; i++) {
          const child = childNodes[i];
          childNodes[i] = null;
          yield countNodes(child);
        }
        childNodes = null;
      } catch (error) {
        const canMark = !!(error && typeof error === "object");
        if (!canMark || !error.__mastergo2figmaScanLogged) {
          if (canMark) error.__mastergo2figmaScanLogged = true;
          state.logDiagnostic("error", "[MasterGo2Figma] Scan node failed", {
            error: describeError(error),
            node: getNodeProbe(node),
            totalNodes: state.totalNodes
          });
        }
        throw error;
      }
    });
  }
  function createImageAssetContext() {
    return {
      bySourceRef: {},
      assets: [],
      missingImageAssetCount: 0
    };
  }
  function streamPageRootSegmentToTransfer(pageTarget, pageIndex, pageCount, startRootIndex, targetLayerCount, manifest, transfer, pageNameOverride) {
    return __async(this, null, function* () {
      const pageFolder = createPageFolderName(pageTarget.page, pageIndex);
      const pageId = safeRead(() => pageTarget.page.id, `page-${pageIndex + 1}`);
      const pageName = pageNameOverride || safeRead(() => pageTarget.page.name, "Untitled");
      const pageIndexRecord = {
        schema: "mastergo2figma.page.v2",
        version: 2,
        id: pageId,
        name: pageName,
        folder: pageFolder,
        rootNodeIds: [],
        layerChunks: [],
        layerCount: 0
      };
      const chunk = {
        pageId,
        pageFolder,
        chunkIndex: 1,
        recordJsons: [],
        bytes: 0,
        writtenNodeIds: {}
      };
      const nodes = ensureTargetNodes(pageTarget);
      let rootIndex = startRootIndex;
      while (rootIndex < nodes.length) {
        const node = nodes[rootIndex];
        pageIndexRecord.rootNodeIds.push(safeRead(() => node.id, `root-${pageIndex + 1}-${rootIndex + 1}`));
        yield collectSubtreeIterative(node, pageTarget.page, pageFolder, null, rootIndex, pageIndexRecord, chunk, transfer, "root");
        rootIndex++;
        if (pageIndexRecord.layerCount >= targetLayerCount) break;
      }
      yield flushLayerChunk(pageIndexRecord, chunk, transfer);
      const pageFile = `pages/${pageFolder}/page.json`;
      yield streamExportFileToUI(transfer, {
        path: pageFile,
        content: JSON.stringify(pageIndexRecord)
      });
      manifest.pages.push({
        id: pageIndexRecord.id,
        name: pageIndexRecord.name,
        folder: pageFolder,
        pageFile,
        layerCount: pageIndexRecord.layerCount
      });
      manifest.stats.layerCount += pageIndexRecord.layerCount;
      return {
        nextRootIndex: rootIndex,
        rootCount: rootIndex - startRootIndex,
        layerCount: pageIndexRecord.layerCount
      };
    });
  }
  function streamPageExportToTransfer(pageTarget, pageIndex, pageCount, manifest, transfer, pageNameOverride) {
    return __async(this, null, function* () {
      const pageFolder = createPageFolderName(pageTarget.page, pageIndex);
      const pageId = safeRead(() => pageTarget.page.id, `page-${pageIndex + 1}`);
      const pageName = pageNameOverride || safeRead(() => pageTarget.page.name, "Untitled");
      const nodes = ensureTargetNodes(pageTarget);
      const pageIndexRecord = {
        schema: "mastergo2figma.page.v2",
        version: 2,
        id: pageId,
        name: pageName,
        folder: pageFolder,
        rootNodeIds: [],
        layerChunks: [],
        layerCount: 0
      };
      const chunk = {
        pageId,
        pageFolder,
        chunkIndex: 1,
        recordJsons: [],
        bytes: 0,
        writtenNodeIds: {}
      };
      for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        pageIndexRecord.rootNodeIds.push(safeRead(() => node.id, `root-${pageIndex + 1}-${index + 1}`));
        yield collectSubtreeIterative(node, pageTarget.page, pageFolder, null, index, pageIndexRecord, chunk, transfer, "root");
      }
      yield flushLayerChunk(pageIndexRecord, chunk, transfer);
      const pageFile = `pages/${pageFolder}/page.json`;
      yield streamExportFileToUI(transfer, {
        path: pageFile,
        content: JSON.stringify(pageIndexRecord)
      });
      manifest.pages.push({
        id: pageIndexRecord.id,
        name: pageIndexRecord.name,
        folder: pageFolder,
        pageFile,
        layerCount: pageIndexRecord.layerCount
      });
      manifest.stats.layerCount += pageIndexRecord.layerCount;
    });
  }
  function streamImageAssetsToTransfer(imageAssetContext, manifest, transfer) {
    return __async(this, null, function* () {
      if (!ENABLE_IMAGE_EXPORT) return;
      let streamedAssets = 0;
      for (const asset of imageAssetContext.assets) {
        yield loadAndStreamImageAsset(asset, imageAssetContext, transfer);
        manifest.assets[asset.key] = {
          key: asset.key,
          fileName: asset.fileName,
          path: asset.path,
          missing: asset.missing || void 0
        };
        if (asset.bytes && !asset.missing) manifest.stats.imageAssetCount++;
        asset.bytes = null;
        streamedAssets++;
        if (streamedAssets % EXPORT_ASSET_YIELD_EVERY_ASSETS === 0) yield yieldToHost();
      }
      manifest.stats.missingImageAssetCount = imageAssetContext.missingImageAssetCount;
    });
  }
  function streamPageRootSegmentsToPackages(options, pageTarget, pageIndex, pageCount, aggregateManifest) {
    return __async(this, null, function* () {
      const pageName = safeRead(() => pageTarget.page.name, "Untitled");
      let rootIndex = 0;
      let segmentIndex = 0;
      const nodes = ensureTargetNodes(pageTarget);
      const useSegmentNames = nodes.length > 1;
      while (rootIndex < nodes.length) {
        const imageAssetContext = createImageAssetContext();
        state.activeImageAssetContext = imageAssetContext;
        const manifest = createBaseExportManifest(options, 1);
        const filename = createPageExportFilename(
          options.scope,
          pageTarget.page,
          pageIndex,
          pageCount,
          manifest.exportedAt,
          segmentIndex,
          useSegmentNames ? 0 : 1
        );
        const transfer = createExportTransfer(manifest, filename, options);
        startExportTransfer(transfer);
        const segmentLabel = useSegmentNames ? ` segment ${segmentIndex + 1}` : "";
        const pageNameOverride = useSegmentNames ? `${pageName} ${segmentIndex + 1}` : void 0;
        const startRootIndex = rootIndex;
        state.noteExportSplitPackage();
        const segmentResult = yield state.timeExportPhase("exportMs", () => __async(null, null, function* () {
          return yield streamPageRootSegmentToTransfer(
            pageTarget,
            pageIndex,
            pageCount,
            rootIndex,
            PAGE_SEGMENT_TARGET_LAYERS,
            manifest,
            transfer,
            pageNameOverride
          );
        }));
        rootIndex = segmentResult.nextRootIndex;
        state.postProgressUI({
          type: "progress",
          phase: "assets",
          current: state.processedNodes,
          total: 0,
          label: `\u6B63\u5728\u5BFC\u51FA\u56FE\u7247\u8D44\u6E90 ${pageIndex + 1}/${pageCount}${segmentLabel}...`
        });
        yield state.timeExportPhase("assetMs", () => __async(null, null, function* () {
          yield streamImageAssetsToTransfer(imageAssetContext, manifest, transfer);
        }));
        yield state.timeExportPhase("manifestMs", () => __async(null, null, function* () {
          yield streamExportFileToUI(transfer, {
            path: "manifest.json",
            content: JSON.stringify(manifest)
          });
        }));
        const pageSummary = manifest.pages[0];
        if (pageSummary) aggregateManifest.pages.push(pageSummary);
        aggregateManifest.stats.pageCount = aggregateManifest.pages.length;
        aggregateManifest.stats.layerCount += manifest.stats.layerCount;
        aggregateManifest.stats.imageAssetCount += manifest.stats.imageAssetCount;
        aggregateManifest.stats.missingImageAssetCount += manifest.stats.missingImageAssetCount;
        const isFinal = pageIndex === pageCount - 1 && rootIndex >= nodes.length;
        yield drainPendingExportFileAck(transfer);
        const ackPromise = waitForExportTransferAck(transfer);
        completeExportTransfer(transfer, manifest, isFinal, isFinal ? aggregateManifest.stats : manifest.stats);
        releaseExportPackageMemory(manifest, imageAssetContext);
        state.activeImageAssetContext = null;
        yield state.timeExportPhase("ackMs", () => __async(null, null, function* () {
          return yield ackPromise;
        }));
        segmentIndex++;
        yield yieldToHost();
      }
    });
  }
  function streamJsonExportPackage(options) {
    return __async(this, null, function* () {
      state.totalNodes = 0;
      state.processedNodes = 0;
      const previousImageAssetContext = state.activeImageAssetContext;
      try {
        const targets = getExportTargets(options);
        let rootCount = 0;
        for (const target of targets) {
          rootCount += ensureTargetNodes(target).length;
          clearTargetNodes(target);
        }
        if (rootCount === 0) {
          throw new Error(options.scope === "selected" ? "\u8BF7\u5148\u9009\u62E9\u8981\u5BFC\u51FA\u7684\u56FE\u5C42" : "\u6CA1\u6709\u53EF\u5BFC\u51FA\u7684\u56FE\u5C42");
        }
        state.resetExportStats(options, targets.length, rootCount);
        if (shouldSplitExportPackages(options, targets)) {
          const aggregateManifest = yield streamSplitJsonExportPackages(options, targets);
          state.logExportPerformanceSummary("split-complete", aggregateManifest);
          return aggregateManifest;
        }
        state.postProgressUI({ type: "progress", phase: "scan", current: 0, total: 0, label: "\u6B63\u5728\u626B\u63CF\u56FE\u5C42..." });
        state.processedNodes = 0;
        state.totalNodes = 0;
        yield state.timeExportPhase("scanMs", () => __async(null, null, function* () {
          for (const target of targets) {
            const nodes = ensureTargetNodes(target);
            for (const node of nodes) yield countNodes(node);
            clearTargetNodes(target);
          }
        }));
        state.processedNodes = 0;
        state.postProgressUI({ type: "progress", phase: "prepare", current: 0, total: state.totalNodes, label: "\u51C6\u5907\u5206\u5757\u5BFC\u51FA JSON..." });
        const imageAssetContext = createImageAssetContext();
        state.activeImageAssetContext = imageAssetContext;
        const manifest = createBaseExportManifest(options, targets.length);
        const transfer = createExportTransfer(manifest, void 0, options);
        startExportTransfer(transfer);
        yield state.timeExportPhase("exportMs", () => __async(null, null, function* () {
          for (let pageIndex = 0; pageIndex < targets.length; pageIndex++) {
            const pageTarget = targets[pageIndex];
            ensureTargetNodes(pageTarget);
            yield streamPageExportToTransfer(pageTarget, pageIndex, targets.length, manifest, transfer);
            clearTargetNodes(pageTarget);
            targets[pageIndex] = null;
          }
        }));
        state.postProgressUI({ type: "progress", phase: "assets", current: state.processedNodes, total: state.totalNodes, label: "\u6B63\u5728\u5BFC\u51FA\u56FE\u7247\u8D44\u6E90..." });
        yield state.timeExportPhase("assetMs", () => __async(null, null, function* () {
          yield streamImageAssetsToTransfer(imageAssetContext, manifest, transfer);
        }));
        yield state.timeExportPhase("manifestMs", () => __async(null, null, function* () {
          yield streamExportFileToUI(transfer, {
            path: "manifest.json",
            content: JSON.stringify(manifest)
          });
        }));
        state.postProgressUI({ type: "progress", phase: "complete", current: state.processedNodes, total: state.processedNodes, label: "JSON \u5DF2\u751F\u6210\uFF0C\u6B63\u5728\u51C6\u5907\u4E0B\u8F7D..." });
        yield drainPendingExportFileAck(transfer);
        const ackPromise = waitForExportTransferAck(transfer);
        completeExportTransfer(transfer, manifest);
        yield state.timeExportPhase("ackMs", () => __async(null, null, function* () {
          return yield ackPromise;
        }));
        state.logExportPerformanceSummary("complete", manifest);
        return manifest;
      } catch (error) {
        state.logExportPerformanceSummary("failed");
        state.logDiagnostic("error", "[MasterGo2Figma] Export transfer failed", {
          error: describeError(error),
          debugState: state.exportDebugState
        });
        throw error;
      } finally {
        state.activeImageAssetContext = previousImageAssetContext;
      }
    });
  }
  function streamSplitJsonExportPackages(options, targets) {
    return __async(this, null, function* () {
      const aggregateManifest = createBaseExportManifest(options, targets.length);
      let rootCount = 0;
      for (const target of targets) {
        rootCount += ensureTargetNodes(target).length;
        clearTargetNodes(target);
      }
      state.postProgressUI({
        type: "progress",
        phase: "prepare",
        current: 0,
        total: 0,
        label: "\u6B63\u5728\u6309\u9875\u9762\u5206\u5305\u5BFC\u51FA..."
      });
      for (let pageIndex = 0; pageIndex < targets.length; pageIndex++) {
        const pageTarget = targets[pageIndex];
        ensureTargetNodes(pageTarget);
        yield streamPageRootSegmentsToPackages(options, pageTarget, pageIndex, targets.length, aggregateManifest);
        clearTargetNodes(pageTarget);
        targets[pageIndex] = null;
      }
      return aggregateManifest;
    });
  }

  // src/code.ts
  var EXPORT_QUEUE_CACHE_KEY = "mastergo2figma.export-queue.v1";
  try {
    showPluginUI();
  } catch (error) {
    console.error("Unable to open SendToFigma plugin UI:", error);
    try {
      mg.notify("\u63D2\u4EF6\u754C\u9762\u6253\u5F00\u5931\u8D25\uFF0C\u8BF7\u67E5\u770B\u63A7\u5236\u53F0", {
        position: "bottom",
        timeout: 3e3,
        type: "error"
      });
    } catch (_) {
    }
  }
  function showPluginUI() {
    mg.ui.onmessage = (rawMessage) => __async(null, null, function* () {
      const message = unwrapUIMessage(rawMessage);
      if (!message || typeof message !== "object") return;
      if (message.type === "ui-ready") {
        yield safePostInitUI();
        return;
      }
      if (message.type === "close") {
        mg.closePlugin();
        return;
      }
      if (message.type === "resize") {
        const width = typeof message.width === "number" ? message.width : 400;
        const height = typeof message.height === "number" ? message.height : 710;
        mg.ui.resize(width, height);
        return;
      }
      if (message.type === "export-transfer-finished") {
        resolveExportTransferAck(message);
        return;
      }
      if (message.type === "export-file-finished") {
        resolveExportFileAck(message);
        return;
      }
      if (message.type === "test-main-fetch-relay") {
        yield testMainRelayFetch(typeof message.relayUrl === "string" ? message.relayUrl : "");
        return;
      }
      if (message.type !== "start-export") return;
      if (state.exportInProgress) return;
      const options = {
        scope: normalizeScope(message.scope),
        pageIds: Array.isArray(message.pageIds) ? message.pageIds : [],
        transferMode: normalizeTransferMode(message.transferMode),
        relayUrl: typeof message.relayUrl === "string" ? message.relayUrl : void 0
      };
      state.exportInProgress = true;
      try {
        const prepared = yield prepareExportRun(options);
        yield savePendingExportQueueForRecovery(prepared);
        const success = yield runWithUI(prepared.options);
        if (success) {
          yield updatePendingExportQueue(prepared);
        }
      } catch (error) {
        state.logDiagnostic("error", "[MasterGo2Figma] Export run failed before completion", {
          error: describeError(error),
          debugState: state.exportDebugState
        });
        state.postUI({
          type: "error",
          message: error instanceof Error ? error.message : "\u5BFC\u51FA\u5931\u8D25\uFF0C\u8BF7\u67E5\u770B\u63A7\u5236\u53F0"
        });
      } finally {
        state.exportInProgress = false;
      }
    });
    openPluginUI();
    startLayerRulesLoad();
  }
  function openPluginUI() {
    try {
      mg.showUI(__html__, { width: 400, height: 710 });
    } catch (error) {
      console.warn("Unable to open preferred SendToFigma UI size, retrying with compact size:", error);
      mg.showUI(__html__, { width: 400, height: 710 });
    }
  }
  function unwrapUIMessage(rawMessage) {
    if (rawMessage && rawMessage.pluginMessage) return rawMessage.pluginMessage;
    return rawMessage;
  }
  function testMainRelayFetch(rawRelayUrl) {
    return __async(this, null, function* () {
      const relayUrl = normalizeRelayUrl(rawRelayUrl);
      state.postUI({
        type: "main-relay-test-result",
        ok: false,
        relayUrl,
        fetchAvailable: false,
        elapsedMs: 0,
        error: "MasterGo \u63D2\u4EF6\u4E3B\u7EBF\u7A0B\u6C99\u76D2\u4E2D\u6CA1\u6709\u5185\u7F6E fetch API\uFF0C\u8BF7\u901A\u8FC7 UI \u7EBF\u7A0B\u8FDB\u884C\u8BF7\u6C42\u3002"
      });
    });
  }
  function normalizeRelayUrl(value) {
    const text = String(value || "").trim() || "http://127.0.0.1:8765";
    return text.replace(/\/+$/, "");
  }
  function postInitUI() {
    return __async(this, null, function* () {
      yield ensureLayerRulesLoaded();
      state.postUI({
        type: "init",
        command: normalizeScope(mg.command),
        selectionCount: mg.document.currentPage.selection.length,
        pageCount: mg.document.children.length,
        currentPageName: mg.document.currentPage.name,
        currentPageId: mg.document.currentPage.id,
        pages: getDocumentPageSummaries(),
        exportQueue: yield getPendingExportQueueStatus(),
        rules: getLayerRuleStatus()
      });
    });
  }
  function safePostInitUI() {
    return __async(this, null, function* () {
      try {
        yield postInitUI();
      } catch (error) {
        console.warn("Unable to initialize SendToFigma UI:", error);
        try {
          state.postUI({
            type: "error",
            message: error instanceof Error ? error.message : "\u63D2\u4EF6\u521D\u59CB\u5316\u5931\u8D25"
          });
        } catch (_) {
        }
      }
    });
  }
  function normalizeScope(scope) {
    if (scope === "all-pages") return "all-pages";
    if (scope === "selected") return "selected";
    if (scope === "partial-pages") return "partial-pages";
    return "current-page";
  }
  function normalizeTransferMode(mode) {
    return mode === "local-json-stream" ? "local-json-stream" : "direct-zip";
  }
  function runWithUI(options) {
    return __async(this, null, function* () {
      try {
        yield ensureLayerRulesLoaded();
        if (options.transferMode === "local-json-stream") {
          if (!options.relayUrl) throw new Error("\u8BF7\u586B\u5199\u672C\u5730\u6D41\u4F20\u8F93\u670D\u52A1\u5730\u5740");
          state.postProgressUI({ type: "progress", phase: "start", current: 0, total: 0, label: "\u6B63\u5728\u51C6\u5907\u6D41\u4F20\u8F93 JSON..." });
          const manifest2 = yield streamJsonExportPackage(options);
          cacheLatestExportSummary(manifest2);
          return true;
        }
        state.postProgressUI({ type: "progress", phase: "start", current: 0, total: 0, label: "\u6B63\u5728\u51C6\u5907\u751F\u6210 zip..." });
        const manifest = yield streamJsonExportPackage(options);
        cacheLatestExportSummary(manifest);
        return true;
      } catch (error) {
        state.logDiagnostic("error", "[MasterGo2Figma] Export failed", {
          error: describeError(error),
          debugState: state.exportDebugState
        });
        state.postUI({
          type: "error",
          message: error instanceof Error ? error.message : "\u5BFC\u51FA\u5931\u8D25\uFF0C\u8BF7\u67E5\u770B\u63A7\u5236\u53F0"
        });
        return false;
      }
    });
  }
  function prepareExportRun(options) {
    return __async(this, null, function* () {
      if (options.scope !== "partial-pages") {
        return { options, remainingPageIds: [], limitedToSinglePage: false };
      }
      const pageIds = filterExistingPageIds(options.pageIds);
      return { options: __spreadProps(__spreadValues({}, options), { pageIds }), remainingPageIds: [], limitedToSinglePage: false };
    });
  }
  function savePendingExportQueueForRecovery(prepared) {
    return __async(this, null, function* () {
      if (prepared.options.scope !== "partial-pages" || prepared.options.pageIds.length === 0) {
        yield clearPendingExportQueue();
        return;
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const queue = {
        pageIds: prepared.options.pageIds,
        createdAt: now,
        updatedAt: now
      };
      yield mg.clientStorage.setAsync(EXPORT_QUEUE_CACHE_KEY, queue);
    });
  }
  function updatePendingExportQueue(prepared) {
    return __async(this, null, function* () {
      yield clearPendingExportQueue();
      state.postUI({ type: "export-queue-cleared" });
    });
  }
  function clearPendingExportQueue() {
    return __async(this, null, function* () {
      try {
        yield mg.clientStorage.deleteAsync(EXPORT_QUEUE_CACHE_KEY);
      } catch (error) {
        console.warn("Unable to clear export queue:", error);
      }
    });
  }
  function readPendingExportQueue() {
    return __async(this, null, function* () {
      try {
        const cached = yield mg.clientStorage.getAsync(EXPORT_QUEUE_CACHE_KEY);
        if (!cached || !Array.isArray(cached.pageIds)) return null;
        const pageIds = filterExistingPageIds(cached.pageIds);
        if (pageIds.length === 0) {
          yield clearPendingExportQueue();
          return null;
        }
        return {
          pageIds,
          createdAt: String(cached.createdAt || cached.updatedAt || ""),
          updatedAt: String(cached.updatedAt || "")
        };
      } catch (error) {
        console.warn("Unable to read export queue:", error);
        return null;
      }
    });
  }
  function getPendingExportQueueStatus() {
    return __async(this, null, function* () {
      const queue = yield readPendingExportQueue();
      return queue ? createExportQueueStatus(queue) : null;
    });
  }
  function createExportQueueStatus(queue) {
    const nextPageId = queue.pageIds[0] || "";
    return {
      pageIds: queue.pageIds,
      remainingCount: queue.pageIds.length,
      nextPageId,
      nextPageName: getPageNameById(nextPageId),
      updatedAt: queue.updatedAt
    };
  }
  function filterExistingPageIds(pageIds) {
    const existingPageIds = new Set([...mg.document.children].map((page) => page.id));
    const result = [];
    const seen = {};
    for (const pageId of pageIds) {
      if (typeof pageId !== "string" || !existingPageIds.has(pageId) || seen[pageId]) continue;
      seen[pageId] = true;
      result.push(pageId);
    }
    return result;
  }
  function getPageNameById(pageId) {
    const page = [...mg.document.children].find((nextPage) => nextPage.id === pageId);
    return page ? safeRead(() => page.name, "Untitled") : "Untitled";
  }
  function cacheLatestExportSummary(manifest) {
    mg.clientStorage.setAsync("latest-mastergo2figma-export", {
      manifest: {
        schema: manifest.schema,
        version: manifest.version,
        source: manifest.source,
        documentId: manifest.documentId,
        exportedAt: manifest.exportedAt,
        scope: manifest.scope,
        stats: manifest.stats
      },
      savedAt: (/* @__PURE__ */ new Date()).toISOString()
    }).catch((error) => {
      console.warn("Unable to cache latest export summary:", error);
    });
  }
})();
