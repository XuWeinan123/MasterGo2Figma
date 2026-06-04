// Central tuning constants for the MasterGo export pipeline.
//
// Every value here is a deliberate "magic number" that used to live inline in
// transferStream.ts / nodeSerializer.ts. Collecting them in one named, documented
// place means each has a clear meaning and can be tuned without hunting through
// expressions. Adjust values here, not at the call sites.

// ---- Transfer & chunking (transferStream.ts) -------------------------------

/** Byte size of each binary chunk posted to the UI (images, byte-encoded text). 64 KiB trades postMessage round-trips against per-message memory. */
export const EXPORT_TRANSFER_CHUNK_SIZE = 64 * 1024;

/** Max characters per chunk when text is sent as a string instead of bytes. 4 KiB keeps each postMessage small. */
export const EXPORT_TEXT_CHUNK_CHAR_LIMIT = 4 * 1024;

/** Yield to the host event loop after this many posted chunks so the plugin UI stays responsive during big transfers. */
export const EXPORT_TRANSFER_YIELD_EVERY_CHUNKS = 32;

/** Yield to the host after streaming this many files, giving the bridge room to drain. */
export const EXPORT_FILE_YIELD_EVERY_FILES = 25;

/** Max layer records accumulated before a layer-chunk file is flushed. */
export const LAYER_CHUNK_MAX_RECORDS = 16;

/** Max accumulated bytes before a layer-chunk file is flushed. 64 KiB caps per-file memory. */
export const LAYER_CHUNK_MAX_BYTES = 64 * 1024;

/** A flushed layer chunk at or above this byte size is logged for diagnostics. */
export const LAYER_CHUNK_LOG_BYTES = 48 * 1024;

/** Also log a chunk flush on the first chunk and every Nth chunk thereafter (sampling, to avoid log spam). */
export const LAYER_CHUNK_LOG_EVERY = 50;

/** Soft target of layers per split package; a single page is segmented once a segment reaches this many layers. */
export const PAGE_SEGMENT_TARGET_LAYERS = 8000;

/** Yield to the host during the pre-scan after counting this many nodes. */
export const EXPORT_SCAN_YIELD_EVERY_NODES = 500;

/** Page index from which verbose per-node logging activates; 9999 effectively keeps it off in normal runs. */
export const DEBUG_LOGGING_PAGE_INDEX_START = 9999;

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

// ---- Stringify diagnostics (nodeSerializer.ts) -----------------------------
// Thresholds that only flag unusually heavy nodes for diagnostic logging; they
// do not change export behavior.

/** Log a stringify probe when a node has at least this many vector vertices or segments. */
export const STRINGIFY_PROBE_VERTEX_THRESHOLD = 1000;

/** Log a stringify probe when a node has at least this many vector regions. */
export const STRINGIFY_PROBE_REGION_THRESHOLD = 50;

/** Log a stringify probe when a node has at least this many children. */
export const STRINGIFY_PROBE_CHILD_THRESHOLD = 300;

/** Warn when a single serialized layer record reaches this byte size. */
export const STRINGIFY_RECORD_WARN_BYTES = 48 * 1024;
