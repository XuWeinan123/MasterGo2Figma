import { applyUniversalProperties } from "./appliers/universal";
import { applyTextProperties } from "./appliers/text";
import { applyConnectorProperties } from "./appliers/connector";

export async function applyProperties(node: any, data: any) {
    if (!node || !data) return;

    await applyUniversalProperties(node, data);

    if (node.type === "TEXT" && data.characters !== undefined) {
        await applyTextProperties(node, data);
    }

    if (node.type === "CONNECTOR") {
        applyConnectorProperties(node as ConnectorNode, data, true);
    }
}
