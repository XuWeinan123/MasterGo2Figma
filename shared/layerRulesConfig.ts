import { LayerConversionConfig } from "./types";

// Single source of truth for the layer-conversion rules shared by both plugins
// (SendToFigma export side and ReceiveFromMasterGo import side). Keeping one
// copy avoids the two definitions silently drifting apart.
export const LAYER_RULES_SCHEMA = "mastergo2figma.layer-conversion-rules.v1";

export const VALID_RECEIVE_CREATE_TYPES = [
    "VECTOR", "ELLIPSE", "RECTANGLE", "STAR", "LINE", "POLYGON",
    "TEXT", "SECTION", "SLICE", "FRAME", "GROUP", "CONNECTOR", "BOOLEAN_OPERATION"
];

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
