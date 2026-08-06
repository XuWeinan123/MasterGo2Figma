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
  `05 <kind> 08 <argb> 09 <radius> 0a <offset.x> 0b <offset.y> 0c <spread> 0d/0e <flags>
  0f <spread>` (floats zero-compressed; omitted offset = 0; **omitted radius = MasterGo
  default 10 for ALL kinds** — the 回归/Layer Blur style entry radius 10 omits field `09`
  entirely; blur kinds used to default 0 and lose the style radius). Kind enum (0712-3):
  **0=INNER_SHADOW (zero-compressed → the whole `05` field is OMITTED), 1=DROP_SHADOW,
  2=LAYER_BLUR, 3=BACKGROUND_BLUR**; `0f` is a second spread spelling (spread 1/−2/−4 all
  use it — an unknown-tag bail there used to drop whole effect lists). Tag 17 doubles as the
  legacy corner-style ref in full exports — only treat as corner when it resolves to no effects;
- paint records: `09 <f>` = paint **opacity**; gradients may omit the handle fields
  (default = vertical top→bottom); image scaleMode enum `2=TILE 3=CROP` plus **4=TILE**
  (0712-3 round-trip form); image object field `02` = ratio/scalingFactor;
- geometry-blob region loops: ONE int array with `-1` (ff ff ff ff 0f) separating loops.

## Full-editor "explicit zero" export form — CRACKED ✓ (2026-07-11, 0711-3 Tesla fixture)
A third export form (`测试集/0711-3/特斯拉 Model 3车载系统.mg`, 29.7 MB, 70k records):
a FULL editor export (n:n page ids, no component-root markers, `mgShareModeActive` false)
that still stores instances as **share-style shallow stubs**. Structure: component/template
trees live as ordinary records on a page (owner `0:2`), instance children are stub records
with slash ids, `1a` templateRef, absolute scale in trailer `26`, and a bare `1c 07 0f 00 00`
container object. Its records spell out **explicit empties** everywhere, which the sequential
walkers used to treat as unknown-tag stop points (58k of 70k records lost their scalar tail —
paint/stroke refs, owner, constraints — which is what "layers import completely wrong" looks
like). Spellings handled since:
- scalar `06 <b>` — new one-byte flag (value 0/1; between `05` and `07`);
- `14 00` — explicit empty dashPattern; `1a 00`/`15 00`/… — explicit-empty refs;
- paint child records carry a leading `04 <b>` field and can have an explicit-empty
  image path (`03 00`);
- container object: `05 00`/`06 <b>`/`07 00`/`08 00` explicit-zero fields interleave the
  structural fields; new trailing fields `0b <b>` `0c <b>` (unknown), `0f <cstring>` (node
  ref; EMPTY on instance stubs), `10 <b>` (unknown). **Container `06` is VALUE-semantic
  like field 01: `06 01` = INSTANCE, `06 00` = plain flag** (superseding the 2026-07-11
  follower-whitelist rule — block-bounded cross-tab on both baselined fixtures: 0711-3
  cover 06=1 ⟺ sourceType INSTANCE with zero contradictions incl. 224 `06 01 09 …`
  spellings; 0712-1's two root Keyboard instances are `06 01 09 …` and the whitelist
  misread them as FRAME, silently dropping their 412 template children). After the flag,
  share exports carry `0f <ref>`/`15 <table>` and stop; full exports continue with the
  instance's own layout fields. **`07` non-zero = COMPONENT_SET** (payload: key string in
  share exports, `04 <varint>` stamp in full exports), `07 00` = plain flag.
- record trailer may have **NO `1d 01` introducer**: fields (`1e`/`21`/`22`/`27`/`28`…)
  follow the `1c` object directly. `mgParseContainerMeta` reports the object's end offset
  and `mgParseTrailer` first parses ANCHORED at that position (accepting both spellings)
  before falling back to the legacy `1d 01` scan.
- **style library region**: entries `01 <id> 00 02 00 03 00 04 00 05 <kind>` (explicit-empty
  parent/sort) with kind 1 = paint style (paint children parented to the entry id), 3 = text
  style. Text entries gain `02 <varint>` stamp, `07 <b>`, and `0f <32-hex font-file hash>`.
  Besides the shared logical entries, TEXT stubs reference per-node **computed entries**
  (`10:…` ids): final (already instance-scaled) fontSize, the RESOLVED line box even for
  AUTO line height, and the concrete font file's name ("Source Han Sans CN"). For computed
  entries the `06 01` PIXELS flag is the only trustworthy lineHeight unit signal (no flag →
  AUTO).
Instance-stub semantics cracked with this fixture (all cross-tabbed against the cover-page
baseline, gated on `!mgShareModeActive` so share doctrine is untouched):
- **Sizes**: a container stub's explicit w/h is in TEMPLATE units when overridden
  (baseline = own × trailer-26 scale; 227/266 exact) but an UNMODIFIED size is written as
  the final scaled copy (own == template × scale → keep). Leaf stubs (VECTOR/TEXT) and
  instance roots are always final. Share stubs stay final everywhere.
- **Container kind is positional**: bare stubs adopt the template child's GROUP /
  BOOLEAN_OPERATION subtype (`bareStub` flag from `mgParseContainerMeta`).
