import { LayerConversionConfig, LayerConversionRule } from "../../shared/types";
import { state } from "./state";

const LAYER_RULES_SCHEMA = "mastergo2figma.layer-conversion-rules.v1";

export const DEFAULT_LAYER_CONVERSION_CONFIG: LayerConversionConfig = {
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
        COMPONENT: { sourceType: "COMPONENT", restoreType: "FRAME", sendStrategy: "frameLike", receiveCreate: "FRAME", isContainer: true, visualFrameSource: true },
        COMPONENT_SET: { sourceType: "COMPONENT_SET", restoreType: "FRAME", sendStrategy: "frameLike", receiveCreate: "FRAME", isContainer: true, visualFrameSource: true },
        INSTANCE: { sourceType: "INSTANCE", restoreType: "FRAME", sendStrategy: "frameLike", receiveCreate: "FRAME", isContainer: true, visualFrameSource: true }
    }
};

export function createLayerRuleIndex(config: LayerConversionConfig) {
    const result: { [sourceType: string]: LayerConversionRule } = {};
    for (const sourceType in config.rules) {
        if (Object.prototype.hasOwnProperty.call(config.rules, sourceType)) {
            result[sourceType] = config.rules[sourceType];
        }
    }
    return result;
}

export function initializeRules() {
    state.cachedLayerRules = {
        config: DEFAULT_LAYER_CONVERSION_CONFIG,
        fileName: "内置转换规则",
        importedAt: ""
    };
    state.layerRulesBySourceType = createLayerRuleIndex(DEFAULT_LAYER_CONVERSION_CONFIG);
}

export function startLayerRulesLoad() {
    if (!state.layerRulesLoadPromise) {
        state.layerRulesLoadPromise = (async () => {
            initializeRules();
        })();
    }
    return state.layerRulesLoadPromise;
}

export async function ensureLayerRulesLoaded() {
    await startLayerRulesLoad();
}

export function getLayerRuleStatus() {
    if (!state.cachedLayerRules || !state.layerRulesBySourceType) return { valid: false };
    return {
        valid: true,
        fileName: state.cachedLayerRules.fileName,
        importedAt: state.cachedLayerRules.importedAt,
        ruleCount: Object.keys(state.layerRulesBySourceType).length
    };
}

export function hasValidLayerRules() {
    return !!state.layerRulesBySourceType;
}

export function getLayerRule(sourceType: string | undefined | null): LayerConversionRule | null {
    if (!sourceType || !state.layerRulesBySourceType) return null;
    return state.layerRulesBySourceType[sourceType] || null;
}

export function getRuleRestoreType(sourceType: string): string {
    const rule = getLayerRule(sourceType);
    return rule ? rule.restoreType : sourceType;
}

export function getRestoreType(sourceType: string): string {
    return getRuleRestoreType(sourceType);
}

export function isConfiguredContainerType(sourceType: string): boolean {
    const rule = getLayerRule(sourceType);
    return !!rule && rule.isContainer;
}
