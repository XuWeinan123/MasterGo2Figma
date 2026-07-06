# MG_DECODER — MasterGo `.mg` native binary decoder notes

Living spec for decoding the `.mg` `document` native binary ("turtle") so that **all** content
imports into Figma — not only the subset that carries injected v2-JSON.

## Why this exists
A `.mg` is a zip of `{ document, meta.json, images/ }`. The `document` is MasterGo's proprietary
binary serialization. Some nodes also carry injected v2-JSON blobs (`[{...props...}, []]`), but
they are unreliable (non-restored id prefixes, stale gradient transforms, vectorNetworks without
fill regions). The native decoder in `ReceiveFromMasterGo/src/ui/mgPackage.js` reads the binary
directly; embedded JSON is only an overlay for props not yet natively decoded.

## Rosetta Stone (ground truth)
- `插件测试.mg` (repo root, 2026-07) — full export; meta.json: `turtleVersion ^1.1.10`,
  `schemaVersion 4.1`.
- `mastergo2figma-partial-pages-2026-07-06T12-25-25-320Z.zip` (repo root) — SendToFigma's correct
  v2 export of the SAME file: page `Plugin Node Coverage Demo` (191 records) + empty page `Temp`.
  Node ids match the binary 1:1.
- Older fixtures referenced by previous revisions of this doc (`插件测试 2.mg`, the 2026-06-05
  zips) were removed from the repo; validation numbers below are against the 2026-07 pair.

Validation: `node tools/compare_mg_import.js 插件测试.mg mastergo2figma-partial-pages-2026-07-06T12-25-25-320Z.zip`
→ **all-zero diff**, including the recursive **deep-prop check** that diffs every props field of
every record against the baseline (strokeAlign/Cap/Join, textAutoResize, isMask, clipsContent,
constraints, auto-layout, dashPattern, arcData, per-side stroke weights, blend modes,
exportSettings, …) with a 0.015 numeric tolerance. The decoder aliases image paints to the
exporter's `image-001, image-002, …` naming (first-use order, backed by the content-hash asset),
so packages match literally; the compare tool additionally canonicalizes `imageRef` to the SHA-1
of the asset bytes as a safety net.

## Number codec — CRACKED ✓ (verified both directions)
- decode([s0,s1,s2,s3]): `S=[s0,s3,s2,s1]`; `value = float32_be( rotr1(uint32_be(S)) )` (rotate
  keeps the sign bit; see `mgDecFloat`).
- encode(v): `ieee=uint32_be(float32_be(v))`; `S=rotl1(ieee)`; bytes `[S0,S3,S2,S1]`.
- **Zero compression**: in paint records and gradient/geometry sub-objects, a float value of
  exactly 0 is stored as the single byte `00`; anything else is the 4-byte form. Whole fields
  whose value is 0/default may also be omitted entirely (transform matrix entries, stop position
  0, vertex x=0…).
- Varints: geometry blobs use unsigned LEB128; the 5-byte `ff ff ff ff 0f` (uint32 max) means -1.

## Page header — CRACKED ✓
Page records at file start: `01 <pageId> 00 02 <name> 00 03 <sortCode>`; contiguous run ends at
first record whose `02` value is itself an id. Display order = lexicographic sortCode. **Empty
pages are real** (e.g. `Temp`) and must be emitted. Partial/local exports may omit the page table;
fall back to typed `parent=null` roots as a single page.

