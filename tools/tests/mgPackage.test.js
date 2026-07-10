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

test("radial-gradient axis scalar resolves the Figma minor-axis ratio", () => {
  const cases = [
    // 2 × |p1 − p0| / scalar form (old non-square fixture, scalar > 1)
    [{ x: 0.49358985, y: 0.43939397 }, { x: 0.49358985, y: 1.1742425 }, 3.5695839, 0.4117249],
    [{ x: 0.49425292, y: 0.30769229 }, { x: 0.49425292, y: 0.76923078 }, 1.6498741, 0.559487],
    [{ x: 0.50000006, y: 0.54166669 }, { x: 0.5, y: 1 }, 1.19762015, 0.765407],
    // direct-ratio form (2026-07-10 插件测试.mg, |p1 − p0| = 0.5, scalar < 1)
    [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, 0.3265306055545807, 0.3265306055545807],
    [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, 0.5714285969734192, 0.5714285969734192]
  ];
  for (const [p0, p1, scalar, expected] of cases) {
    assert.ok(Math.abs(__test.radialAxisRatio(p0, p1, scalar) - expected) < 0.00002);
  }
  assert.equal(__test.radialAxisRatio({ x: 0, y: 0 }, { x: 0, y: 0 }, 3), 1);
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
