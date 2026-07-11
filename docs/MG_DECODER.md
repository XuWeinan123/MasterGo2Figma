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
- `新文件.mg` (repo root, 2026-07-09) — a real-world UI design (Tesla-style driving app), exported
  in the **share/partial** form (see the dedicated section below): component template trees +
  shallow instance-override records, NO embedded v2-JSON at all.
- `mastergo2figma-partial-pages-2026-07-09T14-27-10-967Z.zip` — SendToFigma's v2 export of the
  SAME file: page `页面 1`, 1388 records (14 plain roots + 1374 slash-id instance children).
- Older fixtures (`插件测试.mg` + the 2026-07-06 zip, and the 2026-06-05 generation before that)
  were removed from the repo as test sets rotated; their findings remain folded into this doc.

Validation: `node tools/compare_mg_import.js 新文件.mg mastergo2figma-partial-pages-2026-07-09T14-27-10-967Z.zip`.
State (2026-07-10): 1388/1388 expected records present (0 missing, 0 type / 0 parent mismatches);
deep-prop mismatches down from 11063 (first run after structure decode) to ~935, all in the
known-residual buckets listed under TODO. The 2026-07-06 full-export fixture reached a true
all-zero deep diff before rotation. The decoder aliases image paints to the exporter's
`image-001, image-002, …` naming; the compare tool additionally canonicalizes `imageRef` to the
SHA-1 of the asset bytes as a safety net.

## Share/partial export form — CRACKED ✓ (2026-07-09 fixture)
MasterGo's share/partial `.mg` differs structurally from full editor exports:
- **Page ids are short tokens** (`M`), not `n:n`; page records gain a `09 01 00 04 80 10` tail.
- **No embedded v2-JSON at all** — every property must decode natively.
- **Component template trees** are stored once. Component-master roots have NO parent field and
  NO sort code: marker shape `01 <id> 00 04 <name>` (a second marker regex catches these; their
  presence = share mode, `mgShareModeActive`).
- **Instances are shallow override records** with slash-composed ids (`2:1499/2:0907`): only the
  overridden fields are stored (size, transform, text chars…). `1a <id>` names the component the
  instance mirrors; the container object's `06 01 0f <id>` names the template child it overrides.
  Non-overridden children have NO record and must be synthesized from the template
  (`mgExpandTemplateInstances`): geometry = template × the instance **scale factor** (trailer
  tag `26`, an ABSOLUTE accumulated float; absent = unscaled). Size-like scalars (strokeWeight,
  corners, fontSize, dash, effect radii, VN coordinates) scale the same way — but only values
  INHERITED from the template; values read from a node's own record are final.
- **Component trees contain their own nested-instance override records** (`2:0748/2:0018`),
  which take precedence over the raw template child during expansion.
- Slot-positional fields (constraints, visibility) inherit from the template CHILD (the id's
  last segment); visual fields (paints, font, caps) follow the `1a` component chain.
- Missing spacing/padding fields mean **0** here (full editor exports mean 10).
- Booleans inside instances export as childless leaves with an empty vectorNetwork (residual:
  the exact rule for which operand subtrees are kept is still undetermined).

Fields cracked with this fixture (all in `mgWalkScalarFields` / record grammar below):
- scalar `07 <b>` = **visible** (0 = hidden); scalar `0a <f>` = **node opacity**;
- scalar `11 <b>` = **strokeCap** (1=ROUND; the trailer `2c` field is a second location);
- **constraints corrected**: `0b` = VERTICAL, `0c` = HORIZONTAL, enum
  `0=START 1=END 2=STARTANDEND 3=CENTER 4=SCALE` (the old fixture's symmetric SCALE/SCALE
  samples could not tell order or values apart);
- scalar `19 <varint>` = flags (skip; multi-byte LEB128);
- TEXT object fields `01`/`02` = textAlignHorizontal (2=CENTER 1=RIGHT 3=JUSTIFIED) /
  textAlignVertical (1=CENTER 2=BOTTOM); the run's `03 <id>` (followed by the `05` glyph table)
  references the **text style table**: entries `01 <id> 00 05 <b> 03 <PostScript name> 00
  04 <fontSize> 05 <lineHeight px>` (`mgScanFontStyles`; PostScript name splits into
  family/style, style camel-case → spaced);