- **Corner radius from the node's own record is final** (stub stores 5.04 = 6 × scale;
  template stores 6); only inherited/default corners scale.
- **Visibility**: a stub with neither the `07` byte nor a `19` mask inherits the template
  child's visibility (share stubs keep the default-visible rule).
- **Omitted transform axes inherit the template child's position** (0712-1: the ENTER stub
  has no `18` field, baseline x/y = template's 20/18 — full-export stubs omit
  non-overridden fields entirely) — EXCEPT boolean-leaf members (mask bit 0x4000), whose
  omitted axes really are 0 in the flattened-leaf space.
- **The 19-mask is the per-record override bitmask** (this IS the full-export override
  mechanism; the container `15` table remains share-only). Cracked bits: `0x1` characters
  overridden, `0x4000` boolean leaf, `0x40000` strokeWeight overridden — a stub's explicit
  `10 00` weight is a FILLER unless 0x40000 is set (0712-1: 8 stubs no-bit → baseline =
  template default 1; 0711-3: 49 stubs with-bit → baseline = own, zero violations).
  `0x10000` correlates with paint/fill overrides (every recolored 0712-1 key carries it).
- **Auto-naming**: TEXT stubs with own characters are named by them, newlines collapsed to
  spaces ("SPEED\nLIMIT" → "SPEED LIMIT", "Artist"→"Streaming") — EXCEPT stubs whose mask
  has 0x10000 without 0x1: those keep the template's manual name (0712-1 "letter" keys;
  the true autoRename flag is not located yet).
- **clipsContent**: full-export instances default to FALSE when neither stub nor component
  wrote field 03 (share instances keep the FRAME-family default true).
- **Per-side weights**: a stub with explicit strokeWeight 0 whose template omits the field
  (default 1) still reports side weights of 1 × scale.