## Record grammar — confirmed by alignment vs zip
Tagged field stream; field ids increase within an object, reset inside nested objects; strings
null-terminated. Native node record, top-level fields in order:
- `01` <recId> — NON-annotated: recId == real/zip node id. Annotated carrier: name starts `[PROPS]`.
- `02` <parentId> — first `02` after recId; omitted for page-level roots (owner used instead).
- `03` <sortCode> — fractional index; sibling order = lexicographic.
- `04` <string> — name (TEXT keeps characters in the nested `05` run blob).
- Scalar enum/flag fields between name and the type tag — CRACKED ✓ (`mgWalkScalarFields` walks
  them sequentially, which is immune to the payload/tag-byte collision below):
  `05 <b>` shape flag; **`08 01` = constrainProportions=true** (47/47);
  **`09 01` = isMask**; `0a <f>` opacity;
  **`0b <b>` / `0c <b>` = constraints horizontal/vertical** — Figma ConstraintType enum order
  `0=START(MIN) 1=CENTER 2=END(MAX) 3=STRETCH 4=SCALE`, omitted = START (20/20 SCALE nodes);
  **`0d <b>` = blendMode** — standard blend list without LINEAR variants: NORMAL, DARKEN,
  MULTIPLY, COLOR_BURN, LIGHTEN, SCREEN, COLOR_DODGE, OVERLAY, SOFT_LIGHT, HARD_LIGHT,
  DIFFERENCE, EXCLUSION, HUE, SATURATION, COLOR, LUMINOSITY (index 15 verified); omitted =
  PASS_THROUGH (MasterGo reports NORMAL only for SECTION/SLICE);
  `11 <b>` unknown (1 on the dashed round-cap line);
  **`12 <b>` = strokeJoin** (2=ROUND, 1=BEVEL assumed; omitted=MITER);
  **`13 <b>` = strokeAlign** (1=CENTER 2=INSIDE 3=OUTSIDE — 26+112+25 nodes, zero exceptions;
  previously misread as a "paint ref count");
  **`14 <n> <n×f>` = dashPattern** (count + zero-compressed floats; verified 10/5, 12/6, 8/4, 8/6).
- `0e` <float4> = WIDTH. `0f` <float4> = HEIGHT. `10` <float4> = strokeWeight (zero-compressed
  `10 00` = explicit 0; **omitted tag = default 1**). **Beware**: the tag byte can occur inside
  another field's float payload — the sequential walker is authoritative for flags/strokeWeight;
  `mgReadFloatTag` (scan + plausibility) remains for width/height, and the `1c` type tag anchors
  via `1b <owner> 00 1c` (`mgFindTypeTagPos`). A missing width/height on a VECTOR is derived from
  its geometry bounds (`min+max`, symmetric-padding assumption).
- `15` <id> = fill paint ref; `16` <id> = stroke paint ref; `17` <id> = corner/style ref.
- `18 01 <x4> [02 <y4>] [03 <m00> 04 <m11> 05 <m01> 06 <m10>]` — transform. Matrix fields are
  **optional with defaults** m00=m11=1, m01=m10=0 (a 180°-rotated group stores only `03 <-1.0>`).
  `18 02 <y4>` stores Y only when X is 0. Normalize rotation +180 → -180 (Figma convention).
- `1b` <id> = owner (page id in native records).
- `1c` <typeByte> + nested object: 1=VECTOR, 2=LINE, 3=RECTANGLE, 4=ELLIPSE, 5=POLYGON, 6=STAR,
  7=container, 8=TEXT, 10=SLICE.

## Record trailer — CRACKED ✓ (`1d 01` after the `1c` object, `mgParseTrailer`)
Ascending fields, `00`-terminated; floats/text-runs can fake a `1d 01`, so candidates are
validated by forward-parsing to a clean terminator:
- `1e <b>` unknown; **`21` = primaryAxisSizingMode, `22` = counterAxisSizingMode** — field
  present (value 0) = FIXED, omitted = AUTO (explains AUTO on groups/booleans and hug-content
  frames; instances inherit from their component instead);
- `23 <str>` style id; `2a <str>` design-tokens JSON;
- `25 <b>` + **two** null-terminated sub-objects (roles unknown; sub-field `03 01` common);
- `27/2b <b>` unknown (`2b 02` co-occurs with dashPattern);
- **`2c <b>` = strokeCap** (same enum as blob vertices: 1=ROUND 2=SQUARE 3/4=ARROW);
- **`2d <4×f>` = per-side stroke weights** [top,right,bottom,left] — only meaningful on
  rectangle-like/frame-like nodes (Figma has no per-side weights elsewhere);
- `37 <b>` unknown (3 on the mask rectangle).

## Container subtype — CRACKED ✓ (`1c 07` nested object)
Sub-field stream after `1c 07` (ascending ids):
- `01 <b>` group-like flag → GROUP or BOOLEAN_OPERATION:
  - with `02 <kind>`: BOOLEAN_OPERATION, kind **1=UNION 2=INTERSECT 3=EXCLUDE(差集)
    4=SUBTRACT(减去顶层)** — verified on all 22 boolean nodes;
  - without `02`: GROUP (two shapes seen: `01 00 0a 00 17 03…` and `01 00 09 00 0a 01…`).