- **effect registry** via node tag `17` (`mgScanEffects`): child records
  `05 <kind: 1=DROP_SHADOW 2=LAYER_BLUR> 08 <argb> 09 <radius> 0a <offset.x> 0b <offset.y>
  0c <spread> 0d/0e <flags>` (floats zero-compressed; omitted offset = 0). Tag 17 doubles as the
  legacy corner-style ref in full exports — only treat as corner when it resolves to no effects;
- paint records: `09 <f>` = paint **opacity**; gradients may omit the handle fields
  (default = vertical top→bottom); image scaleMode enum corrected to `2=TILE 3=CROP`;
- geometry-blob region loops: ONE int array with `-1` (ff ff ff ff 0f) separating loops.

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
    `03`=bottom `04`=left, zero-compressed). **Default-10 rule**: a missing `09` field, an
    EMPTY `0a` object, or a **wholly absent `0a` object** all mean the omitted-field default —
    MasterGo runtime default **10** in full editor exports, **0** on share-export
    template/instance nodes (`missingDefault` in `mgNativeProps`). Explicit zeros are written as
    `09 00` / four zero sub-fields. (This is why groups/booleans export padding 10.)
    Cross-set evidence for the absent-`0a` spelling: 0710-2 (full export) plain GROUP/BOOLEAN
    records omit `0a` and the baseline says 10 (269 nodes); 0710-1's absent-`0a` nodes are all
    template/instance children and the baseline says 0 — both fall out of the same
    `paddingsMissing` funnel. Before 2026-07-10 the absent case wrote nothing (restored as 0).
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

**Point floats are zero-compressed — the code must NOT read fixed 4 bytes.** The grammar note
above always said so, but `mgDecodeGeometryBlob` read `float4()` until 2026-07-10: any vertex or
control point with x/y/cornerRadius = 0 (`00`, one byte) made the reader swallow the next 3 bytes
and derail the rest of the blob. 测试集 0710-2 decoded only 7/133 blobs that way — all 431
VECTORs lost (420) or corrupted (11, garbage tangents) their vectorNetwork; with zero-compressed
reads all 133 decode. The two sets that "worked" (插件测试/0710-1: 468+94 blobs) never hit the
bug because their exporter omits zero-valued point fields entirely instead of writing `00`;
both spellings decode identically under the zero-compressed reader (A/B verified byte-for-byte).

**The canonical empty blob is a real value, not a failure.** Full exports store one blob whose
hash is `D41D8CD98F00B204E9800998ECF8427E` (MD5 of "") with all four sections present and empty
(`02 00 03 00 04 00 05 00 06 01 00`). Flattened Boolean-result leaves (Union/Subtract/Intersect
names, 0.0049×0.0049 size) reference it, and the ZIP baseline carries an empty
`{segments:[],vertices:[],regions:[]}` for them — `mgDecodeGeometryBlob` returns that empty VN
for a clean four-section-zero parse ending at the `06` trailer. Only a derailed parse is null.