Third pass (0712-2, resized-instance fixture, 2026-07-12):
- **Scalar `05` on TEXT records = the manual-name lock** (the old "shape
  flag"): `05 01` keeps the `04` layer name, `05 00`/absent means autoRename —
  the layer name IS the characters (newlines → spaces). Zero violations over
  three fixtures; stubs inherit the lock from their template slot. The naming
  pass runs BEFORE inheritance on own characters only (`mgApplyTextAutoNames`).
- **Nested-instance overrides in component trees are BARE-id MIRROR trees**:
  the slot's childIds are not template children but mirror records, each with
  `parent = the slot (or parent mirror)` and `templateRef = the mirrored
  template child`. Expansion indexes them by (parent, templateRef) as override
  sources; walking them as template children fabricates duplicate flat-id
  clones (302 extras on the resized "directions").
- **Component records can be ABSENT while their subtree survives** (copy-paste
  authored files): expansion walks the orphan tree through a virtual root
  (geometry from the slot); the inheritance chain falls back to the slot when
  the `1a` target is missing; INSTANCE sizing falls back to the instance's own
  trailer 21/22.
- **INSTANCE clipsContent is purely inherited from the component** (FRAME
  default true). The earlier "full-export instances default to false" reading
  fit components that themselves spell `03 00`.
Second pass (Page-1 visual QA against MasterGo, 2026-07-11):
- **The container `01` VALUE is the group discriminator**: `01 00` = group-like (GROUP, or
  BOOLEAN_OPERATION when `02 <kind>` follows); **`01 01` = FRAME family** (always followed
  by an explicit `03` clipsContent — 9897/9897; groups cannot clip and never write 03).
  Cross-tab over the 516 cover-verified containers has zero exceptions (144 GROUP + 135
  BOOLEAN all `01 00`; the seven `01 01` containers are baseline FRAMEs). Page 1's
  top-level screens (1920×1200 artboards) all use the `01 01` spelling — before the rule
  every one imported as a GROUP (17k GROUP / 2.5k FRAME flipped to 7k / 12.4k), which also
  cascaded into "wrong positions" (groups refit their bounds and drop clipping on restore).
- **`05 01` = COMPONENT regardless of key spelling**: share/older exports write
  `05 01 07 <key>`, the 0711-3 explicit-zero form may leave the key EMPTY
  (`05 01 06 00 07 00` — the Keyboard master). Census: all 95 `05 01` containers in the
  fixture are components, everything else spells `05 00`. The old adjacency rule
  (`05 01 07`) found only the 20 keyed ones.
- **Component masters stay on canvas in full exports**: the share-mode rule that drops
  COMPONENT/COMPONENT_SET page roots (off-canvas masters merely share the page owner) is
  now gated on `mgShareModeActive` — it was silently deleting the Tesla file's components
  (and their subtrees) from Page 1.
- **Page background color**: the page-table record carries `05 <a><r><g><b>`
  (zero-compressed floats) followed by one-byte flag fields. The color is stored even for
  DEFAULT canvases (light fixtures carry #F5F5F5, the Tesla file black); **flag `06 01`
  marks a USER-SET background** and only then does the converter emit it (the 0711-3 cover
  stores black but has no 06 flag = default; Page 1 stores black with `06 01` and really is
  black). `parseMgPages` extracts it, the converter writes an optional `background` field
  in the v2 page index (a native-decode format extension — SendToFigma zips do not carry
  it), and the importer applies it as the page's SOLID background paint.
Third pass — **component/instance re-linking** (2026-07-11): instance records now carry a
record-level `mainComponentId` (the tag-1a template ref, emitted only when the component's
record is itself reachable in the package — full exports keep masters on canvas). The
importer restores such records as REAL InstanceNodes: component/component-set page roots are
restored first (page children re-ordered back to package order afterwards), then
`component.createInstance()` + root props + per-child overrides applied by POSITIONAL
matching of the record tree against the instance's children (record childIds order ==
component child order; any count drift skips that subtree). Overrides applied: visibility,
opacity, text characters (with cached font loads). Any failure falls back to the previous
frame-shell restore. **Same-root use-before-definition** (2026-07-13, 统一集 R08: instances
ordered before their components INSIDE one page root, where the root-level topo sort can't
help) is handled by a deferred-relink pass: the shell fallback is remembered and swapped for
a real instance after the page finishes (`retryDeferredInstanceRelinks`, before the deferred
layout pass so its registrations are consumed). Multi-axis variant names are normalized per
comma pair on import (`Size[a0]=Small,Type[a1]=Secondary` → `Size=Small, Type=Secondary`) —
stripping only the first pair left sibling variants with mismatched property-name sets and
`combineAsVariants` threw, degrading the whole set to a frame (统一集 R06). The comparator ignores the record-level field (SendToFigma baselines
flatten instances to frames), so all six fixtures stay byte-identical.
Remaining 0711-3 residuals (cover baseline: 0 type / 115 geometry / 66 transform / 43 font /
7 paint / 622 deep): nested-instance font/image overrides that live in the still-undecoded
container override table (`1c 07` → `06 01 15 …`), the x/y/relativeTransform position family
(~200 rows), and live-text hug sizes. See MG_DECODER_JOURNAL.md.

## Mirror-tree overrides & rootless components — CRACKED ✓ (2026-07-12, 0712-2 fixture)
Full exports implement nested-instance overrides as **bare-id MIRROR record trees** (share
exports use slash-composed override records instead):
- `mirror.parent` = the instance's template SLOT (or the parent mirror), `mirror.templateRef`
  = the mirrored component child; the tree parallels the component subtree level by level and
  carries the per-instance overrides (hidden rows, opacity 0.4, recolors, explicit-zero
  paddings, overridden characters). On the owning page the mirrors double as the instance's
  canvas children (the API's node ids for them).
- Instance-child STUB ids flatten intermediate non-instance containers, so mirrors resolve
  per path segment against the TRANSITIVE mirror set of the current scope
  (`mgAttachOverrideMirrors`, independent of template expansion).
- **A file may copy component subtrees WITHOUT their roots** (0712-2: nav row's 0:761, left
  turn's 0:773 are absent while their children are present). The inheritance chain is
  therefore `stub → mirror → 1a target → path-segment slot node`; the slot fallback supplies
  the instance-root invisible-white fill, opacity, clips when the component is unreachable.
- Nested-instance detection during expansion must consult the TEMPLATE child (a resized
  instance materialises bare stubs whose own container meta degenerates to FRAME; walking
  such a stub descends into the mirror tree and clones it as bogus children — 288 on this
  fixture).
- **Instance-child identity rule**: layer NAME (and the base box) always follows the main
  component's child — characters are overridable, names are not (mirror chars
  "Highway 400" with name "Exit 87" from the component text). `mgSyncMirrorIdentity` syncs
  names last; sizes are NOT synced (hug boxes are live text metrics — a package-side
  unknowable, kept as the documented residual family).
- A mirror's own `1c 01` geometry hash may reference a blob that was never copied into the
  file; the vectorNetwork lookup falls back along mirror/1a/slot to the first hash present
  in the blob table. Pen-edited ellipses keep type ELLIPSE while carrying a vectorNetwork.
- Known no-signal residual: instance stubs whose component root is absent AND whose slot
  lacks field 03 have no package-side clipsContent truth (6 rows; a component-missing→false
  rule flipped 46 healthy instances and was reverted).
- **Mirror lookup is dual-key**: for plain children `mirror.templateRef` = the mirrored
  template child, but for NESTED-INSTANCE slots it is the COMPONENT id (0:795), not the slot
  id (0:59042) — both keys must be tried when resolving a stub's mirror
  (`mgAttachOverrideMirrors` flatten + `bareOverrideByParent` in expansion). Missing this
  silently drops every per-row icon visibility override.
- **Mirror `07` byte omitted = visible** (explicit `07 00` = hidden, 18/18; omitted = shown,
  6/6). Do not treat an absent visibility byte on a mirror as "inherit slot".
- **Instance uniform scale = trailer field `26`** (share exports already used it as absolute
  scale). The converter emits it as `record.instanceScale` when ≠1; sizes of container stubs
  inside such instances are template-units × this factor unless the stub's own size already
  equals template×scale (final-copy rule).
- **Fourth instance form — FULLY MATERIALIZED (2026-07-12, Tesla Page 1)**: editor-original
  full exports store every instance child as a complete TYPED bare-id record tree hanging off
  the instance (0:112 about → raw 0:113 Light, templateRef=0:48, override state baked in).
  The 0712-2 baseline proves those bare ids ARE the API canvas ids (component-inner dragme
  emits `0:77 Union`, not a slash stub). Rule: an instance whose childIds contain a TYPED
  bare child skips template expansion entirely — the raw subtree is emitted as-is. Expanding
  it anyway doubles every instance subtree (11,480 of 11,482 Tesla instances were doubled;
  the doubled counts also tripped the importer's positional-override count gate, silently
  killing every visibility/paint override). Sparse TYPELESS bare children (0712-2 mirrors)
  do NOT trigger the skip — those instances still expand and mirrors feed the stubs.
- Importer: page roots restore in TOPOLOGICAL order of mainComponentId dependencies
  (components nest instances of other components — restoring a dependent first bakes a
  frame-shell fallback into the component that every instance then clones).

### Import-side replay (Figma plugin, not a package field)
- Figma instance children are geometry-locked to the component (`set_y` → "This property
  cannot be overridden in an instance"), so `instanceScale` is replayed with
  `InstanceNode.rescale()` before the exact root resize.
- **Figma rescale hug quirk (measured 2026-07-12)**: after `rescale(S)` an auto-resize text
  box re-hugs to `ceil(S·lineHeight)` and, whenever `fract(S·lineHeight) > 0.5`, lands
  **exactly 1px above** the scaled position (28→23.537→24: −1px; 36→30.26→31 and 50→42.03→43:
  0). Independent of the text's y / alignment; reproduced on synthetic components.
- Fix: `textAutoResize` IS overridable on instance children — the importer pins every text
  child of a rescaled instance (except characters-overridden ones, which must re-hug) to
  `NONE`, restoring the pure-scaled box. That equals MasterGo's glyph truth: MasterGo's own
  instance hug is center-preserving, so glyph positions are exactly the scaled ones and only
  MasterGo's integer-rounded bounding box differs (residual `(ceil(S·lh)−S·lh)/2` < 0.5px,
  box-only, invisible). CENTER-constrained frames drift similarly (~0.4px, dragme) with no
  writable lever — documented residual.

## Library-bearing editor export form (colon-token dialect) — CRACKED ✓ (2026-08-05, 0804 带外部库 fixture)
Editor exports of files that REFERENCE external libraries embed the entire library document(s)
into the same `document` binary (0804: 28MB, 195k decoded records — the user page holds 997).
Fixture pair: `测试集/带外部库测试/测试集 0804_1_32.mg` (library-bearing) vs
`测试集 0804_1_32 手动复制对照组.mg` (same content manually copied into a clean file; MasterGo
materializes display names/values on copy, so it is the known-answer table). Verified to a
0-row field diff over 997 position-paired nodes (residuals: 9 sub-pixel 0.5px x-coords that
differ in the SOURCE files, 18 rows where the orig produces RICHER mixed-font
styledTextSegments than the materialized control, 1 node-level fontName covered by segments).

- **Colon-token id space.** Auxiliary records get ids like `:7384` — page ids
  (`01 :7384 00 02 色值 00 03 a1P`), node owner tokens (`1b :7384 00 1c`), paint/effect child
  ids (`01 :396 00 02 0:2451 00 03 a0 <paint>`), and a token registry near the style region
  (`01 :2513 00 02 0:71915 00 03 a0` = token → node id). `parseMgPages`' idRe and the
  paint/effect scan child-ID patterns accept `:[0-9A-Za-z]+`.
- **Library removal = page reachability.** The header page table lists ONLY the main
  document's pages; every embedded-library node hangs off owner tokens absent from that
  table and is dropped by the existing page-root reachability gate. Nothing else is needed —
  but decode must still SEE the library records (user-page records carry `15` paint refs and
  `1a` template refs into library-owned slots/styles).
- **Share-mode discriminator.** Embedded libraries contribute `01 <id> 00 04` component-root
  marks (0804: 12× `2129:*` owned by library page `:01695`), which used to flip
  `mgShareModeActive` for the whole file — disabling `mgApplyTextAutoNames` (stale names
  emitted), flipping omitted-spacing defaults, and skipping the mirror passes. The comp-root's
  OWNER does **not** discriminate either: an editor export of a library document itself (大文件
  0804 design system) holds foreign off-canvas masters (pasted icon components) owned by its
  own header pages — exactly the shape a share export would have. Rule now: the SORT CODE is
  the signal. Editor exports sort-code every on-canvas record (`01 <id> 00 03 <code>`); share
  exports store page-owned content as codeless comp-roots. Any sort-coded record owned by a
  header-page id (`1b <owner> 00 1c`) proves an editor export → share mode OFF; share mode
  holds only when none exists, or the file has no parseable page table at all.
- **Page-root master filter follows the same signal.** Page roots drop only masters
  **without** a sort code (off-canvas registry masters that merely share the page owner).
  Sort-CODED masters are genuine canvas content and must stay — the 0804 design system keeps
  every `button`/`button-group` COMPONENT_SET as a coded canvas root; dropping masters by
  share-mode flag alone emptied 60+ of its 69 pages (7.2k of 205k layers survived).
- **Stale display fields are normal here.** Un-materialized copies keep the ORIGINAL name in
  `04` (name "#111d2c" while the run says "#1D2129") and the original paint ref in scalar
  `15`; MasterGo derives the live value from the run tables. Auto-naming (scalar-05 lock)
  already handles names; fills additionally need the color-run override below.
- **Text run grammar refinements** (all in `mgParseFontRuns` / `mgParseTextRuns`):
  - run sortIds use the full printable-ASCII fractional-index alphabet INCLUDING space
    (`b&n`, `b$ `) — `[\x20-\x7e]{1,8}`, not alnum;
  - glyphless runs (no `05/06/07` tables) end with an explicit `00` terminator that must be
    consumed before the next run's `01`;
  - color-run boundaries (`01 <start> 02 <end>`) are LEB128 varints (218 = `da 01`);
  - a color-run table with count **1** is real (`09 01 02 17 03 <paintRef> 00 00`) — one
    full-cover run;
  - **single-run fill override**: when a TEXT record's single color run resolves in the paint
    table and its ref differs from the scalar-15 ref, the RUN's paint is the text color (the
    15 slot is the stale template link). Restricted to slash-less ids — instance expansion
    clones keep template paintRef semantics (Tesla OPEN labels regressed without the gate).
- **Trailer-less containers hug.** Shallow-copy frames/groups may have NO trailer at all;
  absent `21/22` still means sizing AUTO (previous code only reached the AUTO branch when a
  trailer existed, leaving FIXED defaults).
- Records may omit the `02` parent field entirely (`01 <id> 00 03 <code> …`); parent falls
  back to the `1b` owner token, which is how page roots attach to the page.

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

## Registry-residue records — non-canvas, dropped before assembly ✓ (2026-07-11)
A `.mg` can carry auxiliary registry records that reuse the node-record header
(`01 <id> 00 02 <parentId> 00 03 <sortCode> 00`) but are NOT canvas nodes. Body
grammar, byte-identical across all 131 records in the 0711-2 fixture:
```
07 01  08 <node-id> 00  0b 01 <varint 300> 02 02|04 02 00  0d 01 13 00 00
```
- The discriminator (`mgIsRegistryResidueRecord`) is structural: tag `08`
  carries an ID STRING where a node record stores the one-byte
  constrainProportions flag (legal values 0/1 only) — impossible in the node
  scalar grammar. Match = body starts `07 00|01 08` + id-shaped cstring + `00
  0b`.
- No name (`04`), no owner (`1b`), no `1c` type object, no `1d 01` trailer.
- Ids sit at the top of the file's id space (2:29891–2:30094 vs design nodes
  ≈2:07xxx–2:25xxx); sortCode always `a0`; exactly one per parent (131 records
  under 131 distinct instance/template children); the `08` ref names a
  component-template node (14 distinct refs). Exact role unknown —
  annotation/interaction-like (the `0b` object's first field is varint 300, a
  duration-ish default); none exist in any SendToFigma baseline.
