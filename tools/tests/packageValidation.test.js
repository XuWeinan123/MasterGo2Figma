const test = require("node:test");
const assert = require("node:assert/strict");
const { validateV2Package } = require("../../ReceiveFromMasterGo/src/ui/packageValidation.js");

const encode = value => new TextEncoder().encode(JSON.stringify(value));
function fixture(records) {
  return {
    "manifest.json": encode({ schema: "mastergo2figma.package.v2", version: 2, pages: [{ id: "p", pageFile: "pages/p/index.json", layerCount: records.length }], stats: { layerCount: records.length }, assets: {} }),
    "pages/p/index.json": encode({ rootNodeIds: ["root"], layerChunks: ["pages/p/layers.json"] }),
    "pages/p/layers.json": encode({ schema: "mastergo2figma.layers.v2", version: 2, records })
  };
}

test("accepts a symmetric reachable v2 package", () => {
  const records = [
    { id: "root", parentId: null, index: 0, childIds: ["child"], props: {} },
    { id: "child", parentId: "root", index: 0, childIds: [], props: {} }
  ];
  const result = validateV2Package(fixture(records));
  assert.equal(result.ok, true);
  assert.match(result.canonicalDigest, /^fnv1a32:[0-9a-f]{8}$/);
});

test("rejects duplicate and dangling records", () => {
  const duplicate = [{ id: "root", parentId: null, index: 0, childIds: [], props: {} }, { id: "root", parentId: null, index: 0, childIds: [], props: {} }];
  assert.equal(validateV2Package(fixture(duplicate)).ok, false);
  const dangling = [{ id: "root", parentId: null, index: 0, childIds: ["missing"], props: {} }];
  assert.equal(validateV2Package(fixture(dangling)).ok, false);
});

test("canonical digest ignores timestamps, chunk paths, and asset aliases", () => {
  function assetFixture(alias, prefix, exportedAt) {
    const records = [{
      id: "root",
      parentId: null,
      index: 0,
      childIds: [],
      props: { geometry: { fills: [{ type: "IMAGE", imageRef: alias }] } }
    }];
    const entries = {
      "manifest.json": encode({
        schema: "mastergo2figma.package.v2",
        version: 2,
        exportedAt,
        pages: [{ id: "p", name: "Page", pageFile: `${prefix}/index.json`, layerCount: 1 }],
        stats: { layerCount: 1 },
        assets: { [alias]: { path: `${prefix}/${alias}.png` } }
      }),
      [`${prefix}/index.json`]: encode({ rootNodeIds: ["root"], layerChunks: [`${prefix}/layers.json`] }),
      [`${prefix}/layers.json`]: encode({ schema: "mastergo2figma.layers.v2", version: 2, records }),
      [`${prefix}/${alias}.png`]: Uint8Array.from([1, 2, 3, 4])
    };
    return entries;
  }

  const first = validateV2Package(assetFixture("asset-a", "pages/a", "2026-01-01T00:00:00Z"));
  const second = validateV2Package(assetFixture("asset-b", "renamed/b", "2026-07-10T00:00:00Z"));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.canonicalDigest, second.canonicalDigest);
});