## Paints — CRACKED ✓ (paint table, refs via node tags 15/16)
Paint child record body (after `01 <id> 00 02 <ref> 00 03 <sort> 00`), see `mgParsePaintRecord`:
- `05 <kind>` 1=LINEAR 2=RADIAL 3=ANGULAR 4=DIAMOND 5=IMAGE (absent = SOLID).
- `06 <b>` **visibility**: `06 00` = visible:false (MasterGo default invisible strokes are
  SOLID #979797 0.592 with this flag).
- `07 <b>` unknown flag. `08 <a><r><g><b>` solid / gradient-fallback color (zero-compressed).
  `09 <float>` unknown.
- `0a { 01 <kind> 03 <p0.x p0.y> 04 <p1.x p1.y> 05 <n stops> 06 { … } } 00` —
  gradient geometry. Stop record: `[01 <position>] 02 <argb> 00`. p0/p1 are the gradient handles
  in node-normalized space. The `06` sub-object has **two spellings**:
  - **Bare `06 { 03 <scalar> }`** (share exports): the scalar encodes the Figma minor/major
    handle ratio in one of two observed forms — stored directly (2026-07-10 `插件测试.mg`:
    handles (0.5,0.5)→(1,0.5), scalar < 1, needed ratio == scalar exactly — cross-tabled by
    inverting the baseline-zip `gradientTransform` per sample) or as `2 × |p1 − p0| / ratio`
    (the older non-square samples frozen in `tools/tests/mgPackage.test.js`: |p1−p0| ≠ 0.5,
    scalar > 1). `mgRadialAxisRatio` takes `min(scalar, 2 × |p1 − p0| / scalar)`, which
    reproduces all seven known answers; both forms agree on the circular scalar=1 case.
    Absent/0 = circular. A future bare-03 sample with a true ratio > 1 would be ambiguous —
    re-cross-table if one appears.
  - **Extended `06 { 01 <f> 02 <f> 03 <scalar> 04 <f> 05 <f> 06 <f> }`** (测试集 0710-2 full
    export): fields 01/02/04/05 are ellipse-frame floats (unused), field `06` numerically equals
    `2 × |p1 − p0|`, and the ratio is the pure division **`field06 / field03`** — no min()
    disambiguation (known-answer verified against all 16 baseline radial transforms; the min()
    would have picked the wrong branch for every one, e.g. needed 3.5696 vs scalar 0.4117).
    Before 2026-07-10 the parser rejected the unknown 01 tag and **dropped the whole paint**,
    which is why 0710-2 radial fills vanished while linear gradients survived.
  Figma `gradientTransform` is computed with the exact SendToFigma math
  (`mgLinearGradientTransform` / `mgRadialGradientTransform`, ports of
  `SendToFigma/src/serializers/universal.ts`), so native decode is bit-compatible with real
  exports.
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

## Native TEXT — CRACKED ✓ (font runs + style table, 2026-07-10)

### Font-run list (`1c 08` object, `mgParseFontRuns`)
```
[01 <alignH> 02 <alignV> 03 <autoResize>]   one-byte values < 0x10
06 <runCount>
runCount × ( 01 <sortId> 00                 fractional-index sort code ("a0", "a7", …)
             02 <run text, UTF-8> 00
             03 <styleRef> 00               → text style table entry
             05 <glyphCount> <glyphCount × 2 zero-floats>     per-glyph x/y
             06 01 <"Family/Style/Version …"> 00              font string
             07 <glyphCount> <glyphCount × (00 <LEB128 glyphId>)> 00 )
[08 <b>]
09 <count> color runs: [01 <start>] 02 <end> 03 <paintRef> 00  (byte offsets)
[0a <defaultStyleRef> 00]
```
- Runs are stored in **arbitrary order**; sort by `sortId` and concatenate the texts to get
  `characters` (fixes the old first-`02`-string heuristic that could grab a mid-text run —
  "underlined" instead of the full fidelity sentence).
- Color runs (`09`, parsed by `mgParseTextRuns`) segment the text **independently** of font
  runs; their `paintRef` resolves through the ordinary paint table. Figma
  `styledTextSegments` = split at the union of font-run and color-run boundaries; per-segment
  font/size/decoration/lineHeight come from the font run's style entry, fills from the color
  run's paints. Validated exactly against the baseline's 9-segment fidelity node (the old
  name-keyed `mgFidelityStyledTextSegments` fixture is deleted).
- Glyph tables consume strictly sequentially (zero-floats are 1 byte for 0, else 4); any
  structural violation aborts the parser and falls back to the legacy heuristics.
- Caveats: color-run start/end offsets are single bytes — texts > 255 UTF-16 units are
  unverified; CJK run offsets assumed UTF-16 (only ASCII multi-run samples exist so far).

### Text style table (`mgScanFontStyles`)
Entries (interleaved with compact non-font shells `05 <b> 00 00`):
```
01 <id> 00 05 <kind=3> [01 <decoration: 1=UNDERLINE, 2=STRIKETHROUGH?>]
03 <family> 00 [04 <fontSize>] [05 <lineHeight, -1 = AUTO>]
[06 <b>] [0b <b>] [0a <textCase: 1=UPPER 2=LOWER>]
[0c <PostScript name> 00] [0e <float, -1 = default; suspected letterSpacing>]
[12 <style name "Bold"/"SemiBold"/…> 00] [13 …] 00
```
- **`0c`/`12` carry the real font style** — the `03` family alone ("Inter") is what made every
  share-export Bold/SemiBold header import as Regular. Resolution order in `mgNativeProps`
  (`mgFontNameFromStyleEntry`): entry styleName (`12`) → dash-style psName (`0c`, or the legacy
  full-export family slot) → record font string → Regular.
- **`lineHeight = -1` is the AUTO sentinel** (twisted bytes `7f 01 00 00`), not a pixel value.
- The old scanner regex required `05 <b> 03 …` and silently dropped entries carrying the
  decoration byte (`05 03 01 01 03 …`) — the underline style entry was invisible, which is why
  the fidelity node needed a fixture. Sequential field consumption only; unknown tags stop the
  walk and keep whatever parsed (e.g. AlibabaPuHuiTi entries with an `08` field keep their
  family-only fontName).
- letterSpacing value is not decoded yet: field `0e` is -1 on every sample; the importer emits
  `{ value: 0, unit: "PERCENT" }` (previously hardcoded to PIXELS at node level — wrong unit).
- fontSize still falls back to the box-height guess when a node has no style ref.

## Native instance expansion — template chain implemented
Share-export instances expand from tag `0x1a` template refs into
`<instanceId>/<sourceChildId>` ids. Sparse scalar presence, visibility, transform-matrix
inheritance, absolute tag `0x26` scale, Boolean leaf pruning, and evidenced GROUP/Boolean rebasing
are native. The old full-export button/card fallback remains name-based until the container
override table (`1c 07` → `06 01 15 …`) is fully typed and regression-tested — but the button
centering shift is now gated: it only moves children still sitting at their template x
(`mgApplyButtonInstanceTextCentering`). Shallow share-export override records store the
already-reflowed position; shifting those again double-applies the centered-auto-layout delta
(label +3.5 bug). Children without an override record keep the template x and still need it.
Explicit-zero sizes are respected during vector decode: a hairline VECTOR stores width `0e 00`
(true 0), and the vn-bounds size fallback now fires only when the axis field is absent
(`hasExplicitW/H`), not when it is an explicit 0.

## Decoder pipeline (mgPackage.js)
`mgScanPaints` (paint table) + `mgScanGeometryBlobs` (vector geometry) + `mgDecodeNativeNodes`
(records: scalars, flags, transform, container meta, geometry hash) → `mgNativeProps` (v2 props)
→ embedded overlay (`mgApplyEmbeddedOverlay`) → instance expansion → per-page chunked v2 zip
entries (`convertMgPackageToV2Entries`). Direct `.mg` conversion appends `_mg` to every restored
page name (without duplicating an existing suffix), so it remains distinguishable from a v2 zip
baseline after import. `ui.html` is generated by `tools/build-ui.js`; the same
`mgPackage.js` is loaded at runtime by `pythonParser/mg_to_zip.py`.

## TODO (remaining gaps)

### 2026-07 share-export parity checkpoint

- Scalar fields are now consumed in record order through `0x1b`; the parser
  preserves field presence, the native transform matrix, and the `0x19` LEB128
  override mask. Never use a tag regex in this range because float payloads
  naturally contain tag-like bytes.
- A raw `VECTOR` that overrides a `BOOLEAN_OPERATION` template slot is a
  flattened instance leaf. It remains a childless VECTOR with an empty vector
  network; its template operand subtree must not be emitted. A shallow leaf
  dimension matching the slot's natural dimension is multiplied by the absolute
  `tag 0x26` scale; a dimension already matching `slot × scale` remains final.
- Missing padding/itemSpacing is `10` on ordinary native page nodes and `0`
  only for template-derived/shallow share nodes. These are distinct semantics.
Current fresh-fixture result: 1388/1388 records; zero missing/extra/type/parent/index/child-order,
paint/effect/text/font/vector-network mismatches. The remaining comparator output is 40 geometry,
27 transform, and 129 deep-property lines; every deep mismatch is under `layout`.

- 32 geometry records are `WIDTH_AND_HEIGHT` text or GROUP/FRAME bounds derived from those text
  metrics. The importer loads Montserrat and lets Figma compute the live text size; the binary
  package comparator cannot reproduce Figma's font shaper in Node.
- Seven records are one repeated nested Boolean family where Figma and MasterGo choose different
  1×1 fallback origins after an empty vector leaf. No stored native scalar or reusable structural
  formula has been found; do not add node-name/id constants.
- One residual GROUP size is also derived from live text metrics.
- Full-export era gaps that still stand: native instance override table (`1c 07` sub-field 15)
  for the old fixtures' name-rule hacks; star/polygon `pointCount`/`innerRadius`;
  exportSettings (absent from node records; embedded-JSON twin only).
- Unknown fields: trailer `1e/25/27/2b/37`, paint fields `07/0c/0d`, vertex flag `03` values,
  `0d/0e` align values for MAX/SPACE_BETWEEN (guessed 3/4), scalar `19` flag-bit meanings,
  text-style entry fields `06/0b/13` (`13` observed as a `{02 <varint> 06 <varint>}` sub-object
  with identical timestamp-like values across files — metadata, not style), TEXT-object leading
  `08 <b>`, run glyph tables' float semantics (skipped, not used).
- **`0e` is NOT letterSpacing — hypothesis disproven 2026-07-10.** 插件测试.mg carries `0e`
  values 10–134 on full font entries while its baseline letterSpacing is `{0, PERCENT}` on every
  text; 0710-2 carries `0e = -1` everywhere while its baseline is `{0, PIXELS}`. The
  letterSpacing *unit* has no per-entry or per-node discriminator in any known sample (style
  entries byte-identical across the two expectations); the residual 142 unit-only diffs on
  0710-2 are visually nil (0% ≡ 0px) and are left unfixed rather than keyed on a file-level
  version guess.

### 2026-07-10 — text/gradient parity pass (插件测试.mg fixture)
`插件测试.mg` vs `mastergo2figma-partial-pages-2026-07-10T10-06-04-636Z.zip`: **all comparator
categories 0** (191/191 records, deep-prop recursive diff included). Cracked this pass: text
style table `0c/12` psName/styleName + decoration byte + lineHeight `-1 = AUTO`; font-run list
grammar (sortId/text/styleRef/fontString per run); generic styledTextSegments from font-run ×
color-run boundary union (fixture fallback deleted); gradient `06/03` ratio unified as
`min(scalar, 2×|p1−p0|/scalar)` across both observed encodings; explicit-zero hairline width;
template-x-gated button centering shift.

### 2026-07-10 — full-export vector/gradient/padding pass (测试集 0/1/2 harness)
Three-set regression harness (`测试集/{0,1,2}` mg+zip pairs). Cracked this pass, all verified
byte-identical on sets 0/1 before landing:
- geometry-blob point floats are zero-compressed (fix: 7/133 → 132/133 blobs on 0710-2; sets
  0/1 A/B-identical because their exporter omits zero fields instead);
- canonical MD5-of-"" empty blob decodes to an empty vectorNetwork (the 43 flattened
  Boolean-result leaves) — 0710-2 vectorNetwork mismatches 431 → 0;
- radial-gradient extended `06` sub-object (fields 01–06, ratio = `06/03` exact) — paint
  mismatches 16 → 0, radial fills no longer dropped;
- wholly absent `0a` padding object funnels into the same `paddingsMissing` default rule —
  1076 padding diffs → 0.
Result: set 0 all-zero (unchanged), set 1 unchanged (45/32/299 pre-existing geometry/transform
family), set 2 deep-prop 3572 → 151. The 151: 142 letterSpacing.unit (visually nil, see above)
+ 9 sub-pixel Group/Subtract/waypoint sizes from the documented live-font/Boolean runtime
derivation family.

## Mirror
Mirrors auto-memory `mg-binary-format.md`. Keep both updated as decoding progresses.
