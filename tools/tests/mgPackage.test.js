const test = require("node:test");
const assert = require("node:assert/strict");
const { __test } = require("../../ReceiveFromMasterGo/src/ui/mgPackage.js");

test("instance visibility precedence preserves explicit scalar values", () => {
  assert.equal(__test.resolveInstanceVisibility(0, 0x04, 1, true), 0);
  assert.equal(__test.resolveInstanceVisibility(1, 0x00, 0, true), 1);
});

test("shallow visibility mask resolves omitted scalar to visible", () => {
  assert.equal(__test.resolveInstanceVisibility(undefined, 0x04, 0, true), 1);
  assert.equal(__test.resolveInstanceVisibility(undefined, undefined, 0, true), 1);
});

test("non-visibility masks and synthesized children inherit the slot", () => {
  assert.equal(__test.resolveInstanceVisibility(undefined, 0x80, 0, true), 0);
  assert.equal(__test.resolveInstanceVisibility(undefined, 0x80, 1, true), 1);
  assert.equal(__test.resolveInstanceVisibility(undefined, undefined, 0, false), 0);
});

test("an explicit empty stroke override clears the template stroke", () => {
  assert.equal(__test.shouldInheritStroke(null, 0x20000, true), false);
  assert.equal(__test.shouldInheritStroke(null, 0x34080, true), false);
  assert.equal(__test.shouldInheritStroke(null, 0x10000, true), true);
  assert.equal(__test.shouldInheritStroke(null, undefined, false), true);
  assert.equal(__test.shouldInheritStroke("stroke-ref", 0x20000, true), false);
});

test("styled text run parser preserves sparse starts and paint references", () => {
  const bytes = Uint8Array.from([
    0x09, 0x02,
    0x02, 0x02, 0x03, ...Buffer.from("2:0537"), 0x00, 0x00,
    0x01, 0x02, 0x02, 0x03, 0x03, ...Buffer.from("2:844"), 0x00, 0x00
  ]);
  assert.deepEqual(__test.parseTextRuns(bytes, 0, bytes.length, 3), [
    { start: 0, end: 2, paintRef: "2:0537" },
    { start: 2, end: 3, paintRef: "2:844" }
  ]);
});

test("Boolean leaf sizes distinguish natural, already-scaled, and slot-sourced values", () => {
  const scale = 0.8406118750572205;
  assert.equal(__test.resolveBooleanLeafSize(18, 18, scale, 0x4000), 18 * scale);
  assert.equal(__test.resolveBooleanLeafSize(18 * scale, 18, scale, 0x4000), 18 * scale);
  assert.equal(__test.resolveBooleanLeafSize(38.58, 18, scale, 0x14080), 18 * scale);
});

test("instance constraints resize from the uniformly scaled template parent", () => {
  assert.deepEqual(__test.scaleByConstraint(0, 20, 30, 100, 140), { pos: 20, size: 30 });
  assert.deepEqual(__test.scaleByConstraint(1, 60, 30, 100, 140), { pos: 100, size: 30 });
  assert.deepEqual(__test.scaleByConstraint(2, 20, 30, 100, 140), { pos: 20, size: 70 });
  assert.deepEqual(__test.scaleByConstraint(3, 20, 30, 100, 140), { pos: 40, size: 30 });
  assert.deepEqual(__test.scaleByConstraint(4, 20, 30, 100, 140), { pos: 28, size: 42 });
});

test("only an exact full-bleed GROUP inherits the resized parent box", () => {
  const parent = { w: 580, h: 1050 };
  assert.equal(__test.coversTemplateParent({
    x: 0,
    y: 0,
    w: 580,
    h: 1050,
    containerMeta: { subtype: "GROUP" }
  }, parent), true);
  assert.equal(__test.coversTemplateParent({
    x: 0,
    y: 0,
    w: 580,
    h: 1049,
    containerMeta: { subtype: "GROUP" }
  }, parent), false);
  assert.equal(__test.coversTemplateParent({
    x: 0,
    y: 0,
    w: 580,
    h: 1050,
    containerMeta: { subtype: "FRAME" }
  }, parent), false);
});

