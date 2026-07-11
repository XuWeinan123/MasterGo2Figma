"use strict";
// SVG radial-gradient render-truth recovery (SendToFigma export side).
// The synthetic case IS the Tesla vignette: node 65.5677×55.4804, gradient
// ellipse centred mid-shape, vertical major radius 0.7348 (normalized),
// horizontal minor radius 2.6231 → true minor/major ratio 3.5696 — the value
// MasterGo's API folds down to 0.4117 (see docs/MG_DECODER.md).
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const esbuild = require(path.join(root, "SendToFigma", "node_modules", "esbuild"));

function compileModule(relPath) {
  const out = esbuild.buildSync({
    entryPoints: [path.join(root, relPath)],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent"
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const svgTruth = compileModule("SendToFigma/src/serializers/svgGradientTruth.ts");

const NODE_W = 65.5677261352539;
const NODE_H = 55.4803848266602;
const TRUE_RATIO = 3.5695831775665283;
const U = { x: 0, y: 0.7348485 }; // vertical major-axis handle vector (normalized)

const STOPS = `
  <stop stop-color="black" stop-opacity="0"/>
  <stop offset="1" stop-color="black"/>
`;

test("userSpaceOnUse radial SVG yields the render-truth ratio", () => {
  // Ellipse axes in px: horizontal minor·|u|·W? No — axes given directly:
  // vertical (major) radius = 0.7348·H = 40.77px, horizontal = 2.6231·W... in
  // px the x-radius is ratio·|u| normalized units × W = 2.6231·65.5677 = 172.0.
  const rx = TRUE_RATIO * 0.7348485 * NODE_W;
  const ry = 0.7348485 * NODE_H;
  const svg = `<svg><defs>
    <radialGradient id="g" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse"
      gradientTransform="matrix(${rx} 0 0 ${ry} 32.363 24.381)">${STOPS}</radialGradient>
  </defs><rect fill="url(#g)"/></svg>`;
  const grads = svgTruth.parseSvgRadialGradients(svg);
  assert.equal(grads.length, 1);
  const ratio = svgTruth.svgRadialAxisRatio(grads[0], NODE_W, NODE_H, U);
  assert.ok(Math.abs(ratio - TRUE_RATIO) < 1e-4, `ratio ${ratio} != ${TRUE_RATIO}`);
});

test("objectBoundingBox radial SVG yields the same ratio", () => {
  const rx = TRUE_RATIO * 0.7348485;
  const ry = 0.7348485;
  const svg = `<svg><defs>
    <radialGradient id="g" gradientTransform="matrix(${rx} 0 0 ${ry} 0.4936 0.4394)">${STOPS}</radialGradient>
  </defs></svg>`;
  const grads = svgTruth.parseSvgRadialGradients(svg);
  assert.equal(grads.length, 1);
  const ratio = svgTruth.svgRadialAxisRatio(grads[0], NODE_W, NODE_H, U);
  assert.ok(Math.abs(ratio - TRUE_RATIO) < 1e-4, `ratio ${ratio} != ${TRUE_RATIO}`);
});

test("stop matching pairs SVG gradients with serialized paints", () => {
  const svgStops = svgTruth.parseSvgRadialGradients(`<svg>
    <radialGradient id="g" gradientTransform="matrix(1 0 0 1 0 0)">${STOPS}</radialGradient>
  </svg>`)[0].stops;
  const paintStops = [
    { position: 0, color: { r: 0, g: 0, b: 0, a: 0 } },
    { position: 1, color: { r: 0, g: 0, b: 0, a: 1 } }
  ];
  assert.equal(svgTruth.svgStopsMatchPaintStops(svgStops, paintStops), true);
  assert.equal(svgTruth.svgStopsMatchPaintStops(svgStops, [
    { position: 0, color: { r: 1, g: 1, b: 1, a: 0 } },
    { position: 1, color: { r: 0, g: 0, b: 0, a: 1 } }
  ]), false);
});

test("recovered ratio + handles rebuild the exact mg-side transform", () => {
  // Cross-plugin invariant: the zip-side rebuild (handles + SVG ratio) must
  // equal the mg-side native transform (handles + stored scalar).
  const vm = require("vm");
  const fs = require("fs");
  const src = fs.readFileSync(path.join(root, "ReceiveFromMasterGo/src/ui/mgPackage.js"), "utf8");
  const sandbox = { console, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, DataView, Date, RegExp, JSON, Math, Number, String, Boolean, Object, Array, Error, Promise, setTimeout, clearTimeout, window: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "mgPackage.js" });
  const p0 = { x: 0.4935898780822754, y: 0.4393939971923828 };
  const p1 = { x: 0.4935898780822754, y: 1.1742424964904785 };
  const expected = sandbox.window.MasterGoMg.__test.radialGradientTransform(p0, p1, TRUE_RATIO);
  // zip-side: minorEnd = p0 + rot90(u)·ratio, A = 0.5·inv([u v]) — same math.
  const u = { x: p1.x - p0.x, y: p1.y - p0.y };
  const minorEnd = { x: p0.x - u.y * TRUE_RATIO, y: p0.y + u.x * TRUE_RATIO };
  const vx = minorEnd.x - p0.x, vy = minorEnd.y - p0.y;
  const det = u.x * vy - vx * u.y;
  const inv = 0.5 / det;
  const a00 = vy * inv, a01 = -vx * inv, a10 = -u.y * inv, a11 = u.x * inv;
  const rebuilt = [
    [a00, a01, 0.5 - (a00 * p0.x + a01 * p0.y)],
    [a10, a11, 0.5 - (a10 * p0.x + a11 * p0.y)]
  ];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
    assert.ok(Math.abs(rebuilt[r][c] - expected[r][c]) < 1e-9, `[${r}][${c}] ${rebuilt[r][c]} != ${expected[r][c]}`);
  }
});