- Skipped in `mgDecodeNativeNodes` BEFORE node assembly (same spot as the
  `[PROPS]` carrier skip). Dropping early matters three ways: an emitted stub
  shifts every later sibling's index (the 295-INDEX_MISMATCH incident);
  template expansion clones residues inside component trees into every
  instance (`2:09860/2:30074`); and the weak `1c` type-tag fallback can misread
  bytes after the ~40-byte body as a node type — `2:30073`'s block ran 143 KB
  to the next marker (font tables, geometry varint runs), got misread as LINE,
  and emitted as the baseline-extra record. Cross-tabbed over all five test
  sets: 131 hits in 0711-2 (= exactly the high-id family), zero in the other
  four, zero overlap with any baseline record.

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
- **`2e 01` = layoutPositioning ABSOLUTE** (ignore auto-layout) — 统一集 cross-tab: all 5
  v2-ABSOLUTE nodes carry it, none of the other 316 do (TP5/FP0/FN0); set0's three
  group-children confirm it against the old export era too. The flag is authoritative over the
  embedded-v2 layout merge (set0's embedded copies carry a stale `AUTO`). Replaced the
  group-child-under-auto-layout heuristic, which mis-marked plain group children;
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
    overrides such as text `Confirm`/`Cancel` — still undecoded; the name-based
    instance-override hacks that used to paper over it were REMOVED 2026-07-13 after they
    corrupted same-named layers in the 统一回归集, so set0 keeps 3 honest residual rows);
  - **`08 <b>` = layoutMode** (1=HORIZONTAL 2=VERTICAL; omitted=NONE);
  - **`09 <f>` = itemSpacing**, **`0a <obj>` = paddings** (sub-fields `01`=top `02`=right
    `03`=bottom `04`=left, zero-compressed). **Default-10 rule**: a missing `09` field, an
    EMPTY `0a` object, a **wholly absent `0a` object**, or an **individually omitted sub-field**
    (统一集 2026-07-13: 回归BoolChip stores L/R 16 and drops the T/B 10 slots; 回归Badge stores
    T/B 5 and drops L/R 10) all mean the omitted-field default — MasterGo runtime default **10**
    in full editor exports, **0** on share-export template/instance nodes (`missingDefault` in
    `mgNativeProps`). Explicit zeros are written as `09 00` / four zero sub-fields — 回归Button
    (COMPONENT_SET) writes all four `01 00 02 00 03 00 04 00`. (This is why groups/booleans
    export padding 10.) Cross-set evidence for the absent-`0a` spelling: 0710-2 (full export)
    plain GROUP/BOOLEAN records omit `0a` and the baseline says 10 (269 nodes); 0710-1's
    absent-`0a` nodes are all template/instance children and the baseline says 0 — both fall
    out of the same `paddingsMissing` funnel. Before 2026-07-10 the absent case wrote nothing
    (restored as 0). Rescaled-instance layout is stored in TEMPLATE units and the v2 export
    materializes it SCALED (inst/scale-0.83x: padding 14 stored, 11.62 exported) — paddings and
    itemSpacing multiply by the trailer-26 scale like the geometry path.
  - **`0d <b>` = primaryAxisAlignItems** (1=MAX, 2=CENTER, **3=SPACE_BETWEEN** [统一集
    al/space-between-3 stores `0d 03`], 4=SPACE_BETWEEN; omitted=MIN) / **`0e <b>` =
    counterAxisAlignItems** (1=MAX, 2=CENTER, 3=MAX; omitted=MIN — Figma has no counter
    SPACE_BETWEEN; the pre-0713 shared table read primary `3` as MAX and packed
    SPACE_BETWEEN rows to the end);
  - `14 …` component property / override definition table (not walked);
  - `17 <b>` container kind enum near the end: `01` observed only on SECTION.
