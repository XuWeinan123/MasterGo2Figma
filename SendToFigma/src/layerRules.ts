import { LayerConversionConfig, LayerConversionRule } from "../../shared/types";
import { state } from "./state";
import { DEFAULT_LAYER_CONVERSION_CONFIG } from "../../shared/layerRulesConfig";

export { DEFAULT_LAYER_CONVERSION_CONFIG };

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
