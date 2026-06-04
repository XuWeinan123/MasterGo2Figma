import { ImageAssetRecord, ImageAssetContext, ExportTransferState } from "../../shared/types";
import { state } from "./state";
import { describeError } from "../../shared/utils";
import { processBlendMode, finiteNumber } from "./serializers/universal";
import { streamExportFileToUI } from "./transferStream";

export function padNumber(value: number): string {
    const text = String(value);
    if (text.length >= 3) return text;
    return "000".slice(0, 3 - text.length) + text;
}

export function normalizeImageScaleModeForFigma(value: any): string {
    if (value === "FILL" || value === "FIT" || value === "CROP" || value === "TILE") return value;
    if (value === "STRETCH") return "FILL";
    if (value === "CENTER") return "FIT";
    return "FILL";
}

export function registerImageAsset(sourceRef: string): ImageAssetRecord {
    const context = state.activeImageAssetContext as ImageAssetContext;
    const existing = context.bySourceRef[sourceRef];
    if (existing) return existing;

    const index = context.assets.length + 1;
    const key = `image-${padNumber(index)}`;
    const fileName = `${key}.bin`;
    const asset: ImageAssetRecord = {
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

export function markMissingImageFill(fill: any, fileName: string, shouldCount = true) {
    fill.imageRef = fileName;
    fill.missingAsset = true;
    if (shouldCount && state.activeImageAssetContext) {
        state.activeImageAssetContext.missingImageAssetCount++;
    }
}

export function createImageFillJson(fill: any) {
    const result: any = {
        "blendMode": processBlendMode(fill.blendMode),
        "opacity": fill.alpha ?? 1,
        "type": "IMAGE",
        "scaleMode": normalizeImageScaleModeForFigma(fill.scaleMode),
        "visible": fill.isVisible ?? true
    };

    if (fill.filters) result.filters = fill.filters;
    if (fill.rotation !== undefined) result.rotation = finiteNumber(fill.rotation, 0);
    if (fill.ratio !== undefined) result.ratio = finiteNumber(fill.ratio, 1);

    const sourceRef = typeof fill.imageRef === "string" ? fill.imageRef : "";
    if (!sourceRef || !state.activeImageAssetContext) {
        markMissingImageFill(result, "missing-image");
        return result;
    }

    const asset = registerImageAsset(sourceRef);
    result.imageRef = asset.key;
    return result;
}

export function detectImageExtension(bytes: Uint8Array): string {
    if (bytes.length >= 8 &&
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
        return "png";
    }

    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
    if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "gif";
    if (bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x47 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return "webp";
    }

    return "bin";
}

export function markImageAssetMissing(asset: ImageAssetRecord, context: ImageAssetContext, reason: "read", error: any) {
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

export async function loadAndStreamImageAsset(asset: ImageAssetRecord, context: ImageAssetContext, transfer: ExportTransferState) {
    let bytes: Uint8Array | null = null;
    try {
        state.setExportDebugState({
            phase: "asset:get-image",
            file: asset.path,
            transferId: transfer.transferId,
            fileIndex: transfer.fileIndex,
            streamedBytes: transfer.streamedBytes
        });
        const image = mg.getImageByHref(asset.sourceRef);
        if (!image || typeof image.getBytesAsync !== "function") throw new Error("图片资源不可读取");

        state.setExportDebugState({
            phase: "asset:get-bytes",
            file: asset.path,
            transferId: transfer.transferId,
            fileIndex: transfer.fileIndex,
            streamedBytes: transfer.streamedBytes
        });
        bytes = await image.getBytesAsync();
        if (!bytes || bytes.length === 0) throw new Error("图片资源为空");
    } catch (error) {
        markImageAssetMissing(asset, context, "read", error);
        return;
    }

    const extension = detectImageExtension(bytes);
    asset.bytes = bytes;
    asset.fileName = `image-${padNumber(asset.index)}.${extension}`;
    asset.path = `assets/${asset.fileName}`;

    try {
        await streamExportFileToUI(transfer, {
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
}
