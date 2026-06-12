import { applyUniversalProperties } from "./appliers/universal";
import { applyTextProperties } from "./appliers/text";
import { applyConnectorProperties } from "./appliers/connector";
import { applyVectorNetwork } from "./appliers/vector";
import { normalizeMasterGoStrokeCapForFigma } from "../../shared/connectorUtils";
import { safeSet } from "../../shared/utils";

export async function applyProperties(node: any, data: any) {
    if (!node || !data) return;

    await applyUniversalProperties(node, data);

    if (node.type === "VECTOR" && data.vectorNetwork) {
        applyVectorNetwork(node as VectorNode, data.vectorNetwork, data);
        reapplyVectorStrokeGeometry(node as VectorNode, data);
    }

    if (node.type === "TEXT" && data.characters !== undefined) {
        await applyTextProperties(node, data);
    }

    if (node.type === "CONNECTOR") {
        applyConnectorProperties(node as ConnectorNode, data, true);
    }
}

function reapplyVectorStrokeGeometry(node: VectorNode, data: any) {
    const geometry = data && data.geometry;
    if (!geometry) return;

    if (geometry.strokeWeight !== undefined) safeSet(node, "strokeWeight", geometry.strokeWeight);
    if (geometry.strokeAlign) safeSet(node, "strokeAlign", geometry.strokeAlign);
    if (geometry.strokeJoin) safeSet(node, "strokeJoin", geometry.strokeJoin);
    if (geometry.dashPattern !== undefined) safeSet(node, "dashPattern", geometry.dashPattern);
    if (geometry.strokeCap && !data.connectorFallbackPolyline) {
        safeSet(node, "strokeCap", normalizeMasterGoStrokeCapForFigma(geometry.strokeCap));
    }
}