test("radial-gradient axis scalar IS the Figma minor-axis ratio", () => {
  // The scalar is the render-truth ratio, stored directly. Baseline ZIPs carry
  // min(scalar, 2|major|/scalar) instead — MasterGo's plugin API folds the
  // ratio when building the gradient transform SendToFigma reads (settled
  // 2026-07-11 against the Tesla vignette screenshots: scalar 3.5696 renders
  // as the wide flat ellipse, not the folded 0.4117). Do NOT re-fit these
  // expectations to a ZIP baseline.
  const cases = [
    // scalar > fold bound: ZIPs fold these to 0.4117249 / 0.559487 / 0.765407
    [{ x: 0.49358985, y: 0.43939397 }, { x: 0.49358985, y: 1.1742425 }, 3.5695839],
    [{ x: 0.49425292, y: 0.30769229 }, { x: 0.49425292, y: 0.76923078 }, 1.6498741],
    [{ x: 0.50000006, y: 0.54166669 }, { x: 0.5, y: 1 }, 1.19762015],
    // scalar below the fold bound: ZIP and render truth agree
    [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, 0.3265306055545807],
    [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, 0.5714285969734192]
  ];
  for (const [p0, p1, scalar] of cases) {
    assert.ok(Math.abs(__test.radialAxisRatio(p0, p1, scalar) - scalar) < 0.00002);
  }
  assert.equal(__test.radialAxisRatio({ x: 0, y: 0 }, { x: 0, y: 0 }, 0), 1);
});

test("Boolean anchor rebasing preserves absolute child positions", () => {
  const node = {
    x: 10,
    y: 20,
    relativeTransform: [[0, -1, 10], [1, 0, 20]]
  };
  const children = [
    { x: 9, y: 6.5, relativeTransform: [[1, 0, 9], [0, 1, 6.5]] },
    { x: 0, y: -3.5, relativeTransform: [[1, 0, 0], [0, 1, -3.5]] }
  ];
  assert.equal(__test.rebaseContainerByAnchor(node, children, 9, 6.5), true);
  assert.deepEqual(node.relativeTransform, [[0, -1, 3.5], [1, 0, 29]]);
  assert.deepEqual([node.x, node.y], [3.5, 29]);
  assert.deepEqual(children.map(child => [child.x, child.y]), [[0, 0], [-9, -10]]);
  assert.deepEqual(children[1].relativeTransform, [[1, 0, -9], [0, 1, -10]]);
});

test("derived GROUP resize centers only evidenced native structures", () => {
  const parent = { w: 580, h: 600 };
  assert.equal(__test.usesCenteredGroupResize({ w: 213, h: 170, y: 0 }, parent, [
    { rawType: "VECTOR", geomHash: "same" },
    { rawType: "VECTOR", geomHash: "same", relativeTransform: [[-1, 0, 213], [0, 1, 0]] }
  ]), true);
  assert.equal(__test.usesCenteredGroupResize({ w: 560, h: 149, y: 60 }, parent, [
    { rawType: "TEXT", x: 0, y: 0, w: 560 },
    { rawType: "RECTANGLE", x: 10, y: 145, w: 540 }
  ]), false);
});

// Twisted-float encoder (inverse of mgDecFloat): ieee bits rotated left by 1,
// bytes laid out as [S>>>24, S, S>>>8, S>>>16].
function twist(value) {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, false);
  const ieee = view.getUint32(0, false);
  const S = ((ieee << 1) | (ieee >>> 31)) >>> 0;
  return [(S >>> 24) & 0xff, S & 0xff, (S >>> 8) & 0xff, (S >>> 16) & 0xff];
}
const VARINT_NEG1 = [0xff, 0xff, 0xff, 0xff, 0x0f];

test("geometry blob point floats are zero-compressed", () => {
  // One straight segment [v0 → v1]; v0 = (0, 5) stores x as the single-byte
  // zero form. A fixed 4-byte read would swallow the `02` y-tag and derail.
  const blob = Uint8Array.from([
    0x02, 0x01, // 1 segment record
    0x01, 0x04, 0x00, ...VARINT_NEG1, ...VARINT_NEG1, 0x01, // refs [0,-1,-1,1]
    0x02, 0x00, // segment index 0
    0x00,
    0x05, 0x02, // 2 vertex records
    0x01, 0x00, 0x02, ...twist(5), 0x03, 0x00, 0x05, 0x00, 0x00, // v0 = (0, 5)
    0x01, ...twist(7), 0x02, 0x00, 0x03, 0x00, 0x05, 0x01, 0x00, // v1 = (7, 0)
    0x06, 0x01, 0x00 // trailer
  ]);
  const vn = __test.decodeGeometryBlob(blob, 0);
  assert.ok(vn, "blob with zero-compressed floats must decode");
  assert.deepEqual(vn.vertices.map(v => [v.x, v.y]), [[0, 5], [7, 0]]);
  assert.deepEqual(vn.segments, [{
    start: 0, end: 1,
    tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 }
  }]);
});