Boolean/group records also carry `09`/`0a` after their `01`/`02` flags — same rules apply
(inert on import for groups, but kept for v2 parity).
Name-based type heuristics remain only as fallback when no `1c 07`
object is decodable, plus the narrow SECTION name fallback.

## Library styles — CRACKED ✓ (2026-07-12, 0712-3 round-trip specimen)
Style DEFINITIONS are named records whose 02 slot holds the display name with a UTF-8
category prefix (no 04 field): `01 <id> 00 02 文字/Heading/H1 00 03 <code> 00 05 <payload>`.
Prefixes: `文字/` = text, `填充/` = fill, `特效/` = effect (NOT 效果), `描边/` = stroke
(unobserved). Values live in the id-keyed registries: fills in the paint table, effects in
the effect registry, text params in the font-style table (third entry spelling). Node
references point straight at the style id: fills/strokes via scalar tags 15/16, effects via
tag 17, text via the run-level `03 <styleId>` field. The converter emits `styles.json`
(schema mastergo2figma.styles.v1) plus record-level fillStyleRef/strokeStyleRef/
effectStyleRef/textStyleRef (comparator-invisible like mainComponentId); the importer
recreates them as local Figma styles and re-binds after applyProperties. Probe gotcha:
TextDecoder("latin1") is actually windows-1252 — locating CJK prefixes needs byte-level
matching, decoding names needs a UTF-8 pass over the raw byte range (w1252 keeps 1:1
byte↔char offsets, so regex indexes stay valid).

