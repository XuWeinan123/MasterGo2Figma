// Central tuning constants for the MasterGo export pipeline.
//
// Every value here is a deliberate "magic number" that used to live inline in
// transferStream.ts / nodeSerializer.ts. Collecting them in one named, documented
// place means each has a clear meaning and can be tuned without hunting through
// expressions. Adjust values here, not at the call sites.

// ---- Transfer & chunking (transferStream.ts) -------------------------------

/** Byte size of each binary chunk posted to the UI (images, byte-encoded text). 64 KiB trades postMessage round-trips against per-message memory. */
export const EXPORT_TRANSFER_CHUNK_SIZE = 64 * 1024;

/**
 * Max characters per text chunk (layer JSON, manifest). UTF-8 encodes CJK at up
 * to 3 bytes/char, so 16K chars stays within ~48 KiB per message — the same
 * envelope as the proven 64 KiB binary chunks. Larger chunks mean 4-12x fewer
 * postMessage bridge round-trips (and relay-mode HTTP POSTs) per export.
 */
export const EXPORT_TEXT_CHUNK_CHAR_LIMIT = 16 * 1024;

/** Yield to the host event loop after this many posted chunks so the plugin UI stays responsive during big transfers. */
export const EXPORT_TRANSFER_YIELD_EVERY_CHUNKS = 32;

/** Yield to the host after streaming this many files, giving the bridge room to drain. */
export const EXPORT_FILE_YIELD_EVERY_FILES = 25;

/** Yield to the host after streaming this many image assets. Large assets already yield per-chunk inside streamExportFileToUI; a per-asset setTimeout(0) added seconds of pure idle on exports with many small images. */
export const EXPORT_ASSET_YIELD_EVERY_ASSETS = 8;

/** Max layer records accumulated before a layer-chunk file is flushed. */
export const LAYER_CHUNK_MAX_RECORDS = 16;

/** Max accumulated bytes before a layer-chunk file is flushed. 64 KiB caps per-file memory. */
export const LAYER_CHUNK_MAX_BYTES = 64 * 1024;

/** Soft target of layers per split package; a single page is segmented once a segment reaches this many layers. */
export const PAGE_SEGMENT_TARGET_LAYERS = 8000;

/** Yield to the host during the pre-scan after counting this many nodes. */
export const EXPORT_SCAN_YIELD_EVERY_NODES = 500;

/** Timeout (ms) waiting for the UI to acknowledge one streamed file before failing the transfer. */
export const EXPORT_FILE_ACK_TIMEOUT_MS = 60000;

/** Timeout (ms) waiting for the UI to acknowledge the whole transfer (zip build / relay completion). */
export const EXPORT_TRANSFER_ACK_TIMEOUT_MS = 120000;

// ---- SVG fallback thresholds (nodeSerializer.ts) ---------------------------
// A complex vector / boolean node is rasterized to inline SVG only when it is
// small enough on every axis. Above any of these limits we keep the editable
// vector network instead, because SVG export gets expensive and lossy at scale.

/** Max exportable subtree node count still eligible for SVG fallback. */
export const SVG_FALLBACK_MAX_NODES = 48;

/** Max bounding-box area (px²) still eligible for SVG fallback. */
export const SVG_FALLBACK_MAX_AREA = 64 * 1024;

/** Max width or height (px) still eligible for SVG fallback. */
export const SVG_FALLBACK_MAX_DIMENSION = 256;

/** Reject an SVG fallback whose generated markup exceeds this byte size. */
export const SVG_FALLBACK_MAX_BYTES = 64 * 1024;

/** Skip SVG fallback entirely once the whole document exceeds this node count (too expensive to rasterize). */
export const SVG_FALLBACK_MAX_DOCUMENT_NODES = 5000;

/** Warn when a single serialized layer record reaches this byte size. */
export const STRINGIFY_RECORD_WARN_BYTES = 48 * 1024;