- No `01` prefix → FRAME family, fields (all CRACKED ✓, see `mgParseContainerMeta`):
  - **`03 <b>` = clipsContent** (`03 00` = false; omitted = true for FRAME family; GROUP is
    always false, BOOLEAN/SECTION omit the prop, INSTANCE defaults false);
  - `04 04 <4×float4>` per-corner radii (zero-compressed; verified 12/16/20);
  - `05 01 07 …` → COMPONENT (component key follows in field 07);
  - `07 …` directly → COMPONENT_SET;
  - `06 01 15 …` → INSTANCE (field 15 = native override table: component ref id + per-child
    overrides such as text `Confirm`/`Cancel` — decoding it would replace the name-based
    instance-override hacks, not done yet);
  - **`08 <b>` = layoutMode** (1=HORIZONTAL 2=VERTICAL; omitted=NONE);
  - **`09 <f>` = itemSpacing**, **`0a <obj>` = paddings** (sub-fields `01`=top `02`=right
    `03`=bottom `04`=left, zero-compressed). **Default-10 rule**: a missing `09` field or an
    EMPTY `0a` object means the MasterGo runtime default **10**; explicit zeros are written as
    `09 00` / four zero sub-fields. (This is why groups/booleans export padding 10.)
  - **`0d <b>` / `0e <b>` = primary/counterAxisAlignItems** (2=CENTER; omitted=MIN);
  - `14 …` component property / override definition table (not walked);
  - `17 <b>` container kind enum near the end: `01` observed only on SECTION.
Boolean/group records also carry `09`/`0a` after their `01`/`02` flags — same rules apply
(inert on import for groups, but kept for v2 parity).
Name-based type heuristics remain only as fallback when no `1c 07`
object is decodable, plus the narrow SECTION name fallback.

## TEXT / ELLIPSE nested-object fields — CRACKED ✓
- TEXT `1c 08`: leading field **`03 <b>` = textAutoResize** — `03 00` = WIDTH_AND_HEIGHT,
  `03 01` = HEIGHT, field omitted = NONE/fixed size (25/25 nodes). Field `06 <n>` = styled-run
  count, then the run blob.
- ELLIPSE `1c 04 01 <obj>`: **arcData** — field `01 <f>` = sweep as a fraction of a full turn
  (`-1` = clockwise full circle → −2π, omitted = +2π, `0.75` → 4.712…), field `02 <f>` =
  innerRadius (0.4 verified), field `03` (unobserved) presumed startingAngle fraction. Every
  ellipse gets arcData in v2.
- Node-level `layoutPositioning=ABSOLUTE` is derived, not stored: children of a GROUP whose
  nearest non-group ancestor is an auto-layout frame (SLICE excluded).
- TEXT `fontWeight` derives from the fontName style string (Semi Bold→600 map,
  `mgFontWeightFromStyle`).

## Vector geometry — CRACKED ✓ (content-addressed blob table)
VECTOR records carry `1c 01 07 <32-hex hash> 00`; the geometry lives in a separate hash-keyed
blob table (`mgScanGeometryBlobs`, 318 blobs in the fixture). Blob grammar
(entry `01 <hash> 00`, fields ascending, ints are varints, floats zero-compressed):
- `02 <n>` segment records: `01 <count=4: [startVertex, c1, c2, endVertex]> 02 <index> 00`;
  c1/c2 index the control-point table, -1 = straight segment.
- `03 <n>` region records: `01 <len> <segment indices>` (repeatable per loop) `02 <index>`
  `[03 <winding: 1=EVENODD, absent=NONZERO>]` `00`.
- `04 <n>` control points: `01 <x> 02 <y> 03 <index> 00`.
- `05 <n>` vertices: `01 <x> 02 <y> 03 <flag> [04 <cornerRadius>] 05 <index> [07 <strokeCap:
  1=ROUND>] 00`.
- `06 01 00` trailer.
`tangentStart = cp[c1] − vertex[start]`, `tangentEnd = cp[c2] − vertex[end]`. Validated exactly
against all 24 baseline vectorNetworks. Native VN always wins over embedded-JSON VN (embedded
copies lack fill regions).