## TEXT / ELLIPSE nested-object fields — CRACKED ✓
- TEXT `1c 08`: leading field **`03 <b>` = textAutoResize** — `03 00` = WIDTH_AND_HEIGHT,
  `03 01` = HEIGHT, field omitted = NONE/fixed size (25/25 nodes). Field `06 <n>` = styled-run
  count, then the run blob.
- ELLIPSE `1c 04 01 <obj>`: **arcData** — field `01 <f>` = sweep as a fraction of a full turn
  (`-1` = clockwise full circle → −2π, omitted = +2π, `0.75` → 4.712…), field `02 <f>` =
  innerRadius (0.4 verified), field `03` (unobserved) presumed startingAngle fraction. Every
  ellipse gets arcData in v2.
- **POLYGON (`1c 05`) / STAR (`1c 06`)** (0712-3): field `01` = pointCount as a **zigzag
  varint** (3→06, 5→0a, 8→10; omitted = polygon 3 / star 5); STAR field `02 <f>` =
  innerRadius (omitted = 0.5).
- Font-style-entry decoration byte (`01 <b>` after the entry kind): 2 AND 4 =
  STRIKETHROUGH (2 legacy, 4 on the 0712-3 round-trip form), other decorated values =
  UNDERLINE.
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
  - **Bare `06 { 03 <scalar> }`** (share exports, native-drawn gradients): the scalar IS the
    Figma minor/major handle ratio, stored directly (`mgRadialAxisRatio`; absent/0 = circular).
    All observed bare samples are ≤ 1 (0.3265/0.5714/1). The 2026-07-10
    `min(scalar, 2|p1−p0|/scalar)` rule was a fit to FOLDED ZIP baselines (see below), not to
    the render.
  - **Chain `06 { 02 <f> 03 <scalar> 04 <f> }`** (2026-07-13 统一集, Figma-imported gradients):
    a conversion chain where field `04` is the normalized-final ratio FOR THE OWNER NODE only —
    the same chain entry (03=0.10662, 04=0.3265) is shared by nodes of different aspect and the
    v2 export materializes **per node**: RADIAL (kind 2) with an x-dominant handle =
    `03 × (w/h)²` (210×120 → 0.3265 → a11 3.0625; shared 100×100 strokes rectangles → 0.10662
    → 9.3789); y-dominant handles read `03` directly (vertical reference frame — set1/0711-2/
    0711-3 native radials all match the direct read, a `×(h/w)²` y-branch broke 368 paints).
    ANGULAR/DIAMOND read `03` directly even when the chain is present (菱形 on 210×120: v2 =
    9.3789). Implemented as `__mgRadialMeta` on the scanned paint + per-node
    `mgFinalizeRadialPaints` in `mgNativeProps` (paint styles keep the scan transform).
  - **Extended `06 { 01 <f> 02 <f> 03 <scalar> 04 <f> 05 <f> 06 <f> }`**: fields 01/02/04/05 are
    ellipse-frame floats (unused), field `06` = `2 × |p1 − p0|`. Scalar and field06 form the
    ratio **branch pair `{scalar, field06/scalar}`; the render truth is the LARGER branch**
    (`max()` in `mgParsePaintRecord`). Two same-design fixtures store OPPOSITE branches for the
    identical Tesla vignette: `测试集 0710-2` stored scalar 0.4117 (division → 3.5696 correct,
    16/16 baseline radials), `测试集 0711-1` stores scalar 3.5696 (direct correct — settled
    2026-07-11 against MasterGo screenshots). Neither "always divide" nor "always direct"
    survives both files. All observed extended-form gradients are wide (ratio > 1); a genuinely
    narrow extended sample would need a new discriminator. Before 2026-07-10 the parser rejected
    the unknown 01 tag and **dropped the whole paint**, which is why 0710-2 radial fills
    vanished while linear gradients survived.
  - **ZIP baselines are NOT ground truth for this ratio.** The 2026-07-11 ZIP carries 0.4117 for
    the Tesla vignette — MasterGo's plugin API exposes only two handles plus a transform built
    from the folded `min(ratio, 2|p1−p0|/ratio)`, which disagrees with MasterGo's own renderer
    whenever `ratio² > 2|p1−p0|`; the fold is not invertible from the API paint alone.
    The 0710-2 ZIP carried the TRUE 3.5696, so the API transform's provenance varies per
    document — trust the .mg + screenshots. `tools/compare_mg_import.js` canonicalizes both
    sides to the folded form so the known exporter-side loss doesn't read as a decoder
    regression.
  - **SendToFigma escape hatch (2026-07-11)**: for nodes carrying radial-gradient paints the
    exporter now probes `node.exportAsync({format:"SVG"})` — the SVG carries the true ellipse
    radii. Paints are matched by gradient stops and the rebuilt transform stays anchored to
    the API handles (`enrichRadialGradientTruth` in `nodeSerializer.ts`, pure math in
    `serializers/svgGradientTruth.ts`). Angular/diamond gradients have no SVG equivalent and
    still export the folded transform; a real third gradient handle is preferred if the
    runtime ever provides one.
  - **MasterGo's SVG exporter swaps the radius slots** (found via the first re-export attempt,
    which imported a THIRD wrong ratio 0.2006): the along-handle radius lands on the
    perpendicular axis and vice versa, so the SVG read as written renders the ellipse rotated
    90° from MasterGo's own canvas. Both true radii are still present — `svgRadialAxisRatio`
    computes both the as-written and slot-swapped readings and arbitrates with the
    gradient-model invariant *along-axis radius == |p1 − p0|* (5% tolerance): the consistent
    reading wins, a spec-conforming emission resolves identically, and if neither reading is
    consistent (scaled viewport, unexpected form) it returns null and the folded API transform
    is kept. Verified on both fixture nodes: Tesla vignette 0.2006 → 3.5696, Rectangle 5
    0.042 → 1.1976 (== the .mg scalar).
  Figma `gradientTransform` is computed with the exact SendToFigma math
  (`mgLinearGradientTransform` / `mgRadialGradientTransform`, ports of
  `SendToFigma/src/serializers/universal.ts`), so native decode is bit-compatible with real
  exports.
  - **LINEAR gradients are aspect-corrected per node** (2026-07-24): MasterGo renders the
    gradient bands perpendicular to the p0→p1 handle line in PIXEL space, while a matrix
    built as a pure rotation in the normalized square skews the axis on non-square nodes
    (fx/bg-blur-backdrop, 280×150, 45°-in-pixels axis imported as a hard diagonal). Paint
    parse time has no node size, so linear paints carry `__mgLinearMeta {p0, p1}` and
    `mgFinalizeRadialPaints` rebuilds the transform per node via
    `mgLinearGradientTransformPx(p0, p1, w, h)` — the same formula SendToFigma now uses
    (`getResultArrayByTwoPoint` with dims). Row0 folds the aspect into the gradient axis;
    row1 (perp) is scaled by `w·h·|p1−p0|`, which reproduces the legacy matrix bit-for-bit
    wherever the legacy math was already correct (axis-aligned on any aspect, any angle on
    squares). Style-library paints have no owner node and keep the normalized fallback.
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
[06 <lineHeight unit: 1=PIXELS>] [08 <letterSpacing value>]
[0a <textCase: 1=UPPER 2=LOWER 3=TITLE>] [0b <letterSpacing unit: 1=PIXELS>]
[0c <PostScript name> 00] [0e <float, -1 = default; unknown>]
[12 <style name "Bold"/"SemiBold"/…> 00] [13 …] 00
```
- **letterSpacing = `{ 08-value (default 0), 0b present → PIXELS else PERCENT }`** —
  cross-tabled 2026-07-11 (`测试集 0711-1`): the {0,PIXELS} and {4,PIXELS} entries carry `0b 01`
  (and `08` twisted-float 4.0 for the latter); the all-PERCENT fixture's entries carry neither.
  `06`/`0b` assignment (lineHeight vs letterSpacing unit) is by tag adjacency plus the
  `f06=1,f0b=null` / `f06=null,f0b=1` split rows in the flag histogram; pixel values scale with
  the instance like fontSize/lineHeight. Old fixture also shows negative `08` values
  (-2.8/-1.52/-0.52 = tightened tracking) on non-baseline pages.
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
entries (`convertMgPackageToV2Entries`). Direct `.mg` conversion appends `_mg MMDD-HHmm` (one
stamp per run) to every restored page name — an existing `_mg`/timestamp suffix is stripped
first, so repeated imports stay distinguishable without stacking suffixes.
`convertMgPackageToV2Entries(zipEntries, fileName, options?)` accepts
`options.slimInstanceDescendants` (plugin UI only): descendants of records that carry
`mainComponentId` are stripped to the override fields the importer reads (visible/opacity/
characters/fills/strokes + slim layout/type skeleton). On the Tesla fixture that is 219k of
221k records and cuts the converted package from 477MB to 167MB — without it the Figma tab
OOM-crashes ("Something went wrong"). The compare tool and `pythonParser/mg_to_zip.py` call
without options and keep byte-identical full-fidelity output, so comparator baselines are
unaffected. Share-export instances (no reachable master → these records ARE the restore
source) are never slimmed — the gate is the emitted `mainComponentId`, not the slash id. `ui.html` is generated by `tools/build-ui.js`; the same
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
- Default-variant name wash (2026-07-13, `mgWashDefaultVariantName`): the .mg stores variant
  names with MasterGo's `[aN]` order markers appended per key; the plugin API (and hence the
  v2 export) washes the DEFAULT variant — when every comma-separated key ends with `[a0]`, one
  marker layer is stripped per key, and a fully clean result re-joins canonically with `", "`
  (`Size[a0]=Small,Type[a0]=Primary` → `Size=Small, Type=Primary`; `…,Variant[a0][a0]=…` keeps
  the raw comma join after stripping to `Variant[a0]`). Non-default variants pass through raw.
  Gated to COMPONENT records inside a COMPONENT_SET. Known era exception: set0's same-shaped
  default variant is NOT washed in its 07-10 zip (1 accepted residual row on the retired set).
- Unknown fields: trailer `1e/25/27/2b/37`, paint fields `07/0c/0d`, vertex flag `03` values,
  scalar `19` flag-bit meanings,
  text-style entry field `13` (`{02 <varint> 06 <varint>}` sub-object with identical
  timestamp-like values across files — metadata, not style), TEXT-object leading `08 <b>`,
  run glyph tables' float semantics (skipped, not used).
- **`0e` is NOT letterSpacing — hypothesis disproven 2026-07-10.** 插件测试.mg carries `0e`
  values 10–134 on full font entries while its baseline letterSpacing is `{0, PERCENT}` on every
  text; 0710-2 carries `0e = -1` everywhere. The real letterSpacing is `08` (value) + `0b`
  (PIXELS-unit flag) with `06` as the lineHeight-unit flag — cracked 2026-07-11 via the flag
  histogram (the 2026-07-10 "no per-entry unit discriminator" conclusion missed `06/0b` because
  the then-scanner consumed them blindly; the 142 unit-only residuals on each of 0710-1/0710-2
  are now fixed).

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

### 2026-07-11 — letterSpacing + gradient render-truth pass (测试集 0711-1)
New fixture `测试集/0711-1` (23/23). Cracked: letterSpacing = style-entry `08` value + `0b`
PIXELS-unit flag, `06` = lineHeight-unit flag (flag-histogram cross-table over both fixtures;
kills the 142 unit-only residuals on EACH of 0710-1/0710-2 — strict set-diff vs HEAD: added 0,
removed all-letterSpacing); SECTION always FIXED/FIXED. Gradient ratio OVERTURNED by visual
truth: ZIP baselines carry MasterGo's API fold `min(r, 2|major|/r)` (irreversible, disagrees
with MasterGo's own renderer — Tesla vignette screenshots), so the 07-10 `min()` rule and the
extended-form `field06/field03` division were both fits to the exporter bug. Now: bare `03` =
ratio direct; extended = larger branch of `{scalar, field06/scalar}` (two same-design exports
stored opposite branches); comparator canonicalizes both sides via `foldGradientTransform`;
SendToFigma prefers a real 3rd gradient handle when the runtime provides one. Remaining
0711-1 residual: the Tesla `Subtract` w/h (boolean result bounds need path evaluation; the
importer's `figma.subtract` recomputes them live).

## Mirror
Mirrors auto-memory `mg-binary-format.md`. Keep both updated as decoding progresses.