test("clean four-section empty geometry blob is an empty vector network", () => {
  // Share exports store one canonical empty blob (hash = MD5 of "") for
  // flattened Boolean-result leaves; the ZIP baseline carries {[],[],[]}.
  const empty = Uint8Array.from([0x02, 0x00, 0x03, 0x00, 0x04, 0x00, 0x05, 0x00, 0x06, 0x01, 0x00]);
  assert.deepEqual(__test.decodeGeometryBlob(empty, 0), { segments: [], vertices: [], regions: [] });
  // A derailed parse (garbage tag inside a section) still fails.
  const derailed = Uint8Array.from([0x02, 0x01, 0x77, 0x00]);
  assert.equal(__test.decodeGeometryBlob(derailed, 0), null);
});

test("radial gradient extended 06 sub-object encodes the exact axis ratio", () => {
  // Extended form: 06 carries floats 01/02/04/05 plus 06 = 2×|p1−p0|. The 03
  // scalar and field06 form the ratio branch pair {scalar, field06/scalar};
  // render truth is the LARGER branch (same-design fixtures store opposite
  // branches: 0710-2 scalar 0.4117 ÷→ 3.5696, 0711-1 scalar 3.5696 direct).
  const record = Uint8Array.from([
    0x05, 0x02, // kind RADIAL
    0x0a,
    0x01, 0x02,
    0x03, ...twist(0.5), ...twist(0.25),
    0x04, ...twist(0.5), ...twist(0.75),
    0x05, 0x02,
    0x01, 0x00, 0x02, ...twist(1), 0x00, 0x00, 0x00, 0x00,
    0x01, ...twist(1), 0x02, ...twist(1), 0x00, 0x00, 0x00, 0x00,
    0x06,
    0x01, ...twist(0.79), 0x02, ...twist(-0.29), 0x03, ...twist(0.4),
    0x04, 0x00, 0x05, ...twist(-0.6), 0x06, ...twist(1.0),
    0x00,
    0x00, 0x0c, 0x01, 0x00
  ]);
  const doc = Uint8Array.from([
    ...Array.from("\x011:9\x00\x022:8\x00\x03a0\x00", c => c.charCodeAt(0)),
    ...record
  ]);
  const paints = __test.scanPaints(doc, new TextDecoder("latin1").decode(doc));
  const paint = paints["2:8"] && paints["2:8"][0];
  assert.ok(paint && paint.type === "GRADIENT_RADIAL", "extended 06 record must still decode");
  // ratio = max(0.4, 1.0/0.4) = 2.5; u = (0, 0.5) → a10 = -1/(2·|u|·ratio) = -0.4
  assert.ok(Math.abs(paint.gradientTransform[1][0] - (-0.4)) < 1e-6);
  assert.ok(Math.abs(paint.gradientTransform[0][1] - 1) < 1e-6);
});

test("container meta padding spellings: explicit, empty object, absent object", () => {
  // Explicit values.
  const explicit = Uint8Array.from([
    0x08, 0x01,
    0x09, ...twist(4),
    0x0a, 0x01, ...twist(1), 0x02, ...twist(2), 0x03, ...twist(3), 0x04, ...twist(4), 0x00
  ]);
  const m1 = __test.parseContainerMeta(explicit, 0);
  assert.deepEqual(m1.paddings, { top: 1, right: 2, bottom: 3, left: 4 });
  assert.ok(!m1.paddingsMissing);
  // Empty 0a object → missing (editor default 10 / share default 0).
  const emptyObj = Uint8Array.from([0x0a, 0x00]);
  assert.equal(__test.parseContainerMeta(emptyObj, 0).paddingsMissing, true);
  // Wholly absent 0a → same omitted-field default rule (测试集 0710-2 GROUP/BOOLEAN).
  const absent = Uint8Array.from([0x01, 0x01, 0x02, 0x01, 0x00]);
  const m3 = __test.parseContainerMeta(absent, 0);
  assert.equal(m3.subtype, "BOOLEAN_OPERATION");
  assert.equal(m3.paddingsMissing, true);
});