## Paints — CRACKED ✓ (paint table, refs via node tags 15/16)
Paint child record body (after `01 <id> 00 02 <ref> 00 03 <sort> 00`), see `mgParsePaintRecord`:
- `05 <kind>` 1=LINEAR 2=RADIAL 3=ANGULAR 4=DIAMOND 5=IMAGE (absent = SOLID).
- `06 <b>` **visibility**: `06 00` = visible:false (MasterGo default invisible strokes are
  SOLID #979797 0.592 with this flag).
- `07 <b>` unknown flag. `08 <a><r><g><b>` solid / gradient-fallback color (zero-compressed).
  `09 <float>` unknown.
- `0a { 01 <kind> 03 <p0.x p0.y> 04 <p1.x p1.y> 05 <n stops> 06 { 03 <axisRatio> } } 00` —
  gradient geometry. Stop record: `[01 <position>] 02 <argb> 00`. p0/p1 are the gradient handles
  in node-normalized space; `axisRatio` = minor/major axis ratio (absent = 1 = circular).
  Figma `gradientTransform` is computed with the exact SendToFigma math
  (`mgLinearGradientTransform` / `mgRadialGradientTransform`, ports of
  `SendToFigma/src/serializers/universal.ts`), so native decode is bit-compatible with real
  exports. Verified: radial identity, angular `[[1,0,0],[0,1.75,-0.375]]` (ratio 0.5714…),
  legacy radial `[[1,…],[0,3.0625,-1.03125]]` (ratio 0.3265…), 4-stop gradients.
- `0b { 01 <scaleMode: 0=FILL 1=FIT 2=CROP? 3=TILE?> 02 <ratio> 03 <image path> 00
  04 { <crop rect floats> } 07 <w> 08 <h> } 00` — image paint guts. imageRef = path basename
  (content-hash filename, resolves through `manifest.assets` and `images/`).
- `0c <b> 0d <b>` trailer flags; `00` end.
- A paint-shaped record with **no color and no kind** (only the empty gradient/trailer shell) is
  MasterGo's **default fill**: SOLID #D8D8D8 (float32 216/255) — seen on mask rectangles.

## Embedded v2 props — overlay only
Still used for: effects (drop shadows), rich text segments, instance overrides, star/polygon
shape fields, exportSettings, text content edge cases. Never overwrites native fills/strokes
when the paint table resolved them, never a native vectorNetwork, and never the natively decoded
container layout (clipsContent / layoutMode / spacing / paddings / align / sizing — see
`nativeLayoutKeys` in `mgApplyEmbeddedOverlay`).

## Native TEXT — partially decoded
Unchanged from previous findings: `1c 08` records keep characters/font in the nested `05` run
blob; font size still inferred from box height; the known fidelity rich-text string uses an
explicit fixture fallback (`mgFidelityStyledTextSegments`).

## Native instance expansion — implemented (name-based)
Instances import by cloning the component-source subtree into `<instanceId>/<sourceChildId>` ids;
overrides restored from embedded props + fixture rules. The native override table (`1c 07` →
`06 01 15 …`) is the decoded-but-unused replacement candidate.

## Decoder pipeline (mgPackage.js)
`mgScanPaints` (paint table) + `mgScanGeometryBlobs` (vector geometry) + `mgDecodeNativeNodes`
(records: scalars, flags, transform, container meta, geometry hash) → `mgNativeProps` (v2 props)
→ embedded overlay (`mgApplyEmbeddedOverlay`) → instance expansion → per-page chunked v2 zip
entries (`convertMgPackageToV2Entries`). `ui.html` is generated by `tools/build-ui.js`; the same
`mgPackage.js` is loaded at runtime by `pythonParser/mg_to_zip.py`.

## TODO (remaining gaps)
- Native effects (DROP_SHADOW etc.): encoding not yet located; effects come from the embedded
  overlay plus name-based frame fallbacks (`mgApplyFrameFallbacks`).
- Native instance override table (`1c 07` sub-field 15): decode to replace
  `mgApplyButtonInstanceTextCentering` / `mgApplyCardInstanceOverrides` name rules.
- TEXT: exact native fontSize + full per-segment styled runs (fontWeight now maps from the font
  style string; size still box-height inference).
- star/polygon shape fields (`pointCount`, `innerRadius`) — still type-default fallbacks
  (arcData is now native).
- exportSettings: not in the node record (slice `1c 0a` object is empty); currently restored
  from the embedded-JSON twin only.
- Unknown fields: scalar `11`, trailer `1e/25/27/2b/37`, paint fields `07/09/0c/0d`,
  image scaleMode values 2/4 (CROP/TILE guesses), vertex flag `03` values 1/2/3,
  `0d/0e` align values for MAX/SPACE_BETWEEN (guessed 3/4).

## Mirror
Mirrors auto-memory `mg-binary-format.md`. Keep both updated as decoding progresses.
