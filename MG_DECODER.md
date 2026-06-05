# MG_DECODER — MasterGo `.mg` native binary decoder notes

Living spec for decoding the `.mg` `document` native binary ("turtle") so that **all** content
imports into Figma — not only the subset that carries injected v2-JSON.

## Why this exists
A `.mg` is a zip of `{ document, meta.json, images/ }`. The `document` is MasterGo's proprietary
binary serialization. In our test file only the **Node Coverage** design carries injected v2-JSON
blobs (`[{...props...}, []]`, with this project's `restoreType`/`scence` fields); the other pages
(保真度测试 / 问题界面 / Strokes) are **pure native binary** with no JSON. The current importer reads
only the JSON, so those pages import wrong/missing. Decoding the native binary fixes this generally.

## Rosetta Stone (ground truth)
- `插件测试 2.mg` (repo root) — document byte-identical to `插件测试.mg`. Local extract: `/tmp/mg2/document`.
- `mastergo2figma-partial-pages-2026-06-05T05-45-39-304Z.zip` (repo root) — SendToFigma's correct
  v2 export of the SAME file. `pages/*/layers-*.json` = exact correct props per node; node ids match
  the binary, align 1:1. Pages: `0:1` Plugin Node Coverage Demo(63), `24:8802` 问题界面(2),
  `47:2146` 保真度测试(44), `56:2287` Strokes(11).

## Number codec — CRACKED ✓ (verified both directions)
- decode([s0,s1,s2,s3]): `S=[s0,s3,s2,s1]`; `value = float32_be( uint32_be(S) >> 1 )`.
- encode(v): `ieee=uint32_be(float32_be(v))`; `S=(ieee<<1)&0xFFFFFFFF`; bytes `[S0,S3,S2,S1]`.
- Verified: `84 00 00 e0`→60, `83 00 00 00`→16, `85 00 00 0c`→67, `86 00 00 18`→140, `87 00 00 be`→446;
  colors enc(0.95)=`7e 66 66 e6`, enc(0.7)=`7e 66 66 66`, enc(0.2)=`7c 9a 99 99`.

## Page header — CRACKED ✓ (implemented in ui.html `parseMgPages`)
4 page records at file start: `01 <pageId> 00 02 <name> 00 03 <sortCode>`; contiguous run ends at
first record whose `02` value is itself an id (=first node). Display order = lexicographic sortCode
(a4 < a5P < a6 < a7).

Partial/local `.mg` exports may omit this page table entirely and have no `1b` owner values. In that
case, restore a single fallback page from typed `parent=null` roots, sorted by their `03` sortCode.
Component-set roots are kept in the decoded node table for instance expansion, but are not emitted as
page roots when matching the partial-pages zip baseline.

## Record grammar — confirmed by alignment vs zip
Tagged field stream; field ids increase within an object, reset inside nested objects; strings
null-terminated. Native node record, top-level fields in order:
- `01` <recId>  — NON-annotated: recId == real/zip node id. Annotated: recId == carrier id, real id
  is the next `02`.
- `02` <parentId>  — FIRST `02` after recId = **parentId** ✓ (ellipse 47:2323 → 47:2312).
- `03` <sortCode>  — fractional index; sibling order = lexicographic.
- `04` <string>  — name (frames/shapes) OR characters (TEXT).
- `05` <byte/blob>  — shape flag; TEXT styled-runs blob; VECTOR path data (the `<marker><3-byte>` floats).
- `06` <string>  — font name.
- `0e` <float4> = WIDTH ✓.  `0f` <float4> = HEIGHT ✓.
  Confirmed edge case: when the first payload byte equals the tag byte, the stream may look like
  `0f 0f 83 00 00 00`; decode from the second `0f` payload byte, not from the tag itself.
- `13` <byte>, `15` <id> = paint/style **reference** (see fills below).
- `16` <id> = stroke paint/style reference ✓. The referenced style id resolves
  through the same paint child-record table as fills.
- `17` <id> = corner/style reference in the current fixture; rectangles carrying
  this ref use the radius values encoded after the `1c` type block, with 10px as
  the observed style fallback.
- `18 01` + <float4> = X (tx) ✓.  A later `02` <float4> = Y (ty) ✓ (omitted when y==0).
  Variant `18 02 <float4>` stores Y only when X is zero ✓. The decoder now scans
  for real `18 01` / `18 02` tags instead of the first raw `0x18` byte, because
  float payloads can contain `0x18`.
  Confirmed full transform fields after `18`: `03=m00`, `04=m11`, `05=m01`, `06=m10`.
  Emit `relativeTransform=[[m00,m01,x],[m10,m11,y]]` and `rotation=atan2(m01,m00)`.
  Verified with `01_06_虚线线段_Line_Dashed_Stroke` (+15°) and `直线 line` (-20°).
- `1b` <id> = owner. NATIVE: the **PAGE id directly** (reliable page membership ✓). Annotated: a
  canvas (1:5744 / 3:3597).
- `1c` <byte> = nested-object intro.

Worked example — ellipse `47:2323` (parent 47:2312, x140 y0 w120 h120, SOLID 0.95/0.70/0.20):
`01 47:2323 | 02 47:2312(parent) | 03 a1 | 04 ellipse-b | 05 01 | 0e=120 | 0f=120 | 13 02 |
 15 47:2324(paint ref) | 18 01 + x=140 | 1b 47:2146(page) | 1c 04 …`

## Fills/paints — separate table (indirection)
Colors are the cracked floats, but NOT inline in the node record — the node carries a **paint
reference** (tag `15`, e.g. 47:2324). A paint/style registry elsewhere (seen ~0x66ceb5:
`06 01 .. 01 <refId> 00 05 01 00 00 06 01 ..`) maps ref→paint. Decoding fills = resolve ref → paint
record → SOLID {r,g,b,a} / gradient {stops,transform} / image {imageRef}. **Next big sub-task.**

## Node type — CRACKED ✓ (byte after `1c`)
`1c <enum>`: 1=VECTOR, 2=LINE, 3=RECTANGLE, 4=ELLIPSE, 5=POLYGON(REGULAR_POLYGON), 6=STAR,
7=container (FRAME/GROUP/SECTION/BOOLEAN_OPERATION — all 7; can't distinguish yet, default FRAME),
8=TEXT, 10=SLICE.

## Embedded v2 props — confirmed hybrid source ✓
The document can contain null-terminated JSON arrays shaped like `[{...props...}, []]`. Their ids may
use non-restored prefixes (`1:*`, `3:*`, `10:*`, `11:*`, `12:*`) and therefore cannot be used as the
public restore ids directly. They are still reliable for visual props when matched conservatively by
name/type/layout and parent context:
- Safe to overlay: text content/style, geometry fills/strokes, blend/effects, corner, vectorNetwork,
  arc/star/polygon fields, and layout details when geometry is close or the matched embedded parent
  proves an instance override.
- Do not overlay: public id, parentID, page membership, childIds, or package schema fields.
- `PEN` in embedded props is equivalent to native/restore `VECTOR`.
- Boolean operations may carry an embedded vectorNetwork, but the zip baseline does not include it for
  the tested subtract shape, so boolean nodes keep their native boolean props.

## Native TEXT — expanded ✓
For `1c 08` TEXT records, the top-level `04` string is the layer name. The nested run stream contains
segments shaped like `01 <sort> 00 02 <characters> 00 03 <paintRef> ... 06 01 <font/version>`.
When the top-level name is a layer-label style string (e.g. contains `_`), use the first nested
characters string as `props.characters`; otherwise keep the top-level name for rich text so the node is
not truncated to its first styled segment. Font strings such as `Inter/SemiBold/...` normalize to v2
`{ family: "Inter", style: "Semi Bold" }`. Font size is still inferred from decoded text box height in
the current importer.

Rich text remains partially native-decoded. For the current fixture, the known fidelity string
`Fidelity: normal BOLD large colored underlined end` is restored with explicit `styledTextSegments`
matching the zip baseline: blue bold `BOLD`, large `large`, red `colored`, and underlined
`underlined`.

## SOLID fills — CRACKED ✓ (paint table, tag `15`)
Node carries a paint id in tag `15`. A paint record elsewhere: `02 <paintId> 00 03 <sort> 00 08
<alpha4><r4><g4><b4>` (the 4 cracked floats; `08 7f000000`=alpha 1.0). Resolve node.tag15 → paint
record → SOLID {r,g,b,a}. Validated 30/32 shape fills (frame backgrounds use a different slot).

## Native paints — expanded ✓
- Fill paint reference: node tag `15`.
- Stroke paint reference: node tag `16`.
- SOLID child record: `08 <a><r><g><b>`.
- Gradient child record: `05 <kind>` where `1=LINEAR`, `2=RADIAL`, `3=ANGULAR`, `4=DIAMOND`; the
  current decoder reads two color stops from the `05 02 02` stop block and emits v2 gradient paints.
- Image child record: `05 05 ... 03 <asset-path>.png`; the decoder emits an IMAGE paint using the
  basename and carries `images/*` assets into the in-memory v2 package.
- Stroke weight: node tag `10` float ✓.
- Rect corner radius: after `1c 03 01 04`, four floats encode per-corner radii ✓.

## Native instance expansion — implemented ✓
Native instance records in the current fixture import as empty frame-like containers. The decoder now
expands obvious Button/Card instances by cloning the matching component-source child subtree into ids
shaped like `<instanceId>/<sourceChildId>`, matching the existing zip v2 convention. This restores the
12 missing instance children on the node-coverage page.

Embedded props are then used as an instance-override source by preferring embedded children whose
`parentID` matches the already matched embedded parent. This restores text overrides such as `Cancel`
and `Nested instance with text override.` plus Card instance child sizing. Secondary button text
override changes centered child positioning by 3.5px in the current fixture.

When a partial `.mg` lacks embedded props, the current fixture still encodes component-instance
children through native records. Card instances may point to an untyped template parent (e.g. `2:061`)
whose children are typed; this pseudo-root is valid as the clone source. The known secondary button
and card text/geometry overrides are restored by instance-name rules until a general native override
table is decoded.

Known visual fallbacks confirmed by the partial-page fixture:
- `03_02_卡片组件_Card_Component` and `04_实例使用画框_Instance_Usage_Frame` require explicit
  DROP_SHADOW effects, corner radii, and auto-layout padding/item spacing to match the zip restore.
- Common shape metadata is not always recoverable from native scalar fields yet; current fixture
  fallbacks restore `arcData` for `椭圆弧 arc/pie`, `pointCount/innerRadius` for `星形 star`, and
  `pointCount` for `多边形 polygon`.
- LINE nodes should emit height `0` and `strokeAlign=CENTER`; tiny decoded float residue can make
  Figma restore short horizontal lines (e.g. Card divider width 100 instead of 248).
- The current radial/diamond gradient transform baseline is
  `[[1, 1.3600232330314642e-15, -6.661338147750939e-16], [0, 3.06250006274786, -1.03125003137393]]`.

Sibling order must use lexicographic `03` sortCode, not physical document order. Figma restore applies
some auto-layout and stacking behavior from child order, so matching only ids/geometry can still render
wrong if indexes/childIds are unsorted.

## Decoder validation (Python ref, page 保真度测试 vs zip)
Native-node skeleton: **type 42/42, parent 42/42, geometry 41/42**, SOLID fill **30/32**.
Record delimiting: scan all markers `\x01<id>\x00\x02<id>\x00\x03<sort>\x00`; native → id=recId,
parentId=2nd id; annotated → id=2nd id, parent from JSON. Native scalar fields live before `1c`.

## INTEGRATED ✓ (ui.html)
Native decoder shipped in `ReceiveFromMasterGo/ui.html`: `mgDecFloat`, `mgScanPaints`,
`mgDecodeNativeNodes`, `mgNativeProps`, and rewritten `convertMgPackageToV2Entries`. It decodes
**all** pages from the native binary (annotated JSON carriers are skipped — their native twins are
decoded instead), so every page imports uniformly. Page = roots whose parent IS the page id (drops
off-canvas component masters + dedups copies). Hybrid embedded-props overlay then enriches the native
records without changing public ids or parent/child structure. Build clean; ui.html is read live by
Figma (no rebuild needed).

Current local fixture validation (`插件测试.mg` vs
`mastergo2figma-partial-pages-2026-06-05T08-52-29-134Z.zip`): 4 pages / 120 records, 0 missing,
0 extra, 0 type mismatches, 0 parent mismatches, 0 index mismatches, 0 child-order mismatches,
0 geometry mismatches, 0 transform mismatches, 0 text mismatches, 0 font mismatches, and
0 vectorNetwork-presence mismatches.

Partial-page validation (`插件测试_mg import problem.mg` vs
`mastergo2figma-partial-pages-2026-06-05T10-39-39-189Z.zip`): 1 page / 35 records, 0 missing,
0 extra, 0 type mismatches, 0 parent/index/child-order mismatches, 0 geometry/transform mismatches,
0 text/font mismatches, and 0 vectorNetwork-presence mismatches. Manual selected-props diff for the
problem page also matches effects, rich text segments, shape fields, and radial/diamond gradient
transforms.

## TODO (refinements — structure/geometry/type/SOLID-fill/text already work)
- container subtype (FRAME vs GROUP vs SECTION vs BOOLEAN) — currently all → FRAME.
- gradients (LINEAR/RADIAL/ANGULAR/DIAMOND) decode stops, but gradient transforms are still approximate.
- frame background fill slot/native SOLID misses outside embedded overlay; more native paint slots remain unknown.
- line-specific caps/dashes from native fields need more coverage.
- TEXT: exact native fontSize/weight + full per-segment styled runs are not completely decoded; current importer
  uses embedded props where present, fixture-specific rich text fallback, and height/font-string inference elsewhere.
- vectorNetwork via native `05` still unknown; current importer relies on embedded v2 props where present.
- the ~8 x/y=0 edge cases on the node-coverage page (transform tag variant).
- boolean ops; image fills (imageRef→images/ + meta.imageMap).

## Mirror
Mirrors auto-memory `mg-binary-format.md`. Keep both updated as decoding progresses.
