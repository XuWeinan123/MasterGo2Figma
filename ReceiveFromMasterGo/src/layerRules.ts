import { LayerConversionConfig, LayerConversionRule } from "../../shared/types";
import { state } from "./state";
import {
  DEFAULT_LAYER_CONVERSION_CONFIG,
  LAYER_RULES_SCHEMA,
  VALID_RECEIVE_CREATE_TYPES,
} from "../../shared/layerRulesConfig";

export { DEFAULT_LAYER_CONVERSION_CONFIG, LAYER_RULES_SCHEMA, VALID_RECEIVE_CREATE_TYPES };

export function startLayerRulesLoad(): Promise<void> {
  if (!state.layerRulesLoadPromise) {
    state.layerRulesLoadPromise = loadCachedLayerRules();
  }
  return state.layerRulesLoadPromise;
}

export async function ensureLayerRulesLoaded(): Promise<void> {
  await startLayerRulesLoad();
}

async function loadCachedLayerRules(): Promise<void> {
  state.cachedLayerRules = {
    config: DEFAULT_LAYER_CONVERSION_CONFIG,
    fileName: "内置转换规则",
    importedAt: ""
  };
  state.layerRulesBySourceType = createLayerRuleIndex(DEFAULT_LAYER_CONVERSION_CONFIG);
}

function createLayerRuleIndex(config: LayerConversionConfig): { [sourceType: string]: LayerConversionRule } {
  const result: { [sourceType: string]: LayerConversionRule } = {};
  for (const sourceType in config.rules) {
    result[sourceType] = config.rules[sourceType];
  }
  return result;
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

export function hasValidLayerRules(): boolean {
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

export function isVisualFrameSourceType(sourceType: string): boolean {
  const rule = getLayerRule(sourceType);
  return !!rule && rule.visualFrameSource;
}

export function getRestoreType(data: any): string {
  const sourceType = data.sourceType || data.type;
  if (data.restoreType) return data.restoreType;
  const rule = getLayerRule(sourceType) || getLayerRule(data.type);
  if (rule) return rule.restoreType;
  return data.type;
}

export function getReceiveCreateType(data: any): string {
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
