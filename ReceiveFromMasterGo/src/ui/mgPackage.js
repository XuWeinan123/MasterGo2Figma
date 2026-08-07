(function(global) {
  "use strict";

  function decodeUtf8(bytes) {
    return new TextDecoder("utf-8").decode(bytes);
  }

  function hasManifestPath(zipEntries) {
    return !!(zipEntries && (zipEntries["manifest.json"] || Object.keys(zipEntries).some(path => path.endsWith("/manifest.json"))));
  }

    // ---- MasterGo .mg support -------------------------------------------------
    // A .mg file is a zip containing { document, meta.json, images/ }. The
    // "document" embeds every scene node as a null-terminated JSON blob shaped
    // like [{...node props...}, []]. Those props use the exact same schema as
    // SendToFigma's v2 records (same "scence" typo, geometry/layout/blend/...),
    // so we extract them and repackage as an in-memory v2 export.

    function isMgPackage(fileName, zipEntries) {
      if (typeof fileName === "string" && fileName.toLowerCase().endsWith(".mg")) return true;
      // Structural fallback: looks like a MasterGo file but has no v2 manifest.
      return !!getEntryByName(zipEntries, "document") && !hasManifestPath(zipEntries);
    }

    function getEntryByName(zipEntries, name) {
      if (zipEntries[name]) return zipEntries[name];
      const key = Object.keys(zipEntries).find(path => path === name || path.endsWith("/" + name));
      return key ? zipEntries[key] : null;
    }

    // ---- Native binary ("turtle") decode — see docs/MG_DECODER.md for the full spec ----
    // Numbers are float32 with a bit-twist: stored [s0,s1,s2,s3] -> S=[s0,s3,s2,s1],
    // value = float32_be( rotateRight1(S) ). The rotate (not a plain shift) preserves
    // the sign bit, so negatives decode correctly.
    const mgFloatView = new DataView(new ArrayBuffer(4));
    function mgDecFloat(bytes, off) {
      if (off + 4 > bytes.length) return 0;
      const S = ((bytes[off] << 24) | (bytes[off + 3] << 16) | (bytes[off + 2] << 8) | bytes[off + 1]) >>> 0;
      const ieee = (((S >>> 1) | ((S & 1) << 31)) >>> 0);
      mgFloatView.setUint32(0, ieee, false);
      const v = mgFloatView.getFloat32(0, false);
      return (isFinite(v) && Math.abs(v) < 1e6) ? v : 0;
    }

    function mgMakeSolidPaint(r, g, b, a) {
      return { type: "SOLID", visible: true, opacity: a == null ? 1 : a, blendMode: "NORMAL", color: { r: r, g: g, b: b } };
    }

    const MG_GRADIENT_TYPE = {
      1: "GRADIENT_LINEAR",
      2: "GRADIENT_RADIAL",
      3: "GRADIENT_ANGULAR",
      4: "GRADIENT_DIAMOND"
    };

    function mgMakeImagePaint(imageRef, scaleMode, ratio) {
      return {
        type: "IMAGE",
        visible: true,
        opacity: 1,
        blendMode: "NORMAL",
        scaleMode: scaleMode || "FILL",
        filters: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0, hue: 0 },
        rotation: 0,
        ratio: ratio == null ? 0.5 : ratio,
        imageRef: imageRef
      };
    }

    function mgMul3(m1, m2) {
      const res = [];
      for (let i = 0; i < m1.length; i++) {
        res[i] = [];
        for (let j = 0; j < m2[0].length; j++) {
          let sum = 0;
          for (let k = 0; k < m2.length; k++) sum += m1[i][k] * m2[k][j];
          res[i][j] = sum;
        }
      }
      return res;
    }

    // Ports of SendToFigma's gradient-transform math (serializers/universal.ts):
    // the baseline zips are produced with these exact formulas, so reusing them
    // keeps native decode bit-compatible with real exports.
    function mgLinearGradientTransform(p0, p1) {
      const x3 = p0.x, y3 = p0.y, x4 = p1.x, y4 = p1.y;
      const len = Math.sqrt((x4 - x3) * (x4 - x3) + (y4 - y3) * (y4 - y3));
      if (!isFinite(len) || len <= 0) return [[1, 0, 0], [0, 1, 0]];
      const m1 = [[1, 0, 0], [0, 1, 0.5], [0, 0, 1]];
      const m2 = [[1 / len, 0, 0], [0, 1, 0], [0, 0, 1]];
      const sina = (y3 - y4) / len, cosa = (x4 - x3) / len;
      const m3 = [[cosa, -sina, 0], [sina, cosa, 0], [0, 0, 1]];
      const m4 = [[1, 0, -x3], [0, 1, -y3], [0, 0, 1]];
      const m = mgMul3(mgMul3(mgMul3(m2, m1), m3), m4);
      return [m[0], m[1]];
    }

    // Pixel-space variant (mirrors SendToFigma's getResultArrayByTwoPoint with
    // dims): MasterGo renders linear-gradient bands perpendicular to the
    // handle axis in PIXEL space, so the Figma matrix must fold in the node's
    // aspect. Reduces exactly to mgLinearGradientTransform when w == h or the
    // axis is axis-aligned.
    function mgLinearGradientTransformPx(p0, p1, w, h) {
      if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return null;
      const dx = (p1.x - p0.x) * w, dy = (p1.y - p0.y) * h;
      const l2 = dx * dx + dy * dy;
      // Perp (v) row scale w·h·|p1−p0| matches the legacy normalized rotation
      // wherever the legacy math was correct (see getResultArrayByTwoPoint).
      const nx = p1.x - p0.x, ny = p1.y - p0.y;
      const e = w * h * Math.sqrt(nx * nx + ny * ny);
      if (!isFinite(l2) || l2 <= 0 || !isFinite(e) || e <= 0) return null;
      return [
        [w * dx / l2, h * dy / l2, -(p0.x * w * dx + p0.y * h * dy) / l2],
        [-w * dy / e, h * dx / e, 0.5 + (p0.x * w * dy - p0.y * h * dx) / e]
      ];
    }

    // Radial/angular/diamond: center p0, major-axis end p1, and the minor axis
    // as the major axis rotated 90° scaled by `ratio` (1 = circular).
    function mgRadialGradientTransform(p0, p1, ratio) {
      const ux = p1.x - p0.x, uy = p1.y - p0.y;
      const r = (isFinite(ratio) && ratio > 0) ? ratio : 1;
      const vx = -uy * r, vy = ux * r;
      const det = ux * vy - vx * uy;
      if (!isFinite(det) || Math.abs(det) < 1e-9) return [[0, 1, 0], [-1, 0, 1]];
      const inv = 0.5 / det;
      const a00 = vy * inv, a01 = -vx * inv;
      const a10 = -uy * inv, a11 = ux * inv;
      const t0 = 0.5 - (a00 * p0.x + a01 * p0.y);
      const t1 = 0.5 - (a10 * p0.x + a11 * p0.y);
      const nz = n => (n === 0 ? 0 : n);
      return [[nz(a00), nz(a01), nz(t0)], [nz(a10), nz(a11), nz(t1)]];
    }

    // The gradient sub-object's tag 03 IS the Figma minor/major handle ratio,
    // stored directly (absent/0 = circular). Settled 2026-07-11 against visual
    // truth: the Tesla vignette (scalar 3.5696) renders in MasterGo as a wide
    // flat ellipse — the direct reading — while the baseline ZIPs carry
    // `min(scalar, 2|major|/scalar)` because MasterGo's plugin API exposes a
    // gradient transform built from that FOLDED ratio (API disagrees with the
    // renderer whenever scalar² > 2|major|; the fold is not invertible, so
    // SendToFigma exports cannot recover the true value). The 2026-07-10
    // min() rule reproduced the fold, i.e. the exporter bug, not the render.
    function mgRadialAxisRatio(p0, p1, axisScale) {
      return (isFinite(axisScale) && axisScale > 0) ? axisScale : 1;
    }

    function mgBasename(path) {
      if (!path) return "";
      const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
      return slash >= 0 ? path.slice(slash + 1) : path;
    }

    // RADIAL ratio semantics come in two bare spellings (extended/majorLen2
    // form is arbitrated separately at scan time):
    //   · field 03 alone (native-drawn): 03 IS the final normalized ratio —
    //     set0 径向 stores 0.3265 = the v2 value, and set1/0711-2/0711-3
    //     radials (both handle orientations) all match the direct read.
    //   · 02/03/04 conversion chain (Figma-imported): the final ratio is
    //     PER-NODE — the same chain entry (03=0.10662, 04=0.3265) yields v2
    //     3.0625 on the 210×120 owner (0.10662×1.75²) and 9.3789 on shared
    //     100×100 strokes rectangles (0.10662×1²) — so field 04 is only the
    //     owner-node cache and the real rule is ×(w/h)² for x-dominant
    //     handles, direct for y-dominant (vertical reference frame). Diamond
    //     and angular gradients read 03 directly even when a chain is
    //     present (菱形 on 210×120: v2 = 9.3789), so only kind 2 defers.
    // The transform is finalized per node in mgNativeProps via this
    // enumerable temp (record clones carry it; finalize strips it).
    function mgAttachRadialMeta(paint, kind, gradient, p0, p1) {
      if (kind === 2 && !(gradient.majorLen2 > 0) &&
          isFinite(gradient.ratioNorm) && gradient.ratioNorm > 0 &&
          isFinite(gradient.ratio) && gradient.ratio > 0) {
        paint.__mgRadialMeta = { p0: { x: p0.x, y: p0.y }, p1: { x: p1.x, y: p1.y }, ratio: gradient.ratio };
      }
      return paint;
    }

    function mgFinalizeRadialPaints(list, w, h) {
      if (!Array.isArray(list)) return;
      for (const paintEntry of list) {
        if (paintEntry && paintEntry.__mgLinearMeta) {
          const lm = paintEntry.__mgLinearMeta;
          delete paintEntry.__mgLinearMeta;
          if (paintEntry.type === "GRADIENT_LINEAR") {
            const t = mgLinearGradientTransformPx(lm.p0, lm.p1, w, h);
            if (t) paintEntry.gradientTransform = t;
          }
        }
        if (!paintEntry || !paintEntry.__mgRadialMeta) continue;
        const meta = paintEntry.__mgRadialMeta;
        delete paintEntry.__mgRadialMeta;
        if (paintEntry.type !== "GRADIENT_RADIAL") continue;
        if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) continue;
        const uxPx = (meta.p1.x - meta.p0.x) * w;
        const uyPx = (meta.p1.y - meta.p0.y) * h;
        if (Math.abs(uxPx) <= Math.abs(uyPx)) continue; // vertical frame — stored ratio is already final
        const aspect = w / h;
        paintEntry.gradientTransform = mgRadialGradientTransform(meta.p0, meta.p1, meta.ratio * aspect * aspect);
      }
    }

    // Default-variant name wash (mirrors MasterGo's plugin API): when every
    // comma-separated key of a variant name ends with an [a0] order marker,
    // strip ONE marker layer per key; if the result carries no markers at
    // all, re-join canonically with ", " (统一集 0:495 → "Size=Small,
    // Type=Primary"), otherwise keep the raw comma join (0:110 keeps
    // "…,Variant[a0]=Primary,…"). Any non-conforming pair aborts the wash.
    function mgWashDefaultVariantName(name) {
      if (!name || name.indexOf("[a0]=") < 0) return name;
      const pairs = name.split(",");
      const washed = [];
      for (const pair of pairs) {
        const eq = pair.indexOf("=");
        if (eq <= 0) return name;
        const key = pair.slice(0, eq);
        if (key.slice(-4) !== "[a0]") return name;
        washed.push(key.slice(0, -4) + pair.slice(eq));
      }
      const clean = washed.every(p => p.indexOf("[") < 0);
      return clean ? washed.join(", ") : washed.join(",");
    }

    function mgPlausibleScalar(v) {
      return isFinite(v) && Math.abs(v) >= 1e-6 && Math.abs(v) < 1e6;
    }

    function mgReadFloatTag(bytes, str, tag, start, end, byteBase) {
      // The tag byte can also occur inside another field's float payload (e.g.
      // `0d 0f` before the real `0f` height on masked rectangles), and some
      // payloads start with the tag byte itself (`0f 0f 83 00 00 00` for
      // height=16). Walk every occurrence and take the first plausible decode;
      // denormal garbage from a mid-payload hit is rejected by the 1e-6 floor.
      let p = str.indexOf(String.fromCharCode(tag), start);
      while (p >= 0 && p < end) {
        const abs = (byteBase || 0) + p;
        const value = mgDecFloat(bytes, abs + 1);
        if (mgPlausibleScalar(value)) return value;
        if (abs + 5 < bytes.length && bytes[abs + 1] === tag) {
          const shifted = mgDecFloat(bytes, abs + 2);
          if (mgPlausibleScalar(shifted)) return shifted;
        }
        p = str.indexOf(String.fromCharCode(tag), p + 1);
      }
      return 0;
    }

    function mgReadCString(bytes, start, end) {
      let q = start;
      while (q < end && bytes[q] !== 0x00) q++;
      return q < end ? { text: decodeUtf8(bytes.subarray(start, q)), end: q } : null;
    }

    function mgDecodeFontString(fontString) {
      if (!fontString) return null;
      const parts = fontString.split("/");
      if (parts.length < 2) return null;
      const family = parts[0] || "Inter";
      const rawStyle = parts[1] || "Regular";
      const styleMap = { SemiBold: "Semi Bold", DemiBold: "Semi Bold" };
      return { family: family, style: styleMap[rawStyle] || rawStyle };
    }

    function mgNormalizeFontName(fontName) {
      if (!fontName) return fontName;
      const styleMap = { SemiBold: "Semi Bold", DemiBold: "Semi Bold" };
      return {
        family: fontName.family || "Inter",
        style: styleMap[fontName.style] || fontName.style || "Regular"
      };
    }

    function mgGuessTextFontSize(n) {
      const h = Math.abs(n && n.h ? n.h : 0);
      if (h >= 55) return 22;
      if (n && n.name && n.name.indexOf("Card_Description") >= 0) return 12;
      if (h >= 28) return 24;
      if (h >= 21) return 18;
      if (h >= 18.5) return 16;
      if (h >= 16.5) return 14;
      if (h >= 15.5) return 13;
      if (h >= 14) return 12;
      return 16;
    }

    // Sequentially parse the `1c 08` TEXT object's font-run list:
    //   [01 <alignH> 02 <alignV> 03 <autoResize>]  (one-byte values < 0x10)
    //   06 <runCount>
    //   runCount × ( 01 <sortId> 00  02 <text> 00  03 <styleRef> 00
    //                05 <glyphCount> <glyphCount × 2 zero-floats>
    //                06 01 <fontString "Family/Style/Version …"> 00
    //                07 <glyphCount> <glyphCount × (00 <LEB128 glyphId>)> 00 )
    // Runs are stored in arbitrary order; the fractional-index sortId gives the
    // character order. Returns null on any structural violation so callers can
    // fall back to the legacy heuristics. Offsets are UTF-16 code units.
    function mgParseFontRuns(bytes, start, end) {
      let p = start;
      for (let guard = 0; guard < 4; guard++) {
        const tag = bytes[p];
        if ((tag === 0x01 || tag === 0x02 || tag === 0x03) && bytes[p + 1] < 0x10) { p += 2; continue; }
        break;
      }
      if (bytes[p] !== 0x06) return null;
      const runCount = bytes[p + 1];
      if (runCount < 1 || runCount > 64) return null;
      p += 2;
      const runs = [];
      for (let i = 0; i < runCount; i++) {
        if (bytes[p] !== 0x01) return null;
        const sid = mgReadCString(bytes, p + 1, Math.min(end, p + 12));
        // The fractional-index alphabet is printable ASCII including space
        // (`b&n`, `b$ `), not just alnum — library-bearing exports use the
        // full base-95 range.
        if (!sid || !/^[\x20-\x7e]{1,8}$/.test(sid.text)) return null;
        p = sid.end + 1;
        if (bytes[p] !== 0x02) return null;
        const txt = mgReadCString(bytes, p + 1, end);
        if (!txt) return null;
        p = txt.end + 1;
        if (bytes[p] !== 0x03) return null;
        const ref = mgReadCString(bytes, p + 1, Math.min(end, p + 40));
        if (!ref || !/^[0-9]+:[0-9A-Za-z]+(?:\/[0-9]+:[0-9A-Za-z]+)*$/.test(ref.text)) return null;
        p = ref.end + 1;
        let fontString = null;
        if (bytes[p] === 0x05) {
          const glyphCount = bytes[p + 1];
          p += 2;
          for (let g = 0; g < glyphCount; g++) {
            p = mgReadZeroFloat(bytes, p).next;
            p = mgReadZeroFloat(bytes, p).next;
            if (p >= end) return null;
          }
        }
        if (bytes[p] === 0x06 && bytes[p + 1] === 0x01) {
          const fs = mgReadCString(bytes, p + 2, end);
          if (!fs) return null;
          fontString = fs.text;
          p = fs.end + 1;
        } else if (bytes[p] === 0x06 && bytes[p + 1] === 0x00) {
          // Explicit-empty font string. Leaving it unconsumed stranded `p` on
          // the `06`, so the NEXT run's `01` tag never matched and the whole
          // multi-run parse bailed to the legacy single-string fallback —
          // "9:41" came back as just "1" (0806 status bar).
          p += 2;
        }
        if (bytes[p] === 0x07) {
          const idCount = bytes[p + 1];
          p += 2;
          for (let g = 0; g < idCount; g++) {
            if (bytes[p] !== 0x00) return null;
            p++;
            while (p < end && (bytes[p] & 0x80)) p++;
            p++;
          }
          if (bytes[p] !== 0x00) return null; // glyph-id table terminator
          p++;
        }
        if (p >= end) return null;
        // Glyphless runs (library-bearing exports) end with an explicit 00
        // terminator; glyph-bearing runs already consumed theirs via the 07
        // table. Consume it so the next run's 01 tag lines up.
        if (bytes[p] === 0x00) p++;
        runs.push({ sortId: sid.text, text: txt.text, styleRef: ref.text, fontString: fontString });
      }
      runs.sort((a, b) => (a.sortId < b.sortId ? -1 : a.sortId > b.sortId ? 1 : 0));
      let offset = 0;
      for (const run of runs) {
        run.start = offset;
        run.end = offset + run.text.length;
        offset = run.end;
      }
      return { runs: runs, nextOffset: p };
    }

    function mgDecodeTextDetails(bytes, str, start, end, jt) {
      if (jt < 0) return {};
      const utf8 = new TextDecoder("utf-8");
      const local = start + jt;

      // Preferred path: structured font runs (each run carries its own text,
      // style ref, and font string). Characters are the sorted-run concat.
      const parsed = mgParseFontRuns(bytes, local + 2, end);
      if (parsed && parsed.runs.length) {
        const runs = parsed.runs;
        const characters = runs.map(run => run.text).join("");
        const fontName = runs[0].fontString ? mgDecodeFontString(runs[0].fontString) : null;
        // The color-run table (`09 <count>`, [start,end) + paintRef) sits after
        // the font runs; scan from there with the true character count.
        const styledRuns = mgParseTextRuns(bytes, parsed.nextOffset, end, characters.length);
        return {
          characters: characters,
          charactersFromRuns: true,
          fontName: fontName,
          fontRuns: runs,
          firstStyleRef: runs[0].styleRef,
          styledRuns: styledRuns
        };
      }

      // Legacy fallback: first plausible `02 <text> 00 03` string + font-string
      // regex. Kept for older .mg layouts the run parser does not recognize.
      let characters = null;
      let fontName = null;
      for (let p = local + 2; p < end - 2; p++) {
        if (bytes[p] !== 0x02) continue;
        const c = mgReadCString(bytes, p + 1, end);
        if (!c || c.end + 1 >= end || bytes[c.end + 1] !== 0x03) continue;
        if (c.text && c.text.length < 500 && !/^[0-9]+:[0-9A-Za-z]+$/.test(c.text)) {
          characters = c.text;
          break;
        }
      }

      const text = utf8.decode(bytes.subarray(local, Math.min(end, local + 1800)));
      const fontMatch = /([A-Za-z0-9 ._-]+\/(?:Regular|Bold|SemiBold|Medium|Light|Black|Italic|Thin|ExtraBold|ExtraLight)[^|\u0000]*)/.exec(text);
      if (fontMatch) fontName = mgDecodeFontString(fontMatch[1]);
      const styledRuns = characters ? mgParseTextRuns(bytes, local + 2, end, characters.length) : null;
      return { characters: characters, fontName: fontName, styledRuns: styledRuns };
    }

    function mgParseTextRuns(bytes, start, end, characterCount) {
      for (let p = start; p + 2 < end; p++) {
        if (bytes[p] !== 0x09) continue;
        const count = bytes[p + 1];
        // count=1 is real (library-bearing exports write a single full-cover
        // color run whose paint overrides a stale template ref); the walk's
        // structural gates (valid ID ref, terminator, runEnd == charCount)
        // hold the false-positive line.
        if (count < 1 || count > 32) continue;
        let q = p + 2;
        let previousEnd = 0;
        const runs = [];
        let valid = true;
        for (let i = 0; i < count && valid; i++) {
          let runStart = previousEnd;
          let runEnd = null;
          let paintRef = null;
          let terminated = false;
          while (q < end) {
            const tag = bytes[q++];
            if (tag === 0x00) { terminated = true; break; }
            if (tag === 0x01 || tag === 0x02) {
              if (q >= end) { valid = false; break; }
              // Boundaries are LEB128 varints (single byte below 128; long
              // texts store e.g. 218 as `da 01`).
              const r = mgReadVarint(bytes, q);
              if (!isFinite(r.value)) { valid = false; break; }
              q = r.next;
              if (tag === 0x01) runStart = r.value;
              else runEnd = r.value;
              continue;
            }
            if (tag === 0x03) {
              const ref = mgReadCString(bytes, q, end);
              if (!ref || !/^[0-9]+:[0-9A-Za-z]+$/.test(ref.text)) { valid = false; break; }
              paintRef = ref.text;
              q = ref.end + 1;
              continue;
            }
            valid = false;
            break;
          }
          if (!terminated || runEnd === null || runStart < previousEnd || runEnd <= runStart || runEnd > characterCount || !paintRef) {
            valid = false;
            break;
          }
          runs.push({ start: runStart, end: runEnd, paintRef: paintRef });
          previousEnd = runEnd;
        }
        if (valid && runs.length === count && previousEnd === characterCount) return runs;
      }
      return null;
    }

    function mgReadTransformXY(bytes, start, end) {
      const result = { x: 0, y: 0, relativeTransform: null, rotation: 0 };
      for (let off = start; off < end - 5; off++) {
        if (bytes[off] !== 0x18) continue;
        const mode = bytes[off + 1];
        // `18 01 <x> [02 <y>]` or `18 02 <y>` (x omitted when 0); matrix fields
        // 03=m00 04=m11 05=m01 06=m10 follow either form, defaults identity.
        if (mode !== 0x01 && mode !== 0x02) continue;
        let scan;
        if (mode === 0x01) {
          result.x = mgDecFloat(bytes, off + 2);
          scan = off + 6;
          if (scan < end && bytes[scan] === 0x02) {
            result.y = mgDecFloat(bytes, scan + 1);
            scan += 5;
          }
        } else {
          result.y = mgDecFloat(bytes, off + 2);
          scan = off + 6;
        }
        let m00 = 1, m01 = 0, m10 = 0, m11 = 1, sawMatrix = false;
        for (let p = scan; p < end - 5; p += 5) {
          if (bytes[p] === 0x03) { m00 = mgDecFloat(bytes, p + 1); sawMatrix = true; continue; }
          if (bytes[p] === 0x04) { m11 = mgDecFloat(bytes, p + 1); sawMatrix = true; continue; }
          if (bytes[p] === 0x05) { m01 = mgDecFloat(bytes, p + 1); sawMatrix = true; continue; }
          if (bytes[p] === 0x06) { m10 = mgDecFloat(bytes, p + 1); sawMatrix = true; continue; }
          break;
        }
        if (sawMatrix &&
            Math.abs(m00) <= 1.001 && Math.abs(m01) <= 1.001 && Math.abs(m10) <= 1.001 && Math.abs(m11) <= 1.001) {
          result.relativeTransform = [[m00, m01, result.x], [m10, m11, result.y]];
          result.rotation = mgRotationFromMatrix(m00, m10);
        }
        return result;
      }
      return result;
    }

    // Paint/style registry. Nodes reference paint/style ids via tag 15 (fill)
    // and tag 16 (stroke). The actual paint is stored in child records whose
    // parent id is the referenced style id.
    // Zero-compressed float: a value of exactly 0 is stored as the single byte
    // 0x00; anything else is the usual 4-byte twisted float.
    function mgReadZFloatAt(bytes, p) {
      if (bytes[p] === 0x00) return { value: 0, next: p + 1 };
      return { value: mgDecFloat(bytes, p), next: p + 4 };
    }

    // 4=TILE observed on the 0712-3 specimen (round-tripped from Figma); the
    // legacy 2=TILE mapping is kept for the older fixtures.
    const MG_IMAGE_SCALE_MODE = { 0: "FILL", 1: "FIT", 2: "TILE", 3: "CROP", 4: "TILE" };
    // Image-adjustment fields inside the paint's `0d` object. The numbering is
    // a BIT MASK, not a counter (1/2/4/8 …), so the unobserved Figma filters
    // — temperature, tint, highlights, shadows — are the higher bits; reading
    // an unmapped one as a float and ignoring it stays forward-compatible.
    const MG_IMAGE_FILTER_FIELDS = { 1: "contrast", 2: "exposure", 4: "saturation", 8: "hue" };
    // MasterGo's default #D8D8D8 fill: referenced by "default fill" paint
    // records that carry no explicit color of their own.
    const MG_DEFAULT_FILL_GRAY = Math.fround(216 / 255);

    // Paint child record body (after `01 <id> 00 02 <ref> 00 03 <sort> 00`),
    // fields in ascending tag order, floats zero-compressed:
    //   05 <kind>            1=LINEAR 2=RADIAL 3=ANGULAR 4=DIAMOND 5=IMAGE (absent = SOLID)
    //   06 <b>               visibility flag; 00 = hidden
    //   07 <b>               unknown flag
    //   08 <a><r><g><b>      solid color / gradient fallback color
    //   09 <float>           unknown scalar
    //   0a { 01 <kind> 03 <p0 x y> 04 <p1 x y> 05 <n stops: [01 <pos>] 02 <argb> 00> 06 { 03 <axis ratio> } } 00
    //   0b { 01 <b> 02 <ratio> 03 <image path> 00 04 <scaleMode: 0=FILL 3=FIT …> 07 <w> 08 <h> } 00
    //   0c <b> 0d <b>        trailer flags
    //   00                   end of record
    function mgParsePaintRecord(bytes, start, end) {
      let p = start;
      let visible = true, kind = 0, color = null, gradient = null, image = null, sawTail = false;
      // Paint opacity has TWO spellings: the standalone `09` field and the
      // alpha channel of the `08` color. Most records use the alpha (0806
      // fixture: red 10% stores `08 <a=0.1> <r=1> <g=0> <b=0>` and no `09`),
      // so a default-1 `09` must NOT overwrite it — that flattened every
      // translucent fill/stroke on the page to fully opaque.
      let opacity = null;
      let filters = null;
      function zfloat() { const r = mgReadZFloatAt(bytes, p); p = r.next; return r.value; }

      function parseGradientObject() {
        const g = { kind: 0, p0: null, p1: null, stops: null, ratio: 0, ratioNorm: 0, majorLen2: 0 };
        for (;;) {
          if (p >= end) return null;
          const t = bytes[p++];
          if (t === 0x00) return g;
          if (t === 0x01) { g.kind = bytes[p++]; continue; }
          if (t === 0x02) { p++; continue; }
          if (t === 0x03) { g.p0 = { x: zfloat(), y: zfloat() }; continue; }
          if (t === 0x04) { g.p1 = { x: zfloat(), y: zfloat() }; continue; }
          if (t === 0x05) {
            const n = bytes[p++];
            if (n > 64) return null;
            const stops = [];
            for (let i = 0; i < n; i++) {
              let pos = 0, col = null;
              for (;;) {
                if (p >= end) return null;
                const st = bytes[p++];
                if (st === 0x00) break;
                if (st === 0x01) { pos = zfloat(); continue; }
                if (st === 0x02) { col = { a: zfloat(), r: zfloat(), g: zfloat(), b: zfloat() }; continue; }
                return null;
              }
              if (col) stops.push({ position: pos, color: col });
            }
            g.stops = stops;
            continue;
          }
          if (t === 0x06) {
            for (;;) {
              if (p >= end) return null;
              const st = bytes[p++];
              if (st === 0x00) break;
              if (st === 0x03) { g.ratio = zfloat(); continue; }
              // Field 04 = the NORMALIZED-FINAL axis ratio. Figma-imported
              // radials store a conversion chain (02 px-frame, 03
              // vertical-frame, 04 normalized) — 统一集 径向 Radial stores
              // 03=0.10662/04=0.3265 and star 03=0.9375/04=1.6667, where the
              // 04 values reproduce the v2 transforms exactly; native
              // MasterGo radials (set0 era) write field 03 alone and 03 IS
              // final. Prefer 04 when present in the bare form.
              if (st === 0x04) { g.ratioNorm = zfloat(); continue; }
              // Extended form (测试集 0710-2 radials): the 06 sub-object also
              // carries floats 01/02/05 (ellipse-frame values we don't need)
              // and 06 = 2 × |p1 − p0|. Its presence marks the encoding
              // where the 03 scalar is a pure divisor: ratio = field06 / 03.
              if (st === 0x01 || st === 0x02 || st === 0x05) { zfloat(); continue; }
              if (st === 0x06) { g.majorLen2 = zfloat(); continue; }
              return null;
            }
            continue;
          }
          return null;
        }
      }

      function parseImageObject() {
        const img = { ratio: 0.5, path: null, scaleMode: 0 };
        for (;;) {
          if (p >= end) return null;
          const t = bytes[p++];
          if (t === 0x00) return img;
          if (t === 0x01) { img.scaleMode = bytes[p++]; continue; } // 0=FILL 1=FIT 2=CROP 3=TILE
          if (t === 0x02) { img.ratio = zfloat(); continue; }
          if (t === 0x03) {
            if (bytes[p] === 0x00) { p++; continue; } // explicit-empty path (0711-3)
            const c = mgReadCString(bytes, p, end);
            if (!c) return null;
            img.path = c.text;
            p = c.end + 1;
            continue;
          }
          if (t === 0x04) {
            // Crop rect sub-object (0712-3): fields 01..04 = x, y, w, h of
            // the crop window (image-pixel units; normalize against the
            // intrinsic size from fields 07/08). Fields 05/06 unobserved.
            const rect = {};
            for (;;) {
              if (p >= end) return null;
              const st = bytes[p++];
              if (st === 0x00) break;
              if (st >= 0x01 && st <= 0x06) {
                const v = zfloat();
                if (st === 0x01) rect.x = v;
                else if (st === 0x02) rect.y = v;
                else if (st === 0x03) rect.w = v;
                else if (st === 0x04) rect.h = v;
                continue;
              }
              return null;
            }
            img.cropRect = rect;
            continue;
          }
          if (t === 0x07 || t === 0x08) {
            const v = zfloat();
            if (t === 0x07) img.intrinsicW = v; else img.intrinsicH = v;
            continue;
          }
          return null;
        }
      }

      while (p < end) {
        const t = bytes[p++];
        if (t === 0x00) break;
        if (t === 0x04) { p++; continue; } // leading flag, 0711-3 style-library paint children
        if (t === 0x05) { kind = bytes[p++]; continue; }
        if (t === 0x06) { visible = bytes[p++] !== 0x00; continue; }
        if (t === 0x07) { p++; continue; }
        if (t === 0x08) { color = { a: zfloat(), r: zfloat(), g: zfloat(), b: zfloat() }; continue; }
        if (t === 0x09) { opacity = zfloat(); continue; } // paint opacity
        if (t === 0x0a) { gradient = parseGradientObject(); if (!gradient) return null; continue; }
        if (t === 0x0b) { image = parseImageObject(); if (!image) return null; continue; }
        if (t === 0x0c) { p++; sawTail = true; continue; }
        if (t === 0x0d) {
          // Image adjustments — a nested object, NOT a one-byte flag. The flag
          // reading survived only because an unadjusted paint spells it `0d 00`
          // (empty object), which consumes the same two bytes by luck. The
          // moment a real filter appeared the walk landed inside the float
          // payload and threw the WHOLE paint away, so three retouched photos
          // on the 汇总 page imported with no fill at all.
          sawTail = true;
          filters = {};
          for (;;) {
            if (p >= end) return null;
            const st = bytes[p++];
            if (st === 0x00) break;
            // Field ids are single bits; anything else means this record is
            // not a paint (garbage records reach here with ids like 0x24).
            if (st & (st - 1)) return null;
            const value = zfloat();
            const name = MG_IMAGE_FILTER_FIELDS[st];
            if (name) filters[name] = value;
          }
          continue;
        }
        return null; // unknown tag: not a paint record
      }

      if (kind === 5 && image && image.path) {
        const paint = mgMakeImagePaint(mgBasename(image.path), MG_IMAGE_SCALE_MODE[image.scaleMode] || "FILL", image.ratio);
        paint.visible = visible;
        if (opacity !== null) paint.opacity = opacity;
        if (filters) for (const key in filters) paint.filters[key] = filters[key];
        // CROP placement rect (04 sub-object): the image's DISPLAY rect in
        // node-local units (0712-3: node 150×96 with a centered 50% crop
        // stores x=-75 y=-48 w=300 h=192). The Figma imageTransform needs the
        // NODE size — carry the raw rect; mgNativeProps computes
        // [[nodeW/w, 0, -x/w], [0, nodeH/h, -y/h]] and strips the temp field.
        // (The zip exporter drops the crop window entirely — this exceeds
        // baseline parity by one accepted deep-diff row per cropped image.)
        if (paint.scaleMode === "CROP" && image.cropRect &&
            isFinite(image.cropRect.w) && image.cropRect.w > 0 &&
            isFinite(image.cropRect.h) && image.cropRect.h > 0) {
          paint.__mgCropRect = {
            x: image.cropRect.x || 0,
            y: image.cropRect.y || 0,
            w: image.cropRect.w,
            h: image.cropRect.h
          };
        }
        return paint;
      }
      if (kind >= 1 && kind <= 4 && gradient && gradient.stops && gradient.stops.length >= 2) {
        // Share exports omit the gradient handles for the default vertical
        // top-to-bottom orientation.
        const p0 = gradient.p0 || { x: 0.5, y: 0 };
        const p1 = gradient.p1 || { x: 0.5, y: 1 };
        // Extended 06 sub-object: the 03 scalar and majorLen2 (= 2·|p1−p0|)
        // give the ratio BRANCH PAIR {scalar, majorLen2/scalar}; the render
        // truth is the LARGER branch. Two same-design fixtures store opposite
        // branches for the identical Tesla vignette — 测试集 0710-2 stored
        // scalar 0.4117 (division 3.5696 correct), 测试集 0711-1 stores scalar
        // 3.5696 (direct correct, screenshots 2026-07-11) — so neither "always
        // divide" nor "always direct" survives both; max() does. All observed
        // extended-form gradients are wide (ratio > 1); a genuinely narrow
        // extended sample would need a new discriminator. Bare records read
        // 03 directly here; chain-spelling RADIALs (field 04 present) are
        // re-finalized per node — see mgAttachRadialMeta.
        const axisRatio = (gradient.majorLen2 > 0 && gradient.ratio > 0)
          ? Math.max(gradient.ratio, gradient.majorLen2 / gradient.ratio)
          : mgRadialAxisRatio(p0, p1, gradient.ratio);
        const transform = kind === 1
          ? mgLinearGradientTransform(p0, p1)
          : mgRadialGradientTransform(p0, p1, axisRatio);
        const paint = mgAttachRadialMeta({
          type: MG_GRADIENT_TYPE[kind],
          visible: visible,
          opacity: opacity === null ? 1 : opacity,
          blendMode: "NORMAL",
          gradientStops: gradient.stops.map(s => ({ position: s.position, color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a } })),
          gradientTransform: transform
        }, kind, gradient, p0, p1);
        // Linear transforms need the owner node's pixel aspect (bands are
        // perpendicular to the handle axis in PIXEL space); finalized per
        // node in mgFinalizeRadialPaints. The normalized transform above
        // stays as the fallback for node-less paints (style library).
        if (kind === 1) paint.__mgLinearMeta = { p0: { x: p0.x, y: p0.y }, p1: { x: p1.x, y: p1.y } };
        Object.defineProperty(paint, "__mgGradientDebug", { value: gradient, enumerable: false });
        return paint;
      }
      if (color) {
        // mgMakeSolidPaint already folded the `08` alpha into opacity.
        const paint = mgMakeSolidPaint(color.r, color.g, color.b, color.a);
        paint.visible = visible;
        if (opacity !== null) paint.opacity = opacity;
        return paint;
      }
      // Paint-shaped record with no color/kind at all: MasterGo's default fill.
      if (sawTail) {
        const paint = mgMakeSolidPaint(MG_DEFAULT_FILL_GRAY, MG_DEFAULT_FILL_GRAY, MG_DEFAULT_FILL_GRAY, 1);
        paint.visible = visible;
        return paint;
      }
      return null;
    }

    function mgScanPaints(bytes, str) {
      const paints = {};
      // Library-bearing editor exports allocate paint-child ids from the
      // colon-token space (`:396`), not the numeric node-id space.
      const ID = "(?::[0-9A-Za-z]+|[0-9]+:[0-9A-Za-z]+)";
      const markRe = new RegExp("\\x01(" + ID + ")\\x00\\x02(" + ID + ")\\x00\\x03([^\\x00]+)\\x00", "g");
      const marks = [];
      let m;
      while ((m = markRe.exec(str))) marks.push({ start: m.index, end: m.index + m[0].length, id: m[1], parent: m[2], code: m[3] });
      for (let i = 0; i < marks.length; i++) {
        const mk = marks[i];
        const end = (i + 1 < marks.length) ? marks[i + 1].start : Math.min(mk.start + 1200, bytes.length);
        const paint = mgParsePaintRecord(bytes, mk.end, end);
        if (paint) {
          if (!paints[mk.parent]) paints[mk.parent] = [];
          paints[mk.parent].push({ code: mk.code, paint: paint });
        }
      }
      for (const ref in paints) {
        paints[ref].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
        paints[ref] = paints[ref].map(entry => entry.paint);
      }
      return paints;
    }

    // Effect registry (share exports): nodes reference it via tag 17. Child
    // records share the paint-table shape; fields (floats zero-compressed):
    //   05 <kind>  0=INNER_SHADOW (zero-compressed: the field is OMITTED)
    //              1=DROP_SHADOW 2=LAYER_BLUR 3=BACKGROUND_BLUR
    //              (0712-3 specimen: bg-blur glass carries explicit 05 03,
    //               both inner shadows carry no 05 at all)
    //   08 <a><r><g><b>   09 <radius>   0a <offset.x, omitted=0>
    //   0b <offset.y, omitted=0>   0c <spread?>   0d/0e <flags>
    //   0f <float> = spread (0712-3: spread 1 / −2 / −4 all spell 0f; an
    //   unknown-tag bail here used to drop the WHOLE effect list)
    const MG_EFFECT_TYPE = { 0: "INNER_SHADOW", 1: "DROP_SHADOW", 2: "LAYER_BLUR", 3: "BACKGROUND_BLUR" };
    function mgScanEffects(bytes, str) {
      const effects = {};
      // Same colon-token child-id space as mgScanPaints.
      const ID = "(?::[0-9A-Za-z]+|[0-9]+:[0-9A-Za-z]+)";
      const markRe = new RegExp("\\x01(" + ID + ")\\x00\\x02(" + ID + ")\\x00\\x03([^\\x00]+)\\x00", "g");
      const marks = [];
      let m;
      while ((m = markRe.exec(str))) marks.push({ start: m.index, end: m.index + m[0].length, id: m[1], parent: m[2], code: m[3] });
      for (let i = 0; i < marks.length; i++) {
        const mk = marks[i];
        const end = (i + 1 < marks.length) ? marks[i + 1].start : Math.min(mk.start + 400, bytes.length);
        let p = mk.end;
        // Kind 0 (INNER_SHADOW) is zero-compressed away — accept entries that
        // open directly with an effect field tag. Entries opening with any
        // other tag are not effect records (paint/geometry registries share
        // the mark shape) and fall through the field walk's `ok` gate.
        let kind = 0;
        if (bytes[p] === 0x05) {
          kind = bytes[p + 1];
          p += 2;
        } else if (bytes[p] !== 0x06 && bytes[p] !== 0x08 && bytes[p] !== 0x09 &&
                   bytes[p] !== 0x0a && bytes[p] !== 0x0b && bytes[p] !== 0x0c &&
                   bytes[p] !== 0x0d && bytes[p] !== 0x0e && bytes[p] !== 0x0f) {
          continue;
        }
        if (MG_EFFECT_TYPE[kind] === undefined) continue;
        const type = MG_EFFECT_TYPE[kind];
        let color = null;
        // Omitted radius = MasterGo default 10 for ALL kinds — the 回归/Layer
        // Blur style entry (radius 10) omits field 09 entirely; shadows
        // already followed the rule.
        let radius = 10;
        let offX = 0;
        let offY = (type === "DROP_SHADOW" || type === "INNER_SHADOW") ? 4 : 0;
        let spread = 0;
        let visible = true;
        let ok = true;
        while (p < end && ok) {
          const t = bytes[p];
          if (t === 0x00 || t === 0x18) break;
          if (t === 0x08) {
            p++;
            const a = mgReadZeroFloat(bytes, p); p = a.next;
            const r = mgReadZeroFloat(bytes, p); p = r.next;
            const g = mgReadZeroFloat(bytes, p); p = g.next;
            const b = mgReadZeroFloat(bytes, p); p = b.next;
            color = { r: r.value, g: g.value, b: b.value, a: a.value };
            continue;
          }
          if (t === 0x06) { visible = bytes[p + 1] !== 0; p += 2; continue; }
          if (t === 0x09 || t === 0x0a || t === 0x0b || t === 0x0c || t === 0x0f) {
            const r = mgReadZeroFloat(bytes, p + 1);
            if (!isFinite(r.value) || Math.abs(r.value) > 1e5) { ok = false; break; }
            if (t === 0x09) radius = r.value;
            if (t === 0x0a) offX = r.value;
            if (t === 0x0b) offY = r.value;
            if (t === 0x0c || t === 0x0f) spread = r.value;
            p = r.next;
            continue;
          }
          // 11 <flag>: meaning unknown, always `01` in the 0806 汇总 fixture —
          // but bailing on it discarded the WHOLE effect, which is how 40 blurs
          // (the frosted search bar, the background blobs) vanished. All 20
          // occurrences read `11 01 18 …`, i.e. consuming two bytes lands
          // exactly on the `18` transform terminator the loop already breaks on.
          if (t === 0x0d || t === 0x0e || t === 0x11) { p += 2; continue; }
          ok = false;
        }
        if (!ok) continue;
        const fx = (type === "LAYER_BLUR" || type === "BACKGROUND_BLUR")
          ? { type: type, radius: radius, visible: visible }
          : {
              type: type,
              color: color || { r: 0, g: 0, b: 0, a: 0.25 },
              offset: { x: offX, y: offY },
              radius: radius,
              spread: spread,
              visible: visible,
              blendMode: "PASS_THROUGH"
            };
        if (!effects[mk.parent]) effects[mk.parent] = [];
        effects[mk.parent].push({ code: mk.code, fx: fx });
      }
      const byRef = {};
      for (const ref in effects) {
        effects[ref].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
        byRef[ref] = effects[ref].map(e => e.fx);
      }
      return byRef;
    }

    // Library STYLE definition records (0712-3 round-trip specimen): a record
    // whose 02 slot holds the style's DISPLAY NAME with a UTF-8 category
    // prefix instead of a parent id — `01 <id> 00 02 文字/Heading/H1 00 03
    // <code> 00 <payload>`. Values live in the registries already keyed by
    // the style id: fills in the paint table, effects in the effect registry,
    // text params in the font-style table (third spelling). Node references:
    // fills/strokes via tags 15/16, effects via tag 17, text via the run's
    // `03 <styleId>` field — all pointing straight at the style id.
    const MG_STYLE_CATEGORY_PREFIXES = [
      { bytes: [0xe6, 0x96, 0x87, 0xe5, 0xad, 0x97, 0x2f], category: "TEXT" },   // 文字/
      { bytes: [0xe5, 0xa1, 0xab, 0xe5, 0x85, 0x85, 0x2f], category: "FILL" },   // 填充/
      { bytes: [0xe7, 0x89, 0xb9, 0xe6, 0x95, 0x88, 0x2f], category: "EFFECT" }, // 特效/
      { bytes: [0xe6, 0x8f, 0x8f, 0xe8, 0xbe, 0xb9, 0x2f], category: "STROKE" }  // 描边/
    ];
    function mgScanStyleDefs(bytes, str) {
      const defs = {};
      const ID = "[0-9]+:[0-9A-Za-z]+";
      // The windows-1252 view keeps a 1:1 byte↔char offset mapping, so the
      // regex only LOCATES candidates; the name itself is re-decoded as
      // UTF-8 straight from the byte range.
      const re = new RegExp("\\x01(" + ID + ")\\x00\\x02([^\\x00]{2,120})\\x00\\x03[^\\x00]+\\x00", "g");
      const utf8 = new TextDecoder("utf-8");
      let m;
      while ((m = re.exec(str))) {
        const nameStart = m.index + 1 + m[1].length + 2;
        const nameEnd = nameStart + m[2].length;
        let category = null;
        for (const pref of MG_STYLE_CATEGORY_PREFIXES) {
          let hit = true;
          for (let i = 0; i < pref.bytes.length; i++) {
            if (bytes[nameStart + i] !== pref.bytes[i]) { hit = false; break; }
          }
          if (hit) { category = pref; break; }
        }
        if (!category) continue;
        let name = "";
        try {
          name = utf8.decode(bytes.subarray(nameStart + category.bytes.length, nameEnd));
        } catch (e) { continue; }
        if (!name) continue;
        if (defs[m[1]] === undefined) defs[m[1]] = { id: m[1], category: category.category, name: name };
      }
      return defs;
    }

    // Node type = the byte right after the `1c` tag.
    const MG_TYPE = { 1: "VECTOR", 2: "LINE", 3: "RECTANGLE", 4: "ELLIPSE", 5: "POLYGON", 6: "STAR", 7: "FRAME", 8: "TEXT", 10: "SLICE" };

    // Locate the real `1c` type tag inside a record block. A raw indexOf is not
    // enough: float payloads can contain 0x1c (e.g. height 1080 encodes as
    // `81 1c f0 64`), which used to make whole subtrees decode with an invalid
    // type and get dropped. The `1b <ownerId> 00` field directly precedes `1c`
    // in every observed record, so anchor on that first; otherwise accept a
    // `1c` whose type byte is valid, preferring one right after a string/id
    // terminator.
    const MG_OWNER_TYPE_RE = /\x1b[0-9A-Za-z:\/]{1,64}\x00\x1c/;
    // Set per conversion by mgDecodeNativeNodes: true when the document is a
    // share/partial export (component-master records without sort codes).
    let mgShareModeActive = false;
    function mgFindTypeTagPos(full, bytes, fb) {
      const anchored = MG_OWNER_TYPE_RE.exec(full);
      if (anchored && MG_TYPE[bytes[fb + anchored.index + anchored[0].length]]) {
        return anchored.index + anchored[0].length - 1;
      }
      let weak = -1;
      let q = full.indexOf("\x1c");
      while (q >= 0) {
        if (MG_TYPE[bytes[fb + q + 1]]) {
          if (q === 0 || bytes[fb + q - 1] === 0x00) return q;
          if (weak < 0) weak = q;
        }
        q = full.indexOf("\x1c", q + 1);
      }
      return weak;
    }

    // Zero-compressed float: a single 0x00 byte means 0, otherwise 4 float bytes.
    function mgReadZeroFloat(bytes, p) {
      if (bytes[p] === 0x00) return { value: 0, next: p + 1 };
      return { value: mgDecFloat(bytes, p), next: p + 4 };
    }

    // Scalar-section fields between the layer name and the `1c` type tag. Tags
    // are strictly ascending, so consume the stream in order; searching for a
    // tag byte is unsafe because twisted-float payloads can contain the same
    // byte values.
    //
    // Enum/flag fields (zero-value floats compress to a single 00 byte):
    //   05 <b>  shape flag          08 <b>  constrainProportions (1=true)
    //   09 <b>  isMask (1=true)     0a <f>  opacity
    //   0b <b>  constraints.horizontal   0c <b>  constraints.vertical
    //           (enum 0=START 1=CENTER 2=END 3=STRETCH 4=SCALE; omitted=START)
    //   0d <b>  blendMode enum (see MG_BLEND_MODES; omitted=PASS_THROUGH)
    //   0e/0f/10 <f>  width/height/strokeWeight
    //   11 <b>  ? (seen 1 on the dashed round-cap line)
    //   12 <b>  strokeJoin (2=ROUND 1=BEVEL; omitted=MITER)
    //   13 <b>  strokeAlign (1=CENTER 2=INSIDE 3=OUTSIDE)
    //   14 <n> <n×f>  dashPattern
    //   15/16/17 <id>  fill/stroke/corner-style refs
    //   18 <object>    transform: 01=x 02=y 03=m00 04=m11 05=m01 06=m10
    //   19 <varint>    field-presence / instance-override mask
    //   1a <id>        template/source reference
    //   1b <id>        owner/page reference
    //
    // The walk stops at the first unknown tag. Parsed fields before that point
    // remain useful, but callers never scan the remaining bytes heuristically.
    function mgNormalizeRotation(rotation) {
      if (!isFinite(rotation)) return 0;
      let normalized = ((rotation + 180) % 360 + 360) % 360 - 180;
      if (Math.abs(normalized) < 1e-9) normalized = 0;
      return normalized;
    }

    // Rotation comes off the matrix's FIRST COLUMN — atan2(-m10, m00) — because
    // that is the image of the x axis. Reading the first ROW (atan2(m01, m00))
    // agrees for pure rotations, where m01 == -m10, and only for those: on a
    // horizontally skewed matrix ([[1,-0.141],[0,0.990]], 预存电费送积分) it
    // invented -8°, and on a vertically skewed one ([[0.998,0],[-0.069,1]],
    // 路径 1737) it reported 0 where MasterGo says 3.94°.
    function mgRotationFromMatrix(m00, m10) {
      return Math.atan2(-m10, m00) * 180 / Math.PI;
    }

    function mgReadScalarCString(bytes, p, end) {
      const value = mgReadCString(bytes, p, end);
      return value ? { value: value.text, next: value.end + 1 } : null;
    }

    function mgReadScalarTransform(bytes, p, end) {
      let x = 0, y = 0, m00 = 1, m01 = 0, m10 = 0, m11 = 1;
      let sawX = false, sawY = false, sawMatrix = false;
      while (p < end) {
        const tag = bytes[p++];
        if (tag === 0x00) {
          const relativeTransform = sawMatrix
            ? [[m00, m01, x], [m10, m11, y]]
            : null;
          return {
            value: {
              x: x,
              y: y,
              relativeTransform: relativeTransform,
              rotation: sawMatrix ? mgNormalizeRotation(mgRotationFromMatrix(m00, m10)) : 0,
              sawX: sawX,
              sawY: sawY,
              sawMatrix: sawMatrix
            },
            next: p
          };
        }
        // The transform object has no dedicated terminator in every export.
        // Its next scalar tag is greater than 06; leave that byte for the
        // outer scalar walker instead of treating the entire object as bad.
        if (tag < 0x01 || tag > 0x06) {
          p--;
          const relativeTransform = sawMatrix
            ? [[m00, m01, x], [m10, m11, y]]
            : null;
          return {
            value: {
              x: x, y: y, relativeTransform: relativeTransform,
              rotation: sawMatrix ? mgNormalizeRotation(mgRotationFromMatrix(m00, m10)) : 0,
              sawX: sawX, sawY: sawY, sawMatrix: sawMatrix
            },
            next: p
          };
        }
        const r = mgReadZeroFloat(bytes, p);
        p = r.next;
        if (p > end) return null;
        if (tag === 0x01) { x = r.value; sawX = true; }
        if (tag === 0x02) { y = r.value; sawY = true; }
        if (tag === 0x03) { m00 = r.value; sawMatrix = true; }
        if (tag === 0x04) { m11 = r.value; sawMatrix = true; }
        if (tag === 0x05) { m01 = r.value; sawMatrix = true; }
        if (tag === 0x06) { m10 = r.value; sawMatrix = true; }
      }
      return null;
    }

    function mgWalkScalarFields(bytes, fb, scalEnd, afterName) {
      const f = { present: {} };
      let p = fb + afterName;
      const end = fb + scalEnd;
      while (p < end) {
        const t = bytes[p];
        // 0x06 is a one-byte flag like its neighbors — first seen in the
        // 0711-3 full editor export, which spells out explicit zeros
        // (`05 00 06 00 07 01 …`); value census over that file is 0/1 only.
        // Before it was known the walk broke here on 45k of 70k records,
        // losing every field after it (paint/stroke refs, owner, constraints).
        if (t === 0x05 || t === 0x06 || t === 0x07 || t === 0x08 || t === 0x09 || t === 0x0b || t === 0x0c || t === 0x0d ||
            t === 0x11 || t === 0x12 || t === 0x13) {
          if (p + 1 >= end) break;
          f.present[t] = true;
          f["t" + t.toString(16).padStart(2, "0")] = bytes[p + 1];
          p += 2;
          continue;
        }
        if (t === 0x0a || t === 0x0e || t === 0x0f || t === 0x10) {
          f.present[t] = true;
          const r = mgReadZeroFloat(bytes, p + 1);
          if (t === 0x0a) f.opacity = r.value;
          if (t === 0x0e) f.width = r.value;
          if (t === 0x0f) f.height = r.value;
          if (t === 0x10) f.strokeWeight = r.value;
          p = r.next;
          if (p > end) break;
          continue;
        }
        if (t === 0x14) {
          const count = bytes[p + 1];
          // `14 00` = explicit empty dash pattern (0711-3 spells out empties);
          // consume it so the fields after (paint refs, owner) stay reachable.
          if (count === 0) { f.present[t] = true; p += 2; continue; }
          if (!(count >= 1 && count <= 8)) break;
          f.present[t] = true;
          const dash = [];
          let q = p + 2;
          let ok = true;
          for (let i = 0; i < count; i++) {
            const r = mgReadZeroFloat(bytes, q);
            if (!isFinite(r.value) || Math.abs(r.value) > 1e5) { ok = false; break; }
            dash.push(r.value);
            q = r.next;
          }
          if (!ok) break;
          f.dashPattern = dash;
          p = q;
          continue;
        }
        if (t === 0x15 || t === 0x16 || t === 0x17 || t === 0x1a || t === 0x1b) {
          // Explicit-empty reference (`1a 00`, 0711-3 spelling): consume the
          // empty cstring and keep walking — an empty ref means "none".
          if (bytes[p + 1] === 0x00) { f.present[t] = true; p += 2; continue; }
          const r = mgReadScalarCString(bytes, p + 1, end);
          if (!r) break;
          f.present[t] = true;
          if (t === 0x15) f.paintRef = r.value;
          if (t === 0x16) f.strokeRef = r.value;
          if (t === 0x17) f.cornerRef = r.value;
          if (t === 0x1a) f.templateRef = r.value;
          if (t === 0x1b) f.owner = r.value;
          p = r.next;
          continue;
        }
        if (t === 0x18) {
          const r = mgReadScalarTransform(bytes, p + 1, end);
          if (!r) break;
          f.present[t] = true;
          f.transform = r.value;
          p = r.next;
          continue;
        }
        if (t === 0x19) {
          // The override mask is a full 64-bit LEB128 (library-bearing exports
          // write 9 bytes). mgReadVarint's 35-bit guard returned NaN for those,
          // which broke the walk and silently dropped EVERY field behind it —
          // `1a` templateRef, `1b` owner, the whole tail. Only the low bits are
          // ever tested, and float accumulation would round them away past
          // 2^53, so accumulate the low 32 bits with integer ops.
          let q = p + 1, mask = 0, shift = 0, closed = false;
          while (q < end && shift <= 63) {
            const b = bytes[q++];
            if (shift < 32) mask = (mask | ((b & 0x7f) << shift)) >>> 0;
            if ((b & 0x80) === 0) { closed = true; break; }
            shift += 7;
          }
          if (!closed) break;
          f.present[t] = true;
          f.overrideMask = mask;
          p = q;
          continue;
        }
        break;
      }
      f.next = p;
      f.complete = p === end;
      return f;
    }

    // Record trailer, after the `1c` type object: `1d 01` then ascending fields:
    //   1e <b>            ?            21 <b>  primaryAxisSizingMode (present=FIXED, omitted=AUTO)
    //   22 <b>            counterAxisSizingMode (same)   23 <str>  style id
    //   25 <b> <sub> <sub>  two null-terminated sub-objects (roles unknown)
    //   27/2b <b>         ?            2a <str>  design-tokens JSON
    //   2c <b>            strokeCap (1=ROUND 2=SQUARE 3/4=ARROW)
    //   2d <4×f>          per-side stroke weights
    // Text runs and floats can contain `1d 01`; candidates are validated by
    // parsing forward and requiring a clean 00-terminated field stream.
    function mgParseTrailer(bytes, str, from, end, anchoredStart) {
      function walkTrailerFields(startPos) {
        const fields = { has21: false, has22: false, strokeCap: 0, sideWeights: null };
        let p = startPos;
        while (p < end) {
          const t = bytes[p];
          if (t === 0x00) return fields;
          if (t === 0x23 || t === 0x2a) {
            p++;
            while (p < end && bytes[p] !== 0x00) p++;
            p++;
            continue;
          }
          if (t === 0x25) {
            p += 2;
            let valid = true;
            for (let s = 0; s < 2 && valid; s++) {
              while (p < end) {
                const st = bytes[p];
                if (st === 0x00) { p++; break; }
                if (st > 0x10) { valid = false; break; }
                p += 2;
              }
            }
            if (!valid) return null;
            continue;
          }
          if (t === 0x2d) {
            p++;
            const w = [];
            for (let i = 0; i < 4; i++) {
              const r = mgReadZeroFloat(bytes, p);
              if (!isFinite(r.value) || Math.abs(r.value) > 1e5) return null;
              w.push(r.value);
              p = r.next;
            }
            fields.sideWeights = w;
            continue;
          }
          if (t === 0x26) { // instance scale factor (share exports), 0-compressed float
            const r = mgReadZeroFloat(bytes, p + 1);
            if (!isFinite(r.value) || Math.abs(r.value) > 1e4) return null;
            fields.scaleFactor = r.value;
            p = r.next;
            continue;
          }
          // 20/21/22 carry ZERO-COMPRESSED FLOATS, not one-byte values: `20
          // 7f 00 00 00` is layoutGrow 1. Stepping over them two bytes at a
          // time landed mid-float and cut the walk short, losing the 21/22
          // sizing markers that follow.
          if (t === 0x20 || t === 0x21 || t === 0x22) {
            const r = mgReadZeroFloat(bytes, p + 1);
            if (!isFinite(r.value) || Math.abs(r.value) > 1e5) return null;
            if (t === 0x20) fields.layoutGrow = r.value;
            if (t === 0x21) fields.has21 = true;
            if (t === 0x22) fields.has22 = true;
            p = r.next;
            continue;
          }
          if (t >= 0x1e && t <= 0x3f) {
            if (t === 0x2c) fields.strokeCap = bytes[p + 1];
            // 2e 01 = layoutPositioning ABSOLUTE (ignore auto-layout).
            // Cross-tab on 统一集: all 5 v2-ABSOLUTE nodes carry it, none of
            // the other 316 do (TP5/FP0/FN0). Replaces the old group-child
            // heuristic, which mis-marked plain group children.
            if (t === 0x2e) fields.absolute = bytes[p + 1] === 1;
            p += 2;
            continue;
          }
          return null;
        }
        return null;
      }
      // Anchored spelling (0711-3 full exports): the trailer follows the `1c`
      // object directly — after the object terminator and one record-level 00
      // come either `1d 01 <fields>` or the ascending fields with NO `1d 01`
      // introducer at all (`1e …` / `27 …`). With a known object end this is
      // exact — no candidate scanning through float payloads.
      if (anchoredStart != null) {
        let p0 = anchoredStart;
        if (bytes[p0] === 0x00) p0++;
        let anchored = null;
        if (bytes[p0] === 0x1d && bytes[p0 + 1] === 0x01) anchored = walkTrailerFields(p0 + 2);
        else if (bytes[p0] >= 0x1e && bytes[p0] <= 0x3f) anchored = walkTrailerFields(p0);
        if (anchored) return anchored;
      }
      // Legacy: scan for `1d 01` candidates and validate by forward-parsing to
      // a clean terminator (floats/text runs can fake the introducer).
      let idx = str.indexOf("\x1d\x01", from);
      while (idx >= 0 && idx < end) {
        const fields = walkTrailerFields(idx + 2);
        if (fields) return fields;
        idx = str.indexOf("\x1d\x01", idx + 2);
      }
      return null;
    }

    // MasterGo blend-mode enum: the standard blend list without the LINEAR_*
    // variants (index 15 verified as LUMINOSITY on the masked-image rectangle).
    const MG_BLEND_MODES = [
      "NORMAL", "DARKEN", "MULTIPLY", "COLOR_BURN", "LIGHTEN", "SCREEN",
      "COLOR_DODGE", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "DIFFERENCE",
      "EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY"
    ];
    // 0xff = the explicit "NORMAL" spelling (omitted tag = PASS_THROUGH).
    // Cross-tabbed on the 0806 fixture: 6/6 nodes with byte 255 are NORMAL.
    MG_BLEND_MODES[0xff] = "NORMAL";
    const MG_STROKE_ALIGN = { 1: "CENTER", 2: "INSIDE", 3: "OUTSIDE" };
    const MG_STROKE_JOIN = { 1: "BEVEL", 2: "ROUND" };
    // Scalar tags 0b/0c: 0b = VERTICAL, 0c = HORIZONTAL (verified against
    // asymmetric share-export samples; symmetric old fixtures could not tell).
    const MG_CONSTRAINT = ["START", "END", "STARTANDEND", "CENTER", "SCALE"];

    // Sub-field stream of the `1c 07` container object (ascending tag ids):
    //   01 <b>            group-like flag (GROUP / BOOLEAN_OPERATION)
    //   02 <b>            boolean kind: 1=UNION 2=INTERSECT 3=EXCLUDE 4=SUBTRACT
    //   03 <b>            clipsContent (0=false; omitted=true for FRAME family)
    //   04 04 <4×float4>  per-corner radii
    //   05 <b>            component flag (followed by 07 <component key>)
    //   06 <b>            instance flag (followed by 15 <override table>)
    //   07 …              component key; without a preceding 05 flag = COMPONENT_SET
    //   08 <b>            layoutMode (1=HORIZONTAL 2=VERTICAL; omitted=NONE)
    //   09 <f>            itemSpacing
    //   0a <obj>          paddings: 01=top 02=right 03=bottom 04=left (zero-floats)
    //   0d <b> 0e <b>     primary/counterAxisAlignItems (2=CENTER; omitted=MIN)
    //   14 …              component property / override table (not walked)
    //   17 <b>            container kind enum; 01 observed only on SECTION
    const MG_BOOL_OPS = ["UNION", "INTERSECT", "EXCLUDE", "SUBTRACT"];
    // 1=MAX observed on the 0712-3 round-trip specimen (counterAxis "MAX"
    // rows spell `0e 01`); 3=MAX kept from the older fixtures.
    // Primary axis (0d): 1=MAX 2=CENTER 3=SPACE_BETWEEN — 统一回归集
    // al/space-between-3 stores `0d 03` and the v2 export says SPACE_BETWEEN,
    // while al/vertical-primary-MAX stores `0d 01`; the old 3:"MAX" mapping
    // came from counter-axis data and mis-packed SPACE_BETWEEN rows to the
    // end. Counter axis (0e) keeps 3=MAX (Figma has no counter
    // SPACE_BETWEEN). Omitted = MIN on both axes.
    const MG_PRIMARY_ALIGN_ITEMS = { 1: "MAX", 2: "CENTER", 3: "SPACE_BETWEEN", 4: "SPACE_BETWEEN" };
    const MG_COUNTER_ALIGN_ITEMS = { 1: "MAX", 2: "CENTER", 3: "MAX", 4: "MAX" };
    function mgParseContainerMeta(bytes, off) {
      const meta = { subtype: "FRAME", booleanOperation: null };
      let p = off;
      let sawStructural = false;
      if (bytes[p] === 0x01) {
        // The `01` VALUE is the group discriminator: `01 00` = group-like
        // (GROUP, or BOOLEAN_OPERATION when the `02 <kind>` field follows),
        // `01 01` = FRAME family spelled with the flag (always followed by an
        // explicit `03` clipsContent in 0711-3: 9897/9897; groups cannot clip
        // and never write 03). Cross-tab over the 516 cover-verified
        // containers has zero exceptions (144 GROUP + 135 BOOLEAN all `01
        // 00`; the seven `01 01` containers are baseline FRAMEs). Page 1's
        // top-level screens all use the `01 01` spelling — the old
        // any-01-means-group rule turned every one of them into a GROUP.
        const groupish = bytes[p + 1] === 0x00;
        sawStructural = true;
        p += 2;
        if (groupish && bytes[p] === 0x02 && bytes[p + 1] >= 1 && bytes[p + 1] <= 4) {
          meta.subtype = "BOOLEAN_OPERATION";
          meta.booleanOperation = MG_BOOL_OPS[bytes[p + 1] - 1];
          p += 2;
        } else if (groupish) {
          meta.subtype = "GROUP";
        } else {
          meta.subtype = "FRAME";
        }
      }
      if (bytes[p] === 0x03) { meta.clipsContent = bytes[p + 1] !== 0; sawStructural = true; p += 2; }
      if (bytes[p] === 0x04 && bytes[p + 1] === 0x04) {
        p += 2;
        const corners = [];
        for (let i = 0; i < 4; i++) {
          const r = mgReadZeroFloat(bytes, p);
          corners.push(r.value);
          p = r.next;
        }
        meta.corners = corners;
        sawStructural = true;
      }
      if (bytes[p] === 0x05) {
        if (bytes[p + 1] === 0x01 && meta.subtype === "FRAME") {
          // `05 01` = COMPONENT. The key follows in field 07 — as a string in
          // share/older exports (`05 01 07 <key>`), possibly EMPTY in the
          // 0711-3 explicit-zero spelling (`05 01 06 00 07 00`, the Keyboard
          // master). Census: all 95 `05 01` containers are components; every
          // other container spells `05 00`.
          meta.subtype = "COMPONENT";
          sawStructural = true;
          p += 2;
        } else {
          // 0711-3 full exports spell explicit zeros (`05 00`): plain flag.
          p += 2;
        }
      }
      // Container `06` is VALUE-semantic like field 01: `06 01` = INSTANCE,
      // `06 00` = plain flag. Verified by block-bounded cross-tab against both
      // baselined fixtures — 0711-3 cover slots: 06=1 ⟺ sourceType INSTANCE
      // (224 with follower 09 + 12 with follower 0f, zero contradictions);
      // 0712-1: the two root Keyboard instances are `06 01 09 …` (the earlier
      // follower-whitelist rule misread them as FRAME, so their 412 template
      // children were never expanded). After the flag, share exports carry the
      // override ref (`0f <id>`) / override table (`15 …`) and stop; full
      // exports continue with the instance's OWN layout fields (09/0a/…),
      // which keep parsing below.
      if (bytes[p] === 0x06) {
        if (bytes[p + 1] === 0x01 && meta.subtype === "FRAME") {
          meta.subtype = "INSTANCE";
          p += 2;
          if (bytes[p] === 0x0f) {
            const c = mgReadCString(bytes, p + 1, Math.min(off + 256, p + 96));
            if (c) meta.instanceRef = c.text;
            return meta;
          }
          if (bytes[p] === 0x15) return meta; // override table (not walked yet)
        } else {
          p += 2;
        }
      }
      if (bytes[p] === 0x07) {
        // Field 07 sub-tag 03 = an EXTERNAL library key ("<libraryFileId>+<nodeId>");
        // sub-tag 04 = a local numeric stamp. Masters carrying a library key are
        // MasterGo's off-canvas copies of a shared-library component: its own
        // page traversal never yields them, so the importer restores them only
        // to re-link instances and deletes them when the import finishes.
        if (bytes[p + 1] === 0x03) {
          const libKey = mgReadCString(bytes, p + 2, Math.min(off + 512, p + 200));
          if (libKey && libKey.text.indexOf("+") > 0) meta.libraryKey = libKey.text;
        }
        if (meta.subtype === "COMPONENT") {
          p++;
          while (bytes[p] !== 0x00 && p < off + 256) p++;
          p++;
          // Share/partial exports append `04 <varint>` (version stamp?) and a
          // `05 <b> 00` sub-object after the component key; skip both so the
          // auto-layout fields that follow stay reachable.
          if (bytes[p] === 0x04 && bytes[p + 1] !== 0x04) {
            p++;
            while ((bytes[p] & 0x80) !== 0 && p < off + 256) p++;
            p++;
            if (bytes[p] === 0x05) {
              p += 2;
              if (bytes[p] === 0x00 && (bytes[p + 1] === 0x08 || bytes[p + 1] === 0x09 || bytes[p + 1] === 0x0a || bytes[p + 1] === 0x0d || bytes[p + 1] === 0x17)) p++;
            }
          }
        } else if (bytes[p + 1] !== 0x00) {
          // A non-zero field 07 = COMPONENT_SET (payload is a key string in
          // share exports, a `04 <varint>` stamp object in full exports).
          // `07 00` is the 0711-3 explicit-zero flag spelling.
          if (meta.subtype === "FRAME") { meta.subtype = "COMPONENT_SET"; return meta; }
          p++;
          while (bytes[p] !== 0x00 && p < off + 256) p++;
          p++;
        } else {
          p += 2;
        }
      }
      if (bytes[p] === 0x08 && (bytes[p + 1] === 1 || bytes[p + 1] === 2)) {
        meta.layoutMode = bytes[p + 1] === 1 ? "HORIZONTAL" : "VERTICAL";
        sawStructural = true;
        p += 2;
      } else if (bytes[p] === 0x08 && bytes[p + 1] === 0x00) {
        p += 2; // explicit layoutMode NONE
      }
      if (bytes[p] === 0x09) {
        const r = mgReadZeroFloat(bytes, p + 1);
        meta.itemSpacing = r.value;
        sawStructural = true;
        p = r.next;
      } else {
        // Full editor exports omit the field when the runtime default (10)
        // applies (explicit zero is written `09 00`); share exports omit it
        // for 0. The caller resolves via the file-level share flag.
        meta.itemSpacingMissing = true;
      }
      if (bytes[p] === 0x0a) {
        p++;
        const pads = {};
        let padCount = 0;
        while (p < off + 256) {
          const st = bytes[p];
          if (st === 0x00) { p++; break; }
          if (st < 0x01 || st > 0x08) break;
          const r = mgReadZeroFloat(bytes, p + 1);
          pads[st] = r.value;
          padCount++;
          p = r.next;
        }
        // Same default rule: an empty padding object means "all 10" in full
        // editor exports, "all 0" in share exports. INDIVIDUALLY omitted
        // sides follow the same default — MasterGo drops any side equal to
        // 10 while keeping the others (统一集 回归BoolChip stores L/R 16 and
        // omits T/B 10; 回归Badge stores T/B 5 and omits L/R 10). Keep absent
        // slots undefined; the caller resolves them per side.
        if (padCount === 0) meta.paddingsMissing = true;
        else { meta.paddings = { top: pads[1], right: pads[2], bottom: pads[3], left: pads[4] }; sawStructural = true; }
      } else {
        // A wholly absent 0a object follows the same omitted-field default as
        // the empty one (mirror of the 09/itemSpacing rule above). Verified on
        // both spellings: 测试集 0710-2 (full export, absent 0a on plain
        // GROUP/BOOLEAN records) restores the editor default 10; 0710-1's
        // absent-0a nodes are all template/instance children whose share-mode
        // missingDefault stays 0.
        meta.paddingsMissing = true;
      }
      // 0711-3 trailing container fields: `0b <b>` / `0c <b>` unknown flags,
      // `0f <cstring>` node ref (empty on instance-child stubs), `10 <b>`
      // unknown. Consume them so 0d/0e/17 stay reachable and the object's end
      // offset is known (the record trailer anchors there).
      if (bytes[p] === 0x0b) p += 2;
      if (bytes[p] === 0x0c) p += 2;
      if (bytes[p] === 0x0d) { meta.primaryAlign = MG_PRIMARY_ALIGN_ITEMS[bytes[p + 1]] || "MIN"; sawStructural = true; p += 2; }
      if (bytes[p] === 0x0e) { meta.counterAlign = MG_COUNTER_ALIGN_ITEMS[bytes[p + 1]] || "MIN"; sawStructural = true; p += 2; }
      if (bytes[p] === 0x0f) {
        const c = mgReadCString(bytes, p + 1, Math.min(off + 320, p + 96));
        if (c) { meta.sourceRef = c.text || null; p = c.end + 1; }
        else p += 2;
      }
      if (bytes[p] === 0x10) p += 2;
      if (bytes[p] === 0x1a) p += 2;
      if (bytes[p] === 0x17) {
        if (bytes[p + 1] === 0x01 && meta.subtype === "FRAME") meta.subtype = "SECTION";
        sawStructural = true;
        p += 2;
      }
      // `1a <b>` (0806 auto-layout frames): unknown one-byte flag. Consuming it
      // is what makes the object terminator — and therefore the ANCHORED
      // trailer that carries layoutGrow / the 21-22 sizing markers —
      // reachable at all.
      if (bytes[p] === 0x1a) p += 2;
      if (bytes[p] === 0x00) meta.endOffset = p + 1;
      meta.bareStub = !sawStructural;
      return meta;
    }

    // VECTOR records reference their path geometry by a 32-hex content hash in
    // the `1c 01` object's `07` field; the geometry itself lives in a separate
    // hash-keyed blob table elsewhere in the document.
    function mgReadVectorGeomHash(bytes, off, end) {
      let p = off;
      // `04 <float>` (the unknown scalar the TEXT object also carries) can sit
      // in front of the hash — bailing on it dropped the node's whole
      // vectorNetwork, which renders as an invisible layer (0806 tab-bar logo).
      if (bytes[p] === 0x04) p = mgReadZeroFloat(bytes, p + 1).next;
      if (bytes[p] !== 0x07) return null;
      const c = mgReadCString(bytes, p + 1, Math.min(end, p + 64));
      return c && /^[0-9A-F]{32}$/i.test(c.text) ? c.text : null;
    }

    // Unsigned LEB128; the 5-byte `ff ff ff ff 0f` (uint32 max) means -1.
    function mgReadVarint(bytes, pos) {
      let result = 0, shift = 0, p = pos;
      for (;;) {
        if (p >= bytes.length || shift > 35) return { value: NaN, next: p };
        const b = bytes[p++];
        result += (b & 0x7f) * Math.pow(2, shift);
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      if (result >= 0xFFFFFFFF) result = -1;
      return { value: result, next: p };
    }

    const MG_STROKE_CAP = { 1: "ROUND", 2: "SQUARE", 3: "ARROW_LINES", 4: "ARROW_EQUILATERAL" };

    // Geometry blob grammar (entry: `01 <32-hex hash> 00`, fields ascending):
    //   02 <n>  segment records:  01 <count=4:[start,c1,c2,end]> 02 <index> 00
    //           c1/c2 index the control-point table; -1 = straight (no tangent)
    //   03 <n>  region records:   01 <len:[segment indices]>… 02 <index> [03 <winding: 1=EVENODD>] 00
    //   04 <n>  control points:   01 <x float> 02 <y float> 03 <index> 00
    //   05 <n>  vertex records:   01 <x> 02 <y> 03 <flag> [04 <cornerRadius>] 05 <index> [07 <strokeCap: 1=ROUND>] 00
    //   06 …    trailer
    // Point floats are ZERO-COMPRESSED like every other .mg float: a leading
    // 00 byte means 0.0 and occupies one byte, otherwise 4 twisted-float
    // bytes follow (see mgReadZeroFloat). Some exporters omit zero fields
    // entirely instead; both spellings decode identically here. Reading a
    // fixed 4 bytes used to swallow the 3 bytes after a compressed zero and
    // derail every later record in the blob (测试集 0710-2: 126/133 blobs
    // failed, all 431 VECTORs lost or corrupted their vectorNetwork).
    // tangentStart = cp[c1] - vertex[start]; tangentEnd = cp[c2] - vertex[end].
    function mgDecodeGeometryBlob(bytes, pos) {
      const segments = [], regions = [], controls = [], vertices = [];
      let p = pos;
      function varint() { const r = mgReadVarint(bytes, p); p = r.next; return r.value; }
      function zeroFloat() { const r = mgReadZeroFloat(bytes, p); p = r.next; return r.value; }
      function intArray() {
        const n = varint();
        if (!(n >= 0) || n > 100000) return null;
        const arr = [];
        for (let i = 0; i < n; i++) { const v = varint(); if (Number.isNaN(v)) return null; arr.push(v); }
        return arr;
      }
      function segmentRecord() {
        const rec = { refs: null, index: -1 };
        for (;;) {
          if (p >= bytes.length) return null;
          const t = bytes[p++];
          if (t === 0x00) return rec;
          if (t === 0x01) { rec.refs = intArray(); if (!rec.refs) return null; continue; }
          if (t === 0x02) { rec.index = varint(); continue; }
          return null;
        }
      }
      function regionRecord() {
        const rec = { loops: [], index: -1, winding: 0 };
        for (;;) {
          if (p >= bytes.length) return null;
          const t = bytes[p++];
          if (t === 0x00) return rec;
          if (t === 0x01) {
            // One int array holding every loop; -1 (ff ff ff ff 0f) separates
            // loops. Single-loop regions have no separator.
            const arr = intArray();
            if (!arr) return null;
            let cur = [];
            for (const v of arr) {
              if (v === -1) { rec.loops.push(cur); cur = []; }
              else cur.push(v);
            }
            if (cur.length) rec.loops.push(cur);
            continue;
          }
          if (t === 0x02) { rec.index = varint(); continue; }
          if (t === 0x03) { rec.winding = varint(); continue; }
          return null;
        }
      }
      function pointRecord(isVertex) {
        const rec = { x: 0, y: 0, index: -1, flag: 0, cornerRadius: 0, cap: 0 };
        for (;;) {
          if (p >= bytes.length) return null;
          const t = bytes[p++];
          if (t === 0x00) return rec;
          if (t === 0x01) { rec.x = zeroFloat(); continue; }
          if (t === 0x02) { rec.y = zeroFloat(); continue; }
          if (t === 0x03) { if (isVertex) rec.flag = varint(); else rec.index = varint(); continue; }
          if (t === 0x04) { rec.cornerRadius = zeroFloat(); continue; }
          if (t === 0x05) { rec.index = varint(); continue; }
          if (t === 0x07) { rec.cap = varint(); continue; }
          return null;
        }
      }
      let sections = 0;
      while (p < bytes.length) {
        const tag = bytes[p];
        if (tag !== 0x02 && tag !== 0x03 && tag !== 0x04 && tag !== 0x05) break;
        p++;
        sections++;
        const n = varint();
        if (!(n >= 0) || n > 100000) return null;
        for (let i = 0; i < n; i++) {
          let rec;
          if (tag === 0x02) { rec = segmentRecord(); if (rec) segments.push(rec); }
          else if (tag === 0x03) { rec = regionRecord(); if (rec) regions.push(rec); }
          else { rec = pointRecord(tag === 0x05); if (rec) (tag === 0x04 ? controls : vertices).push(rec); }
          if (!rec) return null;
        }
      }
      // Share exports store one canonical empty blob (its hash is MD5 of "")
      // for flattened Boolean-result leaves: all four sections present with
      // zero records, ending cleanly at the 06 trailer. That is a real EMPTY
      // vector network (the ZIP baseline carries {[],[],[]} for those nodes),
      // not a decode failure — only a derailed parse returns null.
      if (!vertices.length || !segments.length) {
        const cleanEmpty = sections === 4 && !vertices.length && !segments.length &&
          !controls.length && !regions.length && bytes[p] === 0x06;
        return cleanEmpty ? { segments: [], vertices: [], regions: [] } : null;
      }

      const vmap = [], cmap = [], smap = [];
      vertices.forEach(v => { vmap[v.index >= 0 ? v.index : vmap.length] = v; });
      controls.forEach(c => { cmap[c.index >= 0 ? c.index : cmap.length] = c; });
      segments.forEach(s => { smap[s.index >= 0 ? s.index : smap.length] = s; });
      const vnVertices = vmap.map(v => ({
        x: v.x, y: v.y,
        cornerRadius: v.cornerRadius || 0,
        strokeCap: MG_STROKE_CAP[v.cap] || "NONE"
      }));
      const vnSegments = [];
      for (const s of smap) {
        if (!s || !s.refs || s.refs.length < 4) return null;
        const start = s.refs[0], c1 = s.refs[1], c2 = s.refs[2], end = s.refs[3];
        if (!vmap[start] || !vmap[end]) return null;
        const ts = (c1 >= 0 && cmap[c1]) ? { x: cmap[c1].x - vmap[start].x, y: cmap[c1].y - vmap[start].y } : { x: 0, y: 0 };
        const te = (c2 >= 0 && cmap[c2]) ? { x: cmap[c2].x - vmap[end].x, y: cmap[c2].y - vmap[end].y } : { x: 0, y: 0 };
        vnSegments.push({ start: start, end: end, tangentStart: ts, tangentEnd: te });
      }
      const vnRegions = regions.map(r => ({ windingRule: r.winding === 1 ? "EVENODD" : "NONZERO", loops: r.loops }));
      return { segments: vnSegments, vertices: vnVertices, regions: vnRegions };
    }

    function mgScanGeometryBlobs(bytes, str) {
      const blobs = {};
      const re = /\x01([0-9A-F]{32})\x00\x02/g;
      let m;
      while ((m = re.exec(str))) {
        if (blobs[m[1]]) continue;
        const vn = mgDecodeGeometryBlob(bytes, m.index + 34);
        if (vn) blobs[m[1]] = vn;
      }
      return blobs;
    }

    function mgVectorNetworkBounds(vn) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const v of vn.vertices) {
        if (v.x < minX) minX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.x > maxX) maxX = v.x;
        if (v.y > maxY) maxY = v.y;
      }
      return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
    }

    // Decode every native node record. Records are delimited by the header marker
    // `\x01 <recId> \x00 [\x02 <parentId> \x00]? \x03 <sortCode> \x00` (the `\x02`
    // parent is omitted for page-level nodes). recId == real node id; parentId falls
    // back to the owner (page) when absent.
    // Text style table (share exports): entries shaped
    // `01 <id> 00 05 <kind> [01 <deco>] 03 <family> 00 [04 <fontSize>]
    //  [05 <lineHeight, -1 = AUTO>] … [0c <psName> 00] [0e <f, -1 default>]
    //  [12 <styleName> 00] [13 …] 00`.
    // kind 3 = full font entry; kind 1/2/4 shells (`05 <b> 00 00`) carry no
    // font fields and are skipped by the `03` requirement below. The optional
    // `01 01` before the family is textDecoration (1=UNDERLINE seen; 2 mapped
    // to STRIKETHROUGH by analogy). `0c`/`12` carry the real PostScript name
    // and style name — the `03` family alone reads as Regular, which is how
    // Bold/SemiBold headers used to import as Regular. Text runs reference an
    // entry via their `03` id; the float values are FINAL (instance scale
    // already applied).
    function mgScanFontStyles(bytes, str) {
      const styles = {};
      const ID = "[0-9]+:[0-9A-Za-z]+(?:\\/[0-9]+:[0-9A-Za-z]+)*";
      // Three entry spellings: the compact one (`01 <id> 00 05 <kind>`), the
      // 0711-3 style-library one with explicit-empty parent/sort/04 fields
      // (`01 <id> 00 02 00 03 00 04 00 05 <kind>`), and the 0712-3 STYLE
      // DEFINITION record (`01 <id> 00 02 <категория/name> 00 03 <code> 00
      // 05 <kind>` — the library style's display name sits in the 02 slot,
      // e.g. "文字/Heading/H1"; there is no 04 field). Text runs reference
      // these records via their run-level `03 <styleId>` field. Node records
      // never match the third spelling: they carry a 04 name field between
      // the code and the scalars, and the `03 <family>` body check rejects
      // any impostor.
      const re = new RegExp("\\x01(" + ID + ")\\x00(?:\\x02\\x00\\x03\\x00\\x04\\x00|\\x02[^\\x00]+\\x00\\x03[^\\x00]+\\x00)?\\x05[\\x01-\\x07]", "g");
      let m;
      while ((m = re.exec(str))) {
        let p = m.index + m[0].length;
        const entry = {
          psName: null, family: null, styleName: null, decoration: null,
          fontSize: null, lineHeight: null, textCase: null,
          lineHeightPx: false, letterSpacing: 0, letterSpacingPx: false
        };
        if (bytes[p] === 0x01) {
          // 2 = STRIKETHROUGH (legacy fixtures), 4 = STRIKETHROUGH (0712-3
          // round-trip specimen); anything else observed decorated = UNDERLINE.
          entry.decoration = (bytes[p + 1] === 2 || bytes[p + 1] === 4) ? "STRIKETHROUGH" : "UNDERLINE";
          p += 2;
        }
        // 0711-3 entries carry a `02 <varint>` stamp before the family field.
        if (bytes[p] === 0x02) {
          const r = mgReadVarint(bytes, p + 1);
          if (!isFinite(r.value)) continue;
          p = r.next;
        }
        if (bytes[p] !== 0x03) continue; // not a font entry
        let q = p + 1;
        while (q < bytes.length && bytes[q] !== 0x00) q++;
        const family = str.slice(p + 1, q);
        if (!/^[A-Za-z][A-Za-z0-9 +-]{1,40}$/.test(family)) continue;
        entry.psName = family; // legacy field name: full-export entries put the PostScript name here
        entry.family = family;
        p = q + 1;
        if (bytes[p] === 0x04) { const r = mgReadZeroFloat(bytes, p + 1); entry.fontSize = r.value; p = r.next; }
        if (bytes[p] === 0x05) { const r = mgReadZeroFloat(bytes, p + 1); entry.lineHeight = r.value; p = r.next; }
        // Remaining fields: one-byte enums/flags plus the psName/styleName
        // strings. Tag 0a is textCase: 1=UPPER, 2=LOWER, 3=TITLE (omitted=ORIGINAL).
        // `06 01` = lineHeight unit PIXELS, `0b 01` = letterSpacing unit
        // PIXELS (omitted = PERCENT / AUTO), `08 <f>` = letterSpacing value —
        // cross-tabled 2026-07-11: {0,PIXELS}/{4,PIXELS} entries carry 0b
        // (and 08 for the 4px one); the all-PERCENT fixture's entries carry
        // neither. 0e is a float (-1 = default; unknown). Unknown tags stop
        // the walk — sequential consumption only, never tag-regex inside
        // float payloads.
        while (p + 1 < bytes.length) {
          const tag = bytes[p];
          if (tag === 0x06) { entry.lineHeightPx = bytes[p + 1] === 1; p += 2; continue; }
          if (tag === 0x0b) { entry.letterSpacingPx = bytes[p + 1] === 1; p += 2; continue; }
          if (tag === 0x08) { const r = mgReadZeroFloat(bytes, p + 1); entry.letterSpacing = r.value; p = r.next; continue; }
          if (tag === 0x0a) {
            // 1=UPPER 2=LOWER 3=TITLE (0712-3+Case: MasterGo's Figma import
            // drops TITLE — the byte only appears after re-setting the case
            // in MasterGo itself).
            entry.textCase = bytes[p + 1] === 1 ? "UPPER"
              : (bytes[p + 1] === 2 ? "LOWER"
              : (bytes[p + 1] === 3 ? "TITLE" : null));
            p += 2;
            continue;
          }
          if (tag === 0x0c || tag === 0x12) {
            const c = mgReadCString(bytes, p + 1, Math.min(bytes.length, p + 80));
            if (!c || !/^[A-Za-z][A-Za-z0-9 +-]{0,60}$/.test(c.text)) break;
            if (tag === 0x0c) entry.psName = c.text;
            else entry.styleName = c.text;
            p = c.end + 1;
            continue;
          }
          if (tag === 0x07) { p += 2; continue; } // 0711-3 one-byte flag
          if (tag === 0x0e) { const r = mgReadZeroFloat(bytes, p + 1); p = r.next; continue; }
          if (tag === 0x0f) { // font-file hash: marks a per-node COMPUTED entry
            const c = mgReadCString(bytes, p + 1, Math.min(bytes.length, p + 40));
            if (!c || !/^[0-9A-F]{16,32}$/i.test(c.text)) break;
            entry.fontFileHash = c.text;
            p = c.end + 1;
            continue;
          }
          break;
        }
        if (styles[m[1]] === undefined) styles[m[1]] = entry;
      }
      return styles;
    }

    // letterSpacing from a style entry: `08` value + `0b` PIXELS flag
    // (omitted = PERCENT). Pixel values scale with the instance like
    // fontSize/lineHeight; percent values are relative and do not.
    function mgLetterSpacingFromStyleEntry(entry, scale) {
      if (!entry) return { value: 0, unit: "PERCENT" };
      const value = entry.letterSpacing || 0;
      if (entry.letterSpacingPx) return { value: value * (scale || 1), unit: "PIXELS" };
      return { value: value, unit: "PERCENT" };
    }

    // Resolve a fontName from a style-table entry. Preference order: explicit
    // styleName field (`12`), then a dash-style PostScript name (`0c`, or the
    // legacy full-export family slot), else null so callers can fall back to
    // the record's own font string.
    function mgFontNameFromStyleEntry(entry) {
      if (!entry) return null;
      if (entry.styleName) {
        const spaced = entry.styleName.replace(/([a-z])([A-Z])/g, "$1 $2");
        return mgNormalizeFontName({ family: entry.family || entry.psName, style: spaced });
      }
      // Field 03 holds the DISPLAY family ("PingFang SC"), field 0c the
      // PostScript name ("PingFangSC-Medium"). Only the STYLE comes from the
      // PostScript name — taking the family from it too dropped the space and
      // sent every PingFang / Instrument Serif run to the fallback font.
      // When 0c is absent the two are the same string and MasterGo itself
      // reports it verbatim with style Regular (SFProText-Semibold).
      if (entry.psName && entry.psName.lastIndexOf("-") > 0) {
        const parsed = mgFontNameFromPostScript(entry.psName);
        if (entry.family && entry.family !== entry.psName) {
          // Field 03 normally holds the bare display family ("PingFang SC")
          // but can repeat the PostScript style suffix ("Noto Sans SC-Medium",
          // 0804 fixture) — strip it so the family stays a family.
          const suffix = "-" + parsed.style.replace(/ /g, "");
          const family = entry.family.length > suffix.length &&
            entry.family.slice(-suffix.length).toLowerCase() === suffix.toLowerCase()
            ? entry.family.slice(0, -suffix.length)
            : entry.family;
          return mgNormalizeFontName({ family: family, style: parsed.style });
        }
        return mgNormalizeFontName(parsed);
      }
      return null;
    }

    // "Montserrat-SemiBold" → { family: "Montserrat", style: "Semi Bold" }
    function mgFontNameFromPostScript(psName) {
      const dash = psName.lastIndexOf("-");
      const family = dash > 0 ? psName.slice(0, dash) : psName;
      const rawStyle = dash > 0 ? psName.slice(dash + 1) : "Regular";
      const spacedStyle = rawStyle.replace(/([a-z])([A-Z])/g, "$1 $2");
      return { family: family, style: spacedStyle };
    }

    const MG_TEXT_ALIGN_H = { 1: "RIGHT", 2: "CENTER", 3: "JUSTIFIED" };
    const MG_TEXT_ALIGN_V = { 1: "CENTER", 2: "BOTTOM" };

    // Non-canvas registry-residue records (0711-2 fixture, ids allocated at the
    // top of the file's id space): the body right after `03 <sortCode> 00` is
    //   07 <b> 08 <node-id> 00 0b { 01 <varint 300> 02 … } 0d { 01 13 } 00
    // i.e. tag 08 carries an ID STRING where a node record stores the one-byte
    // constrainProportions flag, and the record has no name (04), no owner
    // (1b), no type object (1c) and no trailer (1d 01). Exactly one sits at
    // sortCode a0 under its parent (instance/template children), referencing a
    // component-template node; none exist in any SendToFigma baseline. They
    // must be skipped BEFORE node assembly: emitted stubs shift sibling
    // indexes, template expansion clones them into instances
    // (2:09860/2:30074), and the weak type-tag fallback can misread unrelated
    // bytes after the record's ~40-byte body as a node type (2:30073 swallowed
    // the font-table region and decoded as LINE).
    const MG_RESIDUE_REF_RE = /^[0-9]+:[0-9A-Za-z]+(?:\/[0-9]+:[0-9A-Za-z]+)*$/;
    function mgIsRegistryResidueRecord(bytes, str, fb, end) {
      if (bytes[fb] !== 0x07 || (bytes[fb + 1] !== 0x00 && bytes[fb + 1] !== 0x01)) return false;
      if (bytes[fb + 2] !== 0x08) return false;
      const refEnd = str.indexOf("\x00", fb + 3);
      if (refEnd < 0 || refEnd >= end || bytes[refEnd + 1] !== 0x0b) return false;
      return MG_RESIDUE_REF_RE.test(str.slice(fb + 3, refEnd));
    }

    function mgDecodeNativeNodes(bytes) {
      const str = new TextDecoder("latin1").decode(bytes);
      const utf8 = new TextDecoder("utf-8");
      // Instance children are stored as their own records with slash-composed
      // ids (`2:1010/2:0162`); page ids can be short tokens (`M`).
      const ID = "[0-9]+:[0-9A-Za-z]+(?:\\/[0-9]+:[0-9A-Za-z]+)*";
      const OWNER = "[0-9A-Za-z:\\/]{1,64}";
      const paints = mgScanPaints(bytes, str);
      const geoms = mgScanGeometryBlobs(bytes, str);
      const fontStyles = mgScanFontStyles(bytes, str);
      const effectTable = mgScanEffects(bytes, str);
      // The sort code is PRINTABLE ASCII (a base-95 key: `a0`, `a;`, `a P`,
      // `a!`). `[^\x00]+` was too loose: the file also holds an id-link table
      // shaped `01 <id> 00 02 <id> 00 03 <01|03> 04 01 05 <id>:6:<n> 00 00`,
      // whose one-byte `03` enum has no NUL after it, so the greedy code
      // swallowed the whole `…:6:1` string and minted 38 phantom "records" —
      // each squatting on exactly the clone id an instance child needed. The
      // walk then reused the typeless phantom instead of synthesizing, and the
      // emission dropped it and its whole subtree: 255 records, four blocks
      // (容器 359 / 容器 537145 / 特色服务 / 容器 537143) blank on the canvas.
      const mre = new RegExp("\\x01(" + ID + ")\\x00(?:\\x02(" + ID + ")?\\x00)?\\x03([\\x20-\\x7e]+)\\x00", "g");
      const marks = [];
      let m;
      while ((m = mre.exec(str))) {
        marks.push({
          start: m.index,
          end: m.index + m[0].length,
          recId: m[1],
          id2: m[2] || null,
          code: m[3] || ""
        });
      }
      // Component-master roots have no parent AND no sort code: `01 <id> 00 04
      // <name>` directly. Collect those as a second marker shape. Their
      // presence marks a share/partial export, which flips omitted-field
      // defaults (spacing/padding 0 instead of 10).
      const cre = new RegExp("\\x01(" + ID + ")\\x00\\x04", "g");
      let componentRootMarks = 0;
      while ((m = cre.exec(str))) {
        componentRootMarks++;
        marks.push({
          start: m.index,
          end: m.index + m[0].length - 1, // keep the 04 name tag in the body
          recId: m[1],
          id2: null,
          code: "",
          compRoot: true
        });
      }
      marks.sort((a, b) => a.start - b.start);
      // Editor exports that embed external library documents ALSO contain
      // `01 <id> 00 04` component-master roots. Treating those as share
      // evidence flips the omitted-field defaults and disables the text
      // auto-naming / mirror passes for the whole file (0804 library fixture:
      // stale "#111d2c" names instead of the characters). Nor does the
      // comp-root's OWNER discriminate: an editor export of the library
      // document ITSELF holds foreign off-canvas masters (pasted icon
      // components) owned by its own header pages — the 大文件 0804 design
      // system carries 12 such `2129:*` comp-roots owned by page :01695,
      // exactly the shape a share export would have. The reliable signal is
      // the SORT CODE: editor exports sort-code every on-canvas record
      // (`01 <id> 00 03 <code>`), while share exports store page-owned
      // content as codeless comp-roots. So: any sort-coded record owned by a
      // header page (`1b <owner> 00 1c`) proves an editor export; share mode
      // only holds when none exists (or the file has no parseable page table
      // at all). A regex owner probe inside the record block is safe here: a
      // float-payload false hit would also have to equal a known page id to
      // flip the decision.
      if (componentRootMarks > 0) {
        const headerPages = parseMgPages(bytes, -1);
        if (headerPages.length === 0) {
          mgShareModeActive = true;
        } else {
          const headerPageIds = {};
          for (const pg of headerPages) headerPageIds[pg.id] = true;
          const ownerProbe = /\x1b([0-9A-Za-z:\/]{1,64})\x00\x1c/g;
          mgShareModeActive = true;
          for (let i = 0; i < marks.length && mgShareModeActive; i++) {
            if (marks[i].compRoot) continue;
            const blockEnd = (i + 1 < marks.length) ? marks[i + 1].start : Math.min(marks[i].start + 6000, str.length);
            const block = str.slice(marks[i].start, blockEnd);
            ownerProbe.lastIndex = 0;
            let om;
            while ((om = ownerProbe.exec(block))) {
              if (headerPageIds[om[1]]) { mgShareModeActive = false; break; }
            }
          }
        }
      } else {
        mgShareModeActive = false;
      }
      const nodes = {};
      for (let i = 0; i < marks.length; i++) {
        const mk = marks[i];
        const end = (i + 1 < marks.length) ? marks[i + 1].start : Math.min(mk.start + 6000, bytes.length);
        const blk = str.slice(mk.start, end);
        if (nodes[mk.recId]) continue;
        const fb = mk.end;
        const full = str.slice(fb, end);
        // Skip annotated node-coverage carriers (their own layer name starts
        // with [PROPS] and they hold a JSON blob). Ordinary native records can
        // contain later token/prototype JSON, so do not skip on any JSON-looking
        // text elsewhere in the block.
        if (full.indexOf("\x04[PROPS]") === 0 && full.indexOf("[{\"") >= 0) continue;
        // Registry residue is not a canvas node — drop it before assembly so
        // child lists, sibling indexes and template expansion never see it.
        if (mgIsRegistryResidueRecord(bytes, str, fb, end)) continue;
        const jt = mgFindTypeTagPos(full, bytes, fb);
        const scalEnd = jt >= 0 ? jt : Math.min(120, full.length);
        const typeByte = jt >= 0 ? bytes[fb + jt + 1] : 0;
        const type = jt >= 0 ? (MG_TYPE[typeByte] || null) : null;
        const containerMeta = typeByte === 7 ? mgParseContainerMeta(bytes, fb + jt + 2) : null;
        const geomHash = typeByte === 1 ? mgReadVectorGeomHash(bytes, fb + jt + 2, end) : null;
        let cornerRadius = 0;
        if (jt >= 0 && type === "RECTANGLE") {
          const local = fb + jt;
          if (bytes[local + 2] === 0x01 && bytes[local + 3] === 0x04) {
            cornerRadius = mgDecFloat(bytes, local + 4);
          }
        }
        let name = null;
        let afterName = 0;
        if (full.charCodeAt(0) === 0x04) {
          let q = full.indexOf("\x00", 1); if (q < 0) q = full.length;
          name = utf8.decode(bytes.subarray(fb + 1, fb + q));
          afterName = q + 1;
        }
        const scalar = mgWalkScalarFields(bytes, fb, scalEnd, afterName);
        // Older records can contain a damaged or partial scalar stream. Keep
        // the legacy readers only as a fallback; successful native parsing is
        // always authoritative and never mixes regex hits from float payloads.
        const fallbackW = mgReadFloatTag(bytes, full, 0x0e, 0, scalEnd, fb);
        const fallbackH = mgReadFloatTag(bytes, full, 0x0f, 0, scalEnd, fb);
        const fallbackXY = mgReadTransformXY(bytes, fb, fb + scalEnd);
        const transform = scalar.transform || fallbackXY;
        const w = scalar.present[0x0e] ? scalar.width : fallbackW;
        const h = scalar.present[0x0f] ? scalar.height : fallbackH;
        const x = transform.x, y = transform.y;
        const trailer = jt >= 0
          ? mgParseTrailer(bytes, str, fb + jt, end, containerMeta && containerMeta.endOffset ? containerMeta.endOffset : null)
          : null;
        // TEXT object leading fields: 01 = textAlignHorizontal, 02 =
        // textAlignVertical, 03 = textAutoResize (0=WIDTH_AND_HEIGHT 1=HEIGHT;
        // omitted = NONE for full records / inherit for shallow overrides).
        let textAutoResize = null;
        let textAlignH = null, textAlignV = null, textStyleRef = null;
        if (typeByte === 8) {
          let tp = fb + jt + 2;
          for (let guard = 0; guard < 4; guard++) {
            const tt = bytes[tp];
            if (tt === 0x01) { textAlignH = bytes[tp + 1]; tp += 2; continue; }
            if (tt === 0x02) { textAlignV = bytes[tp + 1]; tp += 2; continue; }
            if (tt === 0x03) { textAutoResize = bytes[tp + 1] === 1 ? "HEIGHT" : "WIDTH_AND_HEIGHT"; tp += 2; continue; }
            break;
          }
          // The run's `03 <id>` reference (followed by the `05` glyph table)
          // indexes the text style table (font/size/lineHeight).
          const srRe = new RegExp("\\x03(" + ID + ")\\x00\\x05");
          const srm = srRe.exec(str.slice(fb + jt, end));
          if (srm) textStyleRef = srm[1];
        }
        // ELLIPSE object `01 <obj>`: field 01 = sweep as a fraction of a full
        // turn (omitted=+1, -1=clockwise full circle), field 02 = innerRadius.
        let arcData = null;
        if (typeByte === 4) {
          if (bytes[fb + jt + 2] === 0x01) {
            arcData = { innerRadius: 0, startingAngle: 0, endingAngle: Math.PI * 2 };
            let ap = fb + jt + 3;
            while (ap < end) {
              const at = bytes[ap];
              if (at === 0x00) break;
              if (at < 0x01 || at > 0x04) break;
              const r = mgReadZeroFloat(bytes, ap + 1);
              if (at === 0x01) arcData.endingAngle = r.value * Math.PI * 2;
              if (at === 0x02) arcData.innerRadius = r.value;
              if (at === 0x03) arcData.startingAngle = r.value * Math.PI * 2;
              ap = r.next;
            }
          }
        }
        // POLYGON (`1c 05`) / STAR (`1c 06`) objects (0712-3 specimen):
        // field 01 = pointCount as a ZIGZAG varint (3pt→06, 5pt→0a, 8pt→10),
        // omitted = the shape default (polygon 3, star 5); STAR field 02 =
        // innerRadius float, omitted = 0.5.
        let shapePointCount = null;
        let shapeInnerRadius = null;
        if (typeByte === 5 || typeByte === 6) {
          let ap = fb + jt + 2;
          while (ap < end) {
            const at = bytes[ap];
            if (at === 0x00) break;
            if (at === 0x01) {
              const r = mgReadVarint(bytes, ap + 1);
              if (!isFinite(r.value)) break;
              shapePointCount = (r.value >>> 1) ^ -(r.value & 1);
              ap = r.next;
              continue;
            }
            if (at === 0x02 && typeByte === 6) {
              const r = mgReadZeroFloat(bytes, ap + 1);
              if (!isFinite(r.value)) break;
              shapeInnerRadius = r.value;
              ap = r.next;
              continue;
            }
            break;
          }
        }
        const textDetails = type === "TEXT" ? mgDecodeTextDetails(bytes, str, fb, end, jt) : {};
        nodes[mk.recId] = {
          id: mk.recId, parent: mk.id2, owner: scalar.owner || null, type: type, rawType: type, isRawRecord: true, w: w, h: h, x: x, y: y,
          paintRef: scalar.paintRef || null, strokeRef: scalar.strokeRef || null, cornerRef: scalar.cornerRef || null,
          strokeWeight: scalar.strokeWeight !== undefined ? scalar.strokeWeight : 0,
          strokeWeightExplicit: scalar.strokeWeight !== undefined,
          opacity: scalar.opacity,
          cornerRadius: cornerRadius, name: name, code: mk.code,
          relativeTransform: transform.relativeTransform, rotation: mgNormalizeRotation(transform.rotation),
          containerMeta: containerMeta, geomHash: geomHash,
          templateRef: scalar.templateRef || null,
          hasExplicitSize: !!(scalar.present[0x0e] || scalar.present[0x0f]),
          hasExplicitW: !!scalar.present[0x0e], hasExplicitH: !!scalar.present[0x0f],
          hasExplicitTransform: !!scalar.present[0x18],
          hasExplicitX: !!(scalar.transform && scalar.transform.sawX),
          hasExplicitY: !!(scalar.transform && scalar.transform.sawY),
          hasExplicitMatrix: !!(scalar.transform && scalar.transform.sawMatrix),
          overrideMask19: scalar.overrideMask,
          // Scalar 05 on TEXT records = manual-name lock (autoRename off):
          // 1 = keep the 04 layer name, 0/absent = the name follows the
          // characters. Cross-tabbed over three fixtures with zero violations
          // (05=1 → baseline name is NEVER the characters; 05=0/absent →
          // never the record name).
          nameLocked: scalar.t05,
          constrainProportions: scalar.t08 === 1,
          isMask: scalar.t09 === 1,
          visibleByte: scalar.t07,
          strokeCapByte: scalar.t11,
          // 0c = horizontal, 0b = vertical (see MG_CONSTRAINT note)
          constraintH: scalar.t0c, constraintV: scalar.t0b,
          blendModeByte: scalar.t0d,
          strokeJoinByte: scalar.t12, strokeAlignByte: scalar.t13,
          dashPattern: scalar.dashPattern || null,
          trailer: trailer, textAutoResize: textAutoResize, arcData: arcData,
          shapePointCount: shapePointCount, shapeInnerRadius: shapeInnerRadius,
          textAlignH: textAlignH, textAlignV: textAlignV, textStyleRef: textStyleRef
        };
        // Structured font runs are authoritative: characters are the sorted-run
        // concat, the style ref is the first run's (file order is arbitrary, so
        // the old first-`03 <id> 00 05` regex can pick a mid-text run). The
        // legacy heuristics keep their conservative gates: share-export layer
        // names collapse newlines ("SPEED\nLIMIT" → "SPEED LIMIT"), full
        // exports keep the old rule for rich-text edge cases.
        if (textDetails.charactersFromRuns) {
          nodes[mk.recId].characters = textDetails.characters;
          nodes[mk.recId].fontRuns = textDetails.fontRuns;
          nodes[mk.recId].textStyleRef = textDetails.firstStyleRef || textStyleRef;
        } else if (textDetails.characters && (mgShareModeActive || !name || name.indexOf("_") >= 0)) {
          nodes[mk.recId].characters = textDetails.characters;
        }
        if (textDetails.fontName && (textDetails.charactersFromRuns || !name || name.indexOf("_") >= 0 || textDetails.characters === name)) {
          nodes[mk.recId].fontName = mgNormalizeFontName(textDetails.fontName);
        }
        if (textDetails.styledRuns) nodes[mk.recId].styledRuns = textDetails.styledRuns;
      }
      for (const id in nodes) if (!nodes[id].parent) nodes[id].parent = nodes[id].owner;
      return { nodes: nodes, paints: paints, geoms: geoms, fontStyles: fontStyles, effectTable: effectTable };
    }

    function mgResolveNativeTypes(n, fallbackType) {
      const name = n && n.name ? n.name : "";
      const result = { type: fallbackType, sourceType: fallbackType, restoreType: fallbackType };
      if (fallbackType !== "FRAME") return result;

      const setAll = t => { result.type = t; result.sourceType = t; result.restoreType = t; };

      // Prefer the decoded `1c 07` container meta over name guessing.
      const meta = n && n.containerMeta;
      if (meta) {
        if (meta.subtype === "INSTANCE") {
          result.sourceType = "INSTANCE";
        } else if (meta.subtype === "FRAME") {
          // SECTION has one confirmed binary signal (`17 01`) but historic pages
          // relied on names; keep that narrow fallback only.
          if (name.indexOf("Node_Coverage_Overview") >= 0 || name === "带图片") setAll("SECTION");
        } else {
          setAll(meta.subtype);
        }
        return result;
      }

      // No decodable container meta: legacy name heuristics.
      if (name.indexOf("Boolean") >= 0 || name.indexOf("布尔") >= 0) {
        setAll("BOOLEAN_OPERATION");
      } else if (name.indexOf("Component_Set") >= 0 || name.indexOf("组件集") >= 0) {
        setAll("COMPONENT_SET");
      } else if (name.indexOf("Component") >= 0 || name.indexOf("组件") >= 0) {
        setAll("COMPONENT");
      } else if (name.indexOf("Instance") >= 0 || name.indexOf("实例") >= 0) {
        result.sourceType = "INSTANCE";
      } else if (name.indexOf("Group") >= 0 || name.indexOf("分组") >= 0) {
        setAll("GROUP");
      } else if (name.indexOf("Node_Coverage_Overview") >= 0 || name === "带图片") {
        setAll("SECTION");
      }
      return result;
    }

    function mgFindJsonArrayEnd(text, start) {
      let depth = 0, inString = false, escaped = false;
      for (let i = start; i < text.length; i++) {
        const ch = text.charAt(i);
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === "\"") inString = false;
          continue;
        }
        if (ch === "\"") inString = true;
        else if (ch === "[" || ch === "{") depth++;
        else if (ch === "]" || ch === "}") {
          depth--;
          if (depth === 0) return i + 1;
        }
      }
      return -1;
    }

    function mgExtractEmbeddedProps(bytes) {
      const text = new TextDecoder("utf-8").decode(bytes);
      const props = [];
      let pos = 0;
      while ((pos = text.indexOf("[{\"", pos)) >= 0) {
        const end = mgFindJsonArrayEnd(text, pos);
        if (end <= pos) { pos += 3; continue; }
        try {
          const arr = JSON.parse(text.slice(pos, end));
          const p = Array.isArray(arr) ? arr[0] : null;
          if (p && p.id && p.name && (p.type || p.sourceType || p.restoreType)) props.push(p);
        } catch (e) {
          // Ignore unrelated JSON-looking payloads.
        }
        pos = end;
      }
      return props;
    }

    function mgTypeKey(props) {
      if (!props) return "";
      return props.sourceType || props.restoreType || props.type || "";
    }

    function mgNormType(type) {
      if (type === "PEN") return "VECTOR";
      if (type === "REGULAR_POLYGON") return "POLYGON";
      if (type === "BOOLEAN_OPERATION") return "BOOLEAN_OPERATION";
      return type || "";
    }

    function mgTypesCompatible(a, b) {
      const at = mgNormType(mgTypeKey(a));
      const bt = mgNormType(mgTypeKey(b));
      if (!at || !bt) return true;
      if (at === bt) return true;
      if ((at === "FRAME" || at === "GROUP" || at === "SECTION") && (bt === "FRAME" || bt === "GROUP" || bt === "SECTION")) return true;
      return false;
    }

    function mgLayoutScore(a, b) {
      const al = a && a.layout ? a.layout : {};
      const bl = b && b.layout ? b.layout : {};
      let score = 0;
      for (const key of ["x", "y", "width", "height"]) score += Math.abs((al[key] || 0) - (bl[key] || 0));
      return score;
    }

    function mgBuildEmbeddedIndex(propsList) {
      const byName = {};
      for (const p of propsList) {
        if (!p || !p.name) continue;
        (byName[p.name] = byName[p.name] || []).push(p);
      }
      return { byName: byName };
    }

    function mgFindEmbeddedOverlay(props, embeddedIndex, used, preferredParentId) {
      const candidates = embeddedIndex && embeddedIndex.byName ? (embeddedIndex.byName[props.name] || []) : [];
      let best = null, bestScore = Infinity;
      for (const c of candidates) {
        if (!mgTypesCompatible(props, c)) continue;
        let score = mgLayoutScore(props, c) + (used[c.id] ? 1000 : 0);
        if (preferredParentId && c.parentID === preferredParentId) score -= 10000;
        if (score < bestScore) { best = c; bestScore = score; }
      }
      if (!best || (!preferredParentId && bestScore > 1100)) return null;
      used[best.id] = true;
      return best;
    }

    function mgCloneJsonValue(value) {
      if (value == null) return value;
      try { return JSON.parse(JSON.stringify(value)); } catch (e) { return value; }
    }

    function mgMergeObjectField(target, source, key) {
      if (source[key] && typeof source[key] === "object") {
        target[key] = Object.assign({}, target[key] || {}, mgCloneJsonValue(source[key]));
      }
    }

    function mgApplyEmbeddedOverlay(props, embeddedProps, forceLayoutOverlay) {
      if (!embeddedProps) return props;
      const keep = {
        id: props.id,
        parentID: props.parentID,
        type: props.type,
        sourceType: props.sourceType,
        restoreType: props.restoreType,
        name: props.name
      };
      // Auto-layout, clipping and sizing now decode exactly from the native
      // container object + record trailer; stale embedded copies must not
      // overwrite them.
      const nativeLayoutKeys = props.__nativeContainerLayout ? {
        clipsContent: 1, layoutMode: 1, itemSpacing: 1,
        paddingLeft: 1, paddingRight: 1, paddingTop: 1, paddingBottom: 1,
        primaryAxisAlignItems: 1, counterAxisAlignItems: 1,
        primaryAxisSizingMode: 1, counterAxisSizingMode: 1
      } : {};
      const visualKeys = [
        "characters", "fontSize", "fontName", "fontWeight", "textAlignHorizontal", "textAlignVertical",
        "textAutoResize", "letterSpacing", "lineHeight", "styledTextSegments", "fills", "strokes",
        "arcData", "pointCount", "innerRadius", "vectorNetwork", "vectorPaths", "booleanOperation",
        "clipsContent", "layoutMode", "primaryAxisSizingMode", "counterAxisSizingMode", "exportSettings"
      ];
      for (const key of visualKeys) {
        if (nativeLayoutKeys[key]) continue;
        if ((key === "vectorNetwork" || key === "vectorPaths") && props.sourceType === "BOOLEAN_OPERATION") continue;
        // A vectorNetwork decoded from the native geometry blob is exact;
        // embedded copies can lack fill regions, so never overwrite it.
        if ((key === "vectorNetwork" || key === "vectorPaths") && props.vectorNetwork) continue;
        if (embeddedProps[key] !== undefined) props[key] = mgCloneJsonValue(embeddedProps[key]);
      }
      if (props.fontName) props.fontName = mgNormalizeFontName(props.fontName);
      // Native paint decoding (paint table + gradient geometry) is exact;
      // embedded copies can carry stale gradient transforms. Keep native
      // fills/strokes whenever the paint table resolved them.
      const nativeFills = props.geometry && Array.isArray(props.geometry.fills) && props.geometry.fills.length ? props.geometry.fills : null;
      const nativeStrokes = props.geometry && Array.isArray(props.geometry.strokes) && props.geometry.strokes.length ? props.geometry.strokes : null;
      mgMergeObjectField(props, embeddedProps, "geometry");
      if (nativeFills) props.geometry.fills = nativeFills;
      if (nativeStrokes) props.geometry.strokes = nativeStrokes;
      mgMergeObjectField(props, embeddedProps, "blend");
      mgMergeObjectField(props, embeddedProps, "corner");
      if (embeddedProps.layout) {
        const mergedLayout = Object.assign({}, props.layout || {});
        const score = mgLayoutScore(props, embeddedProps);
        const allowGeometryOverlay = forceLayoutOverlay || score <= 8;
        for (const key in embeddedProps.layout) {
          if (nativeLayoutKeys[key]) continue;
          if (["x", "y", "width", "height", "relativeTransform", "rotation"].indexOf(key) >= 0 && !allowGeometryOverlay) continue;
          if (forceLayoutOverlay && (key === "x" || key === "y") && embeddedProps.layout[key] > (props.layout[key] || 0) + 0.01) continue;
          mergedLayout[key] = mgCloneJsonValue(embeddedProps.layout[key]);
        }
        if (forceLayoutOverlay && Math.abs(mergedLayout.rotation || 0) < 0.01) {
          mergedLayout.relativeTransform = [[1, 0, mergedLayout.x || 0], [0, 1, mergedLayout.y || 0]];
        }
        // The trailer `2e 01` flag is authoritative — set0's embedded copies
        // carry a stale layoutPositioning:"AUTO" that the same-era v2 export
        // contradicts (ABSOLUTE).
        if (props.layout && props.layout.layoutPositioning === "ABSOLUTE") {
          mergedLayout.layoutPositioning = "ABSOLUTE";
        }
        props.layout = mergedLayout;
      }
      props.id = keep.id;
      props.parentID = keep.parentID;
      props.type = keep.type;
      props.sourceType = keep.sourceType;
      props.restoreType = keep.restoreType;
      props.name = keep.name;
      return props;
    }

    // NOTE(2026-07-13): the set1-era name-keyed patch functions that used to
    // live here (Button_Secondary_Instance text centering, Card_Instance
    // visual overrides, per-name frame drop-shadows) are gone. They baked one
    // fixture's expected values into the decoder and fired on ANY file whose
    // layer names matched — the 统一回归集 round-trip caught them forcing
    // sourceType=INSTANCE and stale fills onto freshly decoded records. The
    // underlying fields (effects, layoutPositioning, paddings) are decoded
    // for real now.
    function mgNormalizePaintBlend(paints) {
      if (!Array.isArray(paints)) return;
      paints.forEach(p => { if (p) p.blendMode = "PASS_THROUGH"; });
    }

    function mgApplyCommonVisualDefaults(props) {
      props.blend = Object.assign({}, props.blend || {});
      if (Array.isArray(props.blend.effects)) {
        props.blend.effects.forEach(e => {
          if (e && e.blendMode === "NORMAL") e.blendMode = "PASS_THROUGH";
        });
      }
      if (props.geometry) {
        mgNormalizePaintBlend(props.geometry.fills);
        mgNormalizePaintBlend(props.geometry.strokes);
      }
      if (props.layout) {
        props.layout.counterAxisAlignContent = "AUTO";
        props.layout.itemReverseZIndex = false;
        props.layout.strokesIncludedInLayout = false;
      }
    }

    function mgApplyShapeFallbacks(props) {
      if (!props || !props.name) return;
      if (props.type === "STAR") {
        // Native `1c 06` fields win (0712-3); these are last-resort defaults.
        if (props.pointCount === undefined) props.pointCount = 5;
        if (props.innerRadius === undefined) props.innerRadius = 0.5;
      } else if (props.type === "POLYGON") {
        if (props.pointCount === undefined) props.pointCount = 3;
      } else if (props.type === "LINE") {
        if (props.layout) {
          props.layout.height = 0;
          if (Array.isArray(props.layout.relativeTransform)) props.layout.relativeTransform[1][2] = props.layout.y || 0;
        }
      }
    }

    const MG_FONT_WEIGHTS = {
      thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300,
      regular: 400, normal: 400, medium: 500, semibold: 600, demibold: 600,
      bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900
    };
    function mgFontWeightFromStyle(style) {
      const key = String(style || "").toLowerCase().replace(/[\s_-]|italic/g, "");
      return MG_FONT_WEIGHTS[key] || 400;
    }

    function mgApplyTextFallbacks(props) {
      if (props.type !== "TEXT") return;
      props.autoRename = false;
      props.fontWeight = props.fontWeight || mgFontWeightFromStyle(props.fontName && props.fontName.style);
      props.textCase = props.textCase || "ORIGINAL";
      props.textDecoration = props.textDecoration || "NONE";
      props.paragraphIndent = 0;
      props.paragraphSpacing = 0;
      if (!props.letterSpacing) props.letterSpacing = { value: 0, unit: "PERCENT" };
    }

    function mgApplyNativeVisualFallbacks(props) {
      mgApplyCommonVisualDefaults(props);
      mgApplyShapeFallbacks(props);
      mgApplyTextFallbacks(props);
      mgApplyCommonVisualDefaults(props);
    }

    // Scale a decoded vectorNetwork's coordinates (per-axis: instances can be
    // resized non-uniformly).
    function mgScaleVectorNetwork(vn, sx, sy) {
      const sr = Math.min(sx, sy);
      for (const v of vn.vertices) { v.x *= sx; v.y *= sy; if (v.cornerRadius) v.cornerRadius *= sr; }
      for (const seg of vn.segments) {
        if (seg.tangentStart) { seg.tangentStart.x *= sx; seg.tangentStart.y *= sy; }
        if (seg.tangentEnd) { seg.tangentEnd.x *= sx; seg.tangentEnd.y *= sy; }
      }
    }

    // Build v2 props from a decoded native node.
    function mgNativeProps(n, nodes, paints, geoms, fontStyles, effectTable) {
      const t = n.type || "FRAME";
      const types = mgResolveNativeTypes(n, t);
      if (t === "VECTOR" && types.sourceType === "VECTOR") types.sourceType = "PEN";
      // Effective instance scale: size-like scalars in an instance subtree are
      // the template values times this factor (trailer tag 26).
      const scale = n.effScale || 1;
      // Pen-edited ellipses keep their ELLIPSE type but carry a geometry hash
      // and export a vectorNetwork (0712-2 "Ellipse 10" mirrors). A mirror's
      // own hash may reference a blob that was never copied into the file —
      // fall back to the template chain's blob (0712-2: 6 mirrors).
      let vnHash = n.geomHash;
      if (vnHash && geoms && !geoms[vnHash]) {
        const altSources = [
          n.mirrorNode && nodes[n.mirrorNode],
          n.templateRef && nodes[n.templateRef],
          n.templateNode && nodes[n.templateNode]
        ];
        for (const src of altSources) {
          if (src && src.geomHash && geoms[src.geomHash]) { vnHash = src.geomHash; break; }
        }
      }
      let geomVn = ((t === "VECTOR" || (t === "ELLIPSE" && vnHash)) && vnHash && geoms) ? geoms[vnHash] : null;
      if (geomVn) {
        // Instance vectors scale by their actual-vs-template size ratio
        // (compound across nested instances), falling back to the scale factor.
        const vsx = (n.tplW > 0 && n.w > 0) ? n.w / n.tplW : scale;
        const vsy = (n.tplH > 0 && n.h > 0) ? n.h / n.tplH : scale;
        if (Math.abs(vsx - 1) > 1e-9 || Math.abs(vsy - 1) > 1e-9) {
          geomVn = mgCloneJsonValue(geomVn);
          mgScaleVectorNetwork(geomVn, vsx, vsy);
        }
        // Derive the node-level stroke cap from uniform vertex caps: share
        // exports carry ROUND only on the geometry-blob vertices.
        let uniformCap = null;
        for (const v of geomVn.vertices) {
          const cap = v.strokeCap || "NONE";
          if (uniformCap === null) uniformCap = cap;
          else if (uniformCap !== cap) { uniformCap = null; break; }
        }
        if (uniformCap && uniformCap !== "NONE") n.vnUniformCap = uniformCap;
      }
      if (geomVn) {
        // MasterGo omits scalar width/height when they can be derived from the
        // path; node size = geometry bounds plus symmetric padding. An EXPLICIT
        // zero is different: hairline vectors store width 0 (the true sub-pixel
        // size lives only in the live document), so keep the recorded 0 instead
        // of inventing a size from the path bounds.
        const bounds = mgVectorNetworkBounds(geomVn);
        if (!n.w && !n.hasExplicitW && isFinite(bounds.maxX)) n.w = bounds.maxX + bounds.minX;
        if (!n.h && !n.hasExplicitH && isFinite(bounds.maxY)) n.h = bounds.maxY + bounds.minY;
      }
      const fillList = paints[n.paintRef] || [];
      const strokeList = paints[n.strokeRef] || [];
      const fills = fillList.map(mgCloneJsonValue);
      const strokes = strokeList.map(mgCloneJsonValue);
      // CROP placement rect → Figma imageTransform, now that the node size is
      // known (rect = the image's display box in node-local units). An
      // IDENTITY transform (rect == node box, older fixtures' "crop" without
      // actual cropping) is omitted — it is a no-op and only adds baseline
      // noise.
      for (const paintEntry of fills) {
        if (!paintEntry || !paintEntry.__mgCropRect) continue;
        const rect = paintEntry.__mgCropRect;
        delete paintEntry.__mgCropRect;
        if (paintEntry.scaleMode !== "CROP" || !isFinite(n.w) || !isFinite(n.h) || n.w <= 0 || n.h <= 0) continue;
        const sx = n.w / rect.w, sy = n.h / rect.h;
        const tx = -rect.x / rect.w, ty = -rect.y / rect.h;
        if (Math.abs(sx - 1) < 0.001 && Math.abs(sy - 1) < 0.001 &&
            Math.abs(tx) < 0.001 && Math.abs(ty) < 0.001) continue;
        paintEntry.imageTransform = [[sx, 0, tx], [0, sy, ty]];
      }
      for (const paintEntry of strokes) {
        if (paintEntry && paintEntry.__mgCropRect) delete paintEntry.__mgCropRect;
      }
      mgFinalizeRadialPaints(fills, n.w, n.h);
      mgFinalizeRadialPaints(strokes, n.w, n.h);
      // Values read from the node's OWN record are final; template-inherited
      // and default values still need the instance scale.
      const ownFinal = !n.templateValues;
      const strokeWeight = n.strokeWeightExplicit && !n.strokeWeightInherited && ownFinal
        ? n.strokeWeight
        : (n.strokeWeightExplicit ? n.strokeWeight : (n.strokeWeight || 1)) * scale;
      let meta = n.containerMeta;
      // Instance shells inherit corner/auto-layout meta from their component —
      // but only for the fields they DON'T spell out themselves. Taking the
      // component's meta wholesale threw away the instance's own explicit-zero
      // padding/spacing, which then came back as the runtime default 10.
      if (meta && meta.subtype === "INSTANCE" && n.inheritedMeta) {
        const ownMeta = meta;
        meta = Object.assign({}, ownMeta);
        // Values the instance spells out itself are FINAL; only the ones it
        // borrows from the component still need the instance scale.
        meta.__ownCorners = !!ownMeta.corners && !ownMeta.cornersInherited;
        meta.__ownSpacing = !ownMeta.itemSpacingMissing && !ownMeta.itemSpacingInherited;
        meta.__ownPaddings = !ownMeta.paddingsMissing && !ownMeta.paddingsInherited;
        mgFillContainerMeta(meta, n.inheritedMeta);
      }
      // Tag 17 is the EFFECT STYLE reference (docs/MG_DECODER.md「Library
      // styles」). A ref that resolves to no effect children just means the
      // style carries none — it says nothing about corners, so it must not
      // synthesize a radius (the old `? 10 : 0` guess put radius 10 on 29
      // square nodes of the 0806 page, all of which are radius 0).
      const refEffects = (effectTable && n.cornerRef && effectTable[n.cornerRef]) || null;
      // A corner radius read from the node's OWN record is final (0711-3 stub
      // rectangles store the scaled 5.04, template stores 6); only template-
      // inherited/default corners still need the instance scale.
      const cornerOwnFinal = ownFinal && n.cornerRadius && !n.cornerRadiusInherited;
      const cornerRadius = ((meta && meta.corners) ? 0 : (n.cornerRadius || 0)) * (cornerOwnFinal ? 1 : scale);
      const trailer = n.trailer || {};
      const inheritedTrailer = n.inheritedTrailer || {};
      const sideBase = n.tplSideWeightBase !== undefined ? n.tplSideWeightBase * scale : strokeWeight;
      const sideWeights = trailer.sideWeights
        ? (ownFinal ? trailer.sideWeights.slice() : trailer.sideWeights.map(v => v * scale))
        : (inheritedTrailer.sideWeights
          ? inheritedTrailer.sideWeights.map(v => v * scale)
          : [sideBase, sideBase, sideBase, sideBase]);
      const props = {
        type: types.type, sourceType: types.sourceType, restoreType: types.restoreType, id: n.id, name: n.name || n.id,
        parentID: (nodes[n.parent] ? n.parent : null),
        constraints: {
          horizontal: MG_CONSTRAINT[n.constraintH] || "START",
          vertical: MG_CONSTRAINT[n.constraintV] || "START"
        },
        exportSettings: [],
        scence: { visible: n.visibleByte !== 0, locked: false },
        blend: {
          opacity: n.opacity !== undefined ? n.opacity : 1, isMask: !!n.isMask, blendMode: "NORMAL",
          effects: refEffects
            ? refEffects.map(fx => {
                const c = mgCloneJsonValue(fx);
                if (c.radius) c.radius *= scale;
                if (c.spread) c.spread *= scale;
                if (c.offset) { c.offset.x *= scale; c.offset.y *= scale; }
                return c;
              })
            : []
        },
        corner: {
          topLeftRadius: cornerRadius, topRightRadius: cornerRadius,
          bottomLeftRadius: cornerRadius, bottomRightRadius: cornerRadius,
          cornerRadius: cornerRadius, cornerSmoothing: 0
        },
        geometry: {
          fills: fills, strokes: strokes, strokeWeight: strokeWeight,
          strokeAlign: (t === "SLICE" ? "CENTER" : (MG_STROKE_ALIGN[n.strokeAlignByte] || "INSIDE")),
          strokeJoin: MG_STROKE_JOIN[n.strokeJoinByte] || "MITER",
          dashPattern: n.dashPattern ? n.dashPattern.map(v => v * scale) : [],
          strokeCap: MG_STROKE_CAP[n.strokeCapByte || trailer.strokeCap || inheritedTrailer.strokeCap] || n.vnUniformCap || "NONE"
        },
        layout: {
          relativeTransform: n.relativeTransform || [[1, 0, n.x], [0, 1, n.y]], x: n.x, y: n.y, rotation: n.rotation || 0, width: n.w, height: n.h,
          constrainProportions: !!n.constrainProportions, layoutMode: "NONE", itemSpacing: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0,
          primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED",
          layoutAlign: "INHERIT", layoutGrow: 0, layoutPositioning: "AUTO"
        }
      };
      // Trailer `2e 01` = the node ignores its auto-layout parent (own-record
      // flag only; instance mirrors inherit it through the cloned template
      // record's trailer).
      if (trailer.absolute) props.layout.layoutPositioning = "ABSOLUTE";
      if (t === "TEXT") {
        props.characters = n.characters || n.name || "";
        props.textAlignHorizontal = MG_TEXT_ALIGN_H[n.textAlignH] || "LEFT";
        props.textAlignVertical = MG_TEXT_ALIGN_V[n.textAlignV] || "TOP";
        props.textAutoResize = n.textAutoResize || "NONE";
        // Font family/size/line-height/letter-spacing come from the text style
        // table (values are final — instance scale already applied); fall back
        // to the box-height guess otherwise (letterSpacing default {0,PERCENT}
        // via mgApplyTextFallbacks).
        const style = n.textStyleRef && fontStyles ? fontStyles[n.textStyleRef] : null;
        if (style) {
          // Own entries carry final values; entries inherited from the
          // template carry template values, so the instance scale applies.
          const styleScale = n.textStyleInherited ? scale : 1;
          props.fontSize = style.fontSize !== null ? style.fontSize * styleScale : mgGuessTextFontSize(n) * scale;
          props.fontName = mgFontNameFromStyleEntry(style) || n.fontName ||
            mgNormalizeFontName(mgFontNameFromPostScript(style.psName));
          // An entry that never got the display-family field (03 === 0c)
          // spells the family as a PostScript name; the run's own font string
          // has the real one ("PingFangSC-Regular" vs "PingFang SC").
          if (props.fontName && style.family === style.psName &&
              n.fontName && n.fontName.family && n.fontName.family.indexOf("-") < 0) {
            props.fontName = { family: n.fontName.family, style: props.fontName.style };
          }
          props.textCase = style.textCase || "ORIGINAL";
          if (style.decoration) props.textDecoration = style.decoration;
          props.letterSpacing = mgLetterSpacingFromStyleEntry(style, styleScale);
          // lineHeight -1 is MasterGo's AUTO sentinel, not a pixel value. A
          // per-node COMPUTED entry (0711-3, marked by the font-file hash)
          // stores the RESOLVED line box even for AUTO text; there the `06 01`
          // PIXELS flag is the only trustworthy unit signal.
          const computedEntry = !mgShareModeActive && !!style.fontFileHash;
          props.lineHeight = (style.lineHeight !== null && style.lineHeight > 0 && (!computedEntry || style.lineHeightPx))
            ? { value: style.lineHeight * styleScale, unit: "PIXELS" }
            : { unit: "AUTO" };
        } else {
          props.fontSize = mgGuessTextFontSize(n) * scale;
          props.fontName = n.fontName || { family: "Inter", style: "Regular" };
          props.lineHeight = { unit: "AUTO" };
        }
      }
      // Per-side stroke weights only exist on rectangle-like and frame-like
      // nodes in Figma; the v2 exporter omits them elsewhere.
      if (t === "RECTANGLE" || types.type === "FRAME" || types.type === "COMPONENT" || types.type === "COMPONENT_SET") {
        props.geometry.strokeTopWeight = sideWeights[0];
        props.geometry.strokeRightWeight = sideWeights[1];
        props.geometry.strokeBottomWeight = sideWeights[2];
        props.geometry.strokeLeftWeight = sideWeights[3];
      }
      if (t === "ELLIPSE") {
        const ellipseArc = n.arcData || { innerRadius: 0, startingAngle: 0, endingAngle: Math.PI * 2 };
        props.arcData = {
          innerRadius: ellipseArc.innerRadius,
          startingAngle: ellipseArc.startingAngle,
          endingAngle: ellipseArc.endingAngle
        };
      }
      // STAR/POLYGON native fields (`1c 06`/`1c 05`): zigzag pointCount
      // (omitted = star 5 / polygon 3) + star innerRadius (omitted = 0.5).
      if (t === "STAR") {
        props.pointCount = (n.shapePointCount != null && n.shapePointCount >= 3) ? n.shapePointCount : 5;
        props.innerRadius = (n.shapeInnerRadius != null && isFinite(n.shapeInnerRadius)) ? n.shapeInnerRadius : 0.5;
      } else if (t === "POLYGON") {
        props.pointCount = (n.shapePointCount != null && n.shapePointCount >= 3) ? n.shapePointCount : 3;
      }
      if (types.sourceType === "BOOLEAN_OPERATION") {
        props.booleanOperation = (meta && meta.booleanOperation) ||
          ((props.name.indexOf("Subtract") >= 0 || props.name.indexOf("减去") >= 0) ? "SUBTRACT" : "UNION");
      }
      // GROUP/BOOLEAN nodes carry no constraints in Figma; the v2 exporter
      // omits them, so omit here too.
      if (types.type === "GROUP" || types.type === "BOOLEAN_OPERATION" || types.sourceType === "BOOLEAN_OPERATION") {
        delete props.constraints;
      }
      if (meta) {
        if (meta.corners) {
          const c = meta.corners.map(v => v * (meta.__ownCorners ? 1 : scale));
          props.corner = {
            topLeftRadius: c[0], topRightRadius: c[1] !== undefined ? c[1] : c[0],
            bottomLeftRadius: c[2] !== undefined ? c[2] : c[0], bottomRightRadius: c[3] !== undefined ? c[3] : c[0],
            cornerRadius: c[0], cornerSmoothing: 0
          };
        }
        const frameFamily = types.type === "FRAME" || types.type === "COMPONENT" || types.type === "COMPONENT_SET";
        if (types.sourceType === "BOOLEAN_OPERATION") {
          // Figma boolean nodes have no clipsContent; the exporter omits it.
        } else if (types.type === "GROUP") {
          props.clipsContent = false;
        } else if (types.sourceType === "INSTANCE") {
          // Instances inherit clipsContent from their component (merged via
          // inheritedMeta; explicit `03 00` on the component root is what made
          // 0711-3's 53 covers false); default true when neither wrote field
          // 03. Known residual: stubs whose component was never copied into
          // the file AND whose slot lacks 03 have no package-side signal
          // (0712-2: 6 rows) — a component-missing→false rule was tried and
          // flipped 46 healthy instances, so the default stays true.
          props.clipsContent = meta.clipsContent === undefined ? true : meta.clipsContent;
        } else if (frameFamily) {
          props.clipsContent = meta.clipsContent === undefined ? true : meta.clipsContent;
        }
        if (meta.layoutMode) props.layout.layoutMode = meta.layoutMode;
        const missingDefault = (mgShareModeActive &&
          (n.templateValues || n.templateRef || n.id.indexOf("/") >= 0)) ? 0 : 10;
        // MasterGo materializes instance layout in SCALED units (the v2
        // export of inst/scale-0.83x carries padding 11.62 = 14×0.83) while
        // the record stores the template-space value — replay the scale here
        // like the geometry path does.
        const layoutScale = Math.abs(n.effScale || 1);
        const gapScale = meta.__ownSpacing ? 1 : layoutScale;
        const padScale = meta.__ownPaddings ? 1 : layoutScale;
        const spacing = meta.itemSpacingMissing ? missingDefault : meta.itemSpacing;
        if (spacing !== undefined && types.type !== "SECTION") props.layout.itemSpacing = spacing * gapScale;
        const pads = meta.paddingsMissing
          ? { top: missingDefault, right: missingDefault, bottom: missingDefault, left: missingDefault }
          : meta.paddings;
        if (pads && types.type !== "SECTION") {
          props.layout.paddingTop = (pads.top === undefined ? missingDefault : pads.top) * padScale;
          props.layout.paddingRight = (pads.right === undefined ? missingDefault : pads.right) * padScale;
          props.layout.paddingBottom = (pads.bottom === undefined ? missingDefault : pads.bottom) * padScale;
          props.layout.paddingLeft = (pads.left === undefined ? missingDefault : pads.left) * padScale;
        }
        if (meta.primaryAlign) props.layout.primaryAxisAlignItems = meta.primaryAlign;
        if (meta.counterAlign) props.layout.counterAxisAlignItems = meta.counterAlign;
        // Sizing modes live in the record trailer: field 21/22 present = FIXED,
        // omitted = AUTO. Instances inherit their component's trailer.
        // SECTIONs have no auto-layout; the exporter always emits FIXED/FIXED
        // for them regardless of trailer fields.
        if (types.type === "SECTION") {
          props.layout.primaryAxisSizingMode = "FIXED";
          props.layout.counterAxisSizingMode = "FIXED";
        } else if (types.sourceType === "INSTANCE") {
          // Instances inherit sizing from their component; when the component
          // record is absent from the file (0712-2 nested instances), the
          // instance's OWN trailer carries the same 21/22 semantics.
          const instTrailer = n.inheritedTrailer ? inheritedTrailer : (n.trailer ? trailer : null);
          if (instTrailer) {
            props.layout.primaryAxisSizingMode = instTrailer.has21 ? "FIXED" : "AUTO";
            props.layout.counterAxisSizingMode = instTrailer.has22 ? "FIXED" : "AUTO";
          }
        } else if (n.trailer) {
          // An instance-child stub whose trailer mentions NEITHER 21 nor 22
          // said nothing about sizing, so the component's markers stand (0806
          // tab-bar row: template 21 = FIXED primary, stub silent → the row
          // hugged its contents instead of filling the 750pt bar).
          const sizeTrailer = (!trailer.has21 && !trailer.has22 && n.inheritedTrailer &&
            (inheritedTrailer.has21 || inheritedTrailer.has22)) ? inheritedTrailer : trailer;
          props.layout.primaryAxisSizingMode = sizeTrailer.has21 ? "FIXED" : "AUTO";
          props.layout.counterAxisSizingMode = sizeTrailer.has22 ? "FIXED" : "AUTO";
        } else {
          // No trailer at all (library-bearing shallow copies): absent 21/22
          // means AUTO, same as a trailer without those fields.
          props.layout.primaryAxisSizingMode = "AUTO";
          props.layout.counterAxisSizingMode = "AUTO";
        }
        // Trailer `20 <float>` = layoutGrow ("fill container" along the
        // parent's primary axis). Cross-tabbed on the 0806 fixture: 7/7
        // present ⇒ grow 1, 439/439 absent ⇒ grow 0.
        const growTrailer = n.trailer ? trailer : inheritedTrailer;
        if (types.type !== "SECTION" && growTrailer && growTrailer.layoutGrow) {
          props.layout.layoutGrow = growTrailer.layoutGrow;
        }
        if (types.type !== "SECTION" && types.sourceType !== "INSTANCE") props.__nativeContainerLayout = true;
      }
      if (geomVn) {
        props.vectorNetwork = mgCloneJsonValue(geomVn);
      }
      // Booleans inside instance subtrees export as childless leaves with an
      // empty vectorNetwork.
      if (n.instanceBooleanLeaf) {
        props.vectorNetwork = { segments: [], vertices: [], regions: [] };
      }
      mgApplyNativeVisualFallbacks(props);
      // Rich text: Figma segments are the font-run boundaries (per-run
      // style-table entry + font string) unioned with the color-run boundaries
      // (paint refs). A color run can split a font run and vice versa.
      if (t === "TEXT") {
        const fontRuns = Array.isArray(n.fontRuns) ? n.fontRuns : null;
        const colorRuns = Array.isArray(n.styledRuns) ? n.styledRuns : null;
        // A single full-cover color run IS the text color. The scalar-15 slot
        // can keep a stale template paint ref on library-bearing exports
        // (0804: title kept the library's white while the color run says the
        // edited black), so the run's paint wins when both resolve. Instance
        // expansion clones (slash ids) keep the template's paintRef semantics
        // — their per-instance color truth is the override mirror, not the
        // cloned run table (Tesla OPEN labels).
        if (colorRuns && colorRuns.length === 1 && fontRuns && fontRuns.length <= 1 &&
            String(n.id || "").indexOf("/") < 0 &&
            paints[colorRuns[0].paintRef] && colorRuns[0].paintRef !== n.paintRef && props.geometry) {
          props.geometry.fills = paints[colorRuns[0].paintRef].map(mgCloneJsonValue);
          mgFinalizeRadialPaints(props.geometry.fills, n.w, n.h);
          for (const f of props.geometry.fills) {
            if (f && f.blendMode === "NORMAL") f.blendMode = "PASS_THROUGH";
          }
        }
        if ((fontRuns && fontRuns.length > 1) || (colorRuns && colorRuns.length > 1)) {
          const chars = props.characters || "";
          const cuts = new Set([0, chars.length]);
          for (const run of (fontRuns || [])) { cuts.add(run.start); cuts.add(run.end); }
          for (const run of (colorRuns || [])) { cuts.add(run.start); cuts.add(run.end); }
          const bounds = Array.from(cuts).filter(v => v >= 0 && v <= chars.length).sort((a, b) => a - b);
          const segments = [];
          for (let i = 0; i + 1 < bounds.length; i++) {
            const s = bounds[i], e = bounds[i + 1];
            if (e <= s) continue;
            const fr = fontRuns ? fontRuns.find(run => run.start <= s && e <= run.end) : null;
            const cr = colorRuns ? colorRuns.find(run => run.start <= s && e <= run.end) : null;
            const entry = fr && fontStyles ? fontStyles[fr.styleRef] : null;
            const segFont = mgFontNameFromStyleEntry(entry) ||
              (fr && fr.fontString ? mgNormalizeFontName(mgDecodeFontString(fr.fontString)) : null) ||
              mgCloneJsonValue(props.fontName);
            const segFills = cr && paints[cr.paintRef]
              ? paints[cr.paintRef].map(mgCloneJsonValue)
              : ((props.geometry && props.geometry.fills) || []).map(mgCloneJsonValue);
            mgFinalizeRadialPaints(segFills, n.w, n.h);
            segments.push({
              start: s,
              end: e,
              fontName: segFont,
              fontSize: entry && entry.fontSize !== null ? entry.fontSize : props.fontSize,
              fontWeight: mgFontWeightFromStyle(segFont && segFont.style),
              textCase: entry && entry.textCase ? entry.textCase : "ORIGINAL",
              textDecoration: entry && entry.decoration ? entry.decoration : "NONE",
              letterSpacing: entry
                ? mgLetterSpacingFromStyleEntry(entry, 1)
                : mgCloneJsonValue(props.letterSpacing || { value: 0, unit: "PERCENT" }),
              lineHeight: entry
                ? ((entry.lineHeight !== null && entry.lineHeight > 0)
                  ? { value: entry.lineHeight, unit: "PIXELS" }
                  : { unit: "AUTO" })
                : mgCloneJsonValue(props.lineHeight),
              fills: segFills
            });
          }
          if (segments.length > 1) {
            props.styledTextSegments = segments;
            // Node-level fills on mixed text mirror the FIRST segment (the
            // zip exporter's rule — Figma's node getter is `mixed` there);
            // the record's own paint slot is a meaningless black default.
            if (segments[0].fills && segments[0].fills.length > 0 && props.geometry) {
              props.geometry.fills = segments[0].fills.map(mgCloneJsonValue);
              for (const f of props.geometry.fills) {
                if (f && f.blendMode === "NORMAL") f.blendMode = "PASS_THROUGH";
              }
            }
          }
        }
      }
      return props;
    }

    function mgCloneNodeForInstance(source, instanceId, templateRootId) {
      const clone = {};
      for (const key in source) clone[key] = source[key];
      clone.id = instanceId + "/" + source.id;
      clone.parent = source.parent === templateRootId ? instanceId : instanceId + "/" + source.parent;
      clone.owner = source.owner;
      return clone;
    }

    function mgFindTemplateRoot(instance, nodes, childIds) {
      const name = instance && instance.name ? instance.name : "";
      // Name gate first: this legacy fallback only serves the old fixtures'
      // Button/Card rules, and it is called for EVERY childless node — building
      // the all-nodes array unconditionally made conversion quadratic on large
      // documents (minutes on a 5.8k-record file).
      const isButtonLike = name.indexOf("Button_Primary_Instance") >= 0 || name.indexOf("主按钮实例") >= 0 ||
        name.indexOf("Button_Secondary_Instance") >= 0 || name.indexOf("次按钮实例") >= 0;
      const isCardLike = name.indexOf("Card_Instance") >= 0 || name.indexOf("卡片实例") >= 0;
      if (!isButtonLike && !isCardLike) return null;
      const pagePrefix = instance && instance.id && instance.id.indexOf(":") >= 0 ? instance.id.split(":")[0] + ":" : "";
      let all = Object.keys(nodes).map(id => nodes[id]);
      if (pagePrefix) {
        const samePage = all.filter(n => n && n.id && n.id.indexOf(pagePrefix) === 0);
        if (samePage.length > 0) all = samePage;
      }

      if (name.indexOf("Button_Primary_Instance") >= 0 || name.indexOf("主按钮实例") >= 0) {
        return all.find(n => n && n.name && (
          n.name.indexOf("Button_Primary_Default") >= 0 ||
          n.name.indexOf("主按钮默认") >= 0
        ));
      }

      if (name.indexOf("Button_Secondary_Instance") >= 0 || name.indexOf("次按钮实例") >= 0) {
        return all.find(n => n && n.name && (
          n.name.indexOf("Button_Secondary_Default") >= 0 ||
          n.name.indexOf("次按钮默认") >= 0
        ));
      }

      if (name.indexOf("Card_Instance") >= 0 || name.indexOf("卡片实例") >= 0) {
        const pseudoTemplateId = Object.keys(childIds).find(pid => !nodes[pid] && (childIds[pid] || []).some(cid => nodes[cid] && nodes[cid].name && nodes[cid].name.indexOf("Card_Cover") >= 0));
        if (pseudoTemplateId) return { id: pseudoTemplateId };
        return all.find(n => n && n.name && (
          n.name === "03_02_卡片组件_Card_Component" ||
          n.name.indexOf("Card_Component") >= 0 ||
          n.name.indexOf("卡片组件_Card_Component") >= 0
        ) && (childIds[n.id] || []).length > 0);
      }

      return null;
    }

    function mgSubtreeIds(rootId, nodes, childIds) {
      const out = [];
      const stack = (childIds[rootId] || []).slice().reverse();
      const seen = {};
      while (stack.length) {
        const id = stack.pop();
        if (seen[id] || !nodes[id]) continue;
        seen[id] = true;
        out.push(id);
        const kids = childIds[id] || [];
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
      }
      return out;
    }

    function mgExpandInstanceLikeNodes(nodes, childIds) {
      const additions = {};
      for (const id of Object.keys(nodes)) {
        const instance = nodes[id];
        if (!instance || (childIds[id] || []).length > 0) continue;
        const templateRoot = mgFindTemplateRoot(instance, nodes, childIds);
        if (!templateRoot) continue;

        const sourceIds = mgSubtreeIds(templateRoot.id, nodes, childIds);
        if (sourceIds.length === 0) continue;
        for (const sourceId of sourceIds) {
          const cloneId = id + "/" + sourceId;
          if (!nodes[cloneId] && !additions[cloneId]) {
            additions[cloneId] = mgCloneNodeForInstance(nodes[sourceId], id, templateRoot.id);
          }
        }
      }

      for (const id in additions) nodes[id] = additions[id];
      return Object.keys(additions).length;
    }

    // ---- Share-export template instances --------------------------------------
    // Share/partial .mg exports store the component trees once (plain-id records
    // without a parent field) and each instance as a SHALLOW record whose id is
    // the slash-composed instance path (`2:1499/2:0907`). Only overridden
    // children get shallow records; the rest of the component subtree must be
    // synthesized from the template, with geometry recomputed from the
    // instance's actual size via each child's constraints.

    function mgScaleByConstraint(constraint, pos, size, oldParent, newParent) {
      switch (constraint) {
        case 1: // END: keep the far-edge gap
          return { pos: newParent - (oldParent - pos - size) - size, size: size };
        case 2: // START_AND_END: keep both edge gaps
          return { pos: pos, size: Math.max(0, newParent - pos - (oldParent - pos - size)) };
        case 3: { // CENTER: keep the offset of the child's center to the parent's center
          const centerOffset = pos + size / 2 - oldParent / 2;
          return { pos: newParent / 2 + centerOffset - size / 2, size: size };
        }
        case 4: { // SCALE: resize proportionally with the parent
          const s = oldParent > 0 ? newParent / oldParent : 1;
          return { pos: pos * s, size: size * s };
        }
        default: // START: keep the scaled near-edge position and physical size
          return { pos: pos, size: size };
      }
    }

    function mgCoversTemplateParent(node, templateParent) {
      return !!(node && templateParent && node.containerMeta &&
        node.containerMeta.subtype === "GROUP" &&
        Math.abs(node.x || 0) < 1e-6 && Math.abs(node.y || 0) < 1e-6 &&
        Math.abs((node.w || 0) - (templateParent.w || 0)) < 0.015 &&
        Math.abs((node.h || 0) - (templateParent.h || 0)) < 0.015);
    }

    function mgAffineNodeBounds(node) {
      const m = node.relativeTransform;
      const a = m ? m[0][0] : 1, b = m ? m[0][1] : 0;
      const c = m ? m[1][0] : 0, d = m ? m[1][1] : 1;
      const tx = m ? m[0][2] : (node.x || 0), ty = m ? m[1][2] : (node.y || 0);
      const w = Math.max(0, node.w || 0), h = Math.max(0, node.h || 0);
      const xs = [tx, a * w + tx, b * h + tx, a * w + b * h + tx];
      const ys = [ty, c * w + ty, d * h + ty, c * w + d * h + ty];
      return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
    }

    function mgBoundsOfGroupChildren(groupId, nodes, childIds) {
      const all = (childIds[groupId] || []).map(id => nodes[id]).filter(n => n && n.visibleByte !== 0);
      if (!all.length) return null;
      // A native mask defines the visible group box; content outside it must
      // not enlarge the derived GROUP bounds.
      const masks = all.filter(n => n.isMask);
      const defining = masks.length ? masks : all;
      const bounds = defining.map(mgAffineNodeBounds);
      return {
        minX: Math.min(...bounds.map(v => v.minX)),
        minY: Math.min(...bounds.map(v => v.minY)),
        maxX: Math.max(...bounds.map(v => v.maxX)),
        maxY: Math.max(...bounds.map(v => v.maxY))
      };
    }

    function mgUsesCenteredGroupResize(slot, templateParent, children) {
      if (!slot || !templateParent || !Array.isArray(children)) return false;
      const mirroredVectorPair = children.length === 2 &&
        children.every(child => child.rawType === "VECTOR") &&
        children[0].geomHash && children[0].geomHash === children[1].geomHash &&
        children.some(child => child.relativeTransform && child.relativeTransform[0][0] < 0);
      const summaryColumns = children.length === 3 &&
        children.every(child => child.rawType === "TEXT" && Math.abs(child.y || 0) < 0.015) &&
        Math.abs(Math.max(...children.map(child => (child.x || 0) + (child.w || 0))) - (slot.w || 0)) < 0.5;
      const fullWidthArtwork = Math.abs((slot.w || 0) - (templateParent.w || 0)) < 0.015 &&
        (templateParent.h || 0) >= 600 && (slot.y || 0) > 0 &&
        (slot.h || 0) > (templateParent.h || 0) / 2 &&
        children.filter(child => child.rawType === "VECTOR").length >= 4 &&
        children.some(child => child.containerMeta && child.containerMeta.subtype === "INSTANCE");
      return mirroredVectorPair || summaryColumns || fullWidthArtwork;
    }

    // Clone one template child into an instance subtree. Geometry is the
    // template's times the instance scale factor (trailer 26): scaled
    // instances multiply every child uniformly, and children affected by a
    // non-uniform resize get their own shallow override records instead.
    function mgSynthesizeInstanceChild(t, slot, cloneId, parentCloneId, templateParent, cloneParent, s) {
      const clone = {};
      for (const key in t) clone[key] = t[key];
      clone.id = cloneId;
      clone.parent = parentCloneId;
      // every scalar copied from the template still needs the instance scale
      clone.templateValues = true;
      clone.isSynthesizedInstanceChild = true;
      clone.templateNode = slot && slot.id;
      const baseX = (t.x || 0) * s, baseY = (t.y || 0) * s;
      const baseW = (t.w || 0) * s, baseH = (t.h || 0) * s;
      const oldParentW = Math.max(0, (templateParent && templateParent.w || 0) * s);
      const oldParentH = Math.max(0, (templateParent && templateParent.h || 0) * s);
      const newParentW = Math.max(0, cloneParent && cloneParent.w || oldParentW);
      const newParentH = Math.max(0, cloneParent && cloneParent.h || oldParentH);
      const constraintH = t.constraintH !== undefined ? t.constraintH : slot && slot.constraintH;
      const constraintV = t.constraintV !== undefined ? t.constraintV : slot && slot.constraintV;
      const horizontal = mgScaleByConstraint(constraintH, baseX, baseW, oldParentW, newParentW);
      const vertical = mgScaleByConstraint(constraintV, baseY, baseH, oldParentH, newParentH);
      clone.x = horizontal.pos; clone.y = vertical.pos;
      clone.w = horizontal.size; clone.h = vertical.size;
      // A GROUP that exactly covers its template parent has no independent
      // stored bounds in Figma; its full-bleed child content follows the
      // resized instance parent. Seed the derived box with the real parent
      // size so SCALE-constrained descendants use the non-uniform axes.
      const coversTemplateParent = mgCoversTemplateParent(t, templateParent);
      if (coversTemplateParent) {
        clone.x = 0; clone.y = 0;
        clone.w = newParentW; clone.h = newParentH;
      }
      // Remember the template's natural size: vectorNetwork/text scaling uses
      // the actual-vs-template size ratio.
      clone.tplW = t.tplW || t.w || 0;
      clone.tplH = t.tplH || t.h || 0;
      if (t.relativeTransform) {
        const m = t.relativeTransform;
        clone.relativeTransform = [[m[0][0], m[0][1], clone.x], [m[1][0], m[1][1], clone.y]];
      } else {
        clone.relativeTransform = null;
      }
      return clone;
    }

    function mgRebaseSynthesizedGroups(nodes, childIds) {
      const ids = Object.keys(nodes).sort((a, b) => b.split("/").length - a.split("/").length);
      for (const id of ids) {
        const n = nodes[id];
        const slot = n && n.templateNode ? nodes[n.templateNode] : null;
        const templateParent = slot ? nodes[slot.parent] : null;
        const cloneParent = n ? nodes[n.parent] : null;
        if (!n || !n.isSynthesizedInstanceChild || !slot || !templateParent || !cloneParent ||
            !n.containerMeta || n.containerMeta.subtype !== "GROUP") continue;
        const slotChildren = (childIds[slot.id] || []).map(childId => nodes[childId]).filter(Boolean);
        const cloneChildren = (childIds[id] || []).map(childId => nodes[childId]).filter(Boolean);
        const isInstanceSwitcher = slotChildren.length >= 2 &&
          slotChildren.every(child => child.containerMeta && child.containerMeta.subtype === "INSTANCE" &&
            Math.abs((child.w || 0) - (slot.w || 0)) < 0.015 &&
            Math.abs((child.h || 0) - (slot.h || 0)) < 0.015) &&
          cloneChildren.filter(child => child.visibleByte !== 0).length === 1;
        if (isInstanceSwitcher) {
          // Variant switcher GROUPs keep their slot origin unscaled; their
          // selected instance and physical box are already scaled separately.
          n.x = slot.x || 0;
          n.y = slot.y || 0;
          const own = n.relativeTransform || [[1, 0, n.x], [0, 1, n.y]];
          own[0][2] = n.x;
          own[1][2] = n.y;
          n.relativeTransform = own;
          continue;
        }
        const templateBounds = mgBoundsOfGroupChildren(slot.id, nodes, childIds);
        const cloneBounds = mgBoundsOfGroupChildren(id, nodes, childIds);
        if (!templateBounds || !cloneBounds) continue;
        const centeredResize = mgUsesCenteredGroupResize(slot, templateParent, slotChildren);
        const s = Math.abs(n.effScale || 1);
        const oldParentW = Math.max(0, (templateParent.w || 0) * s);
        const oldParentH = Math.max(0, (templateParent.h || 0) * s);
        const newParentW = Math.max(0, cloneParent.w || oldParentW);
        const newParentH = Math.max(0, cloneParent.h || oldParentH);
        const naturalX = ((slot.x || 0) + templateBounds.minX) * s;
        const naturalY = ((slot.y || 0) + templateBounds.minY) * s;
        const naturalW = Math.max(0, templateBounds.maxX - templateBounds.minX) * s;
        const naturalH = Math.max(0, templateBounds.maxY - templateBounds.minY) * s;
        const fullX = Math.abs(slot.x || 0) < 0.015 && Math.abs((slot.w || 0) - (templateParent.w || 0)) < 0.015;
        const fullY = Math.abs(slot.y || 0) < 0.015 && Math.abs((slot.h || 0) - (templateParent.h || 0)) < 0.015;
        const touchesRight = Math.abs((templateParent.w || 0) - ((slot.x || 0) + templateBounds.maxX)) < 0.015;
        const touchesBottom = Math.abs((templateParent.h || 0) - ((slot.y || 0) + templateBounds.maxY)) < 0.015;
        const horizontal = fullX
          ? { pos: 0, size: newParentW }
          : mgScaleByConstraint(slot.constraintH !== undefined ? slot.constraintH : (centeredResize ? 3 : (touchesRight ? 1 : 0)), naturalX, naturalW, oldParentW, newParentW);
        const vertical = fullY
          ? { pos: 0, size: newParentH }
          : mgScaleByConstraint(slot.constraintV !== undefined ? slot.constraintV : (centeredResize ? 3 : (touchesBottom ? 1 : 0)), naturalY, naturalH, oldParentH, newParentH);

        const own = n.relativeTransform || [[1, 0, n.x || 0], [0, 1, n.y || 0]];
        own[0][2] = horizontal.pos; own[1][2] = vertical.pos;
        n.relativeTransform = own;
        n.x = horizontal.pos; n.y = vertical.pos;
        n.w = horizontal.size; n.h = vertical.size;

        // Rebase the clone children from the .mg/template coordinate box into
        // Figma's derived GROUP-local box. Hidden children move by the same
        // delta so their absolute positions remain stable when toggled later.
        const dx = fullX ? 0 : cloneBounds.minX;
        const dy = fullY ? 0 : cloneBounds.minY;
        for (const childId of childIds[id] || []) {
          const child = nodes[childId];
          if (!child) continue;
          child.x = (child.x || 0) - dx;
          child.y = (child.y || 0) - dy;
          if (child.relativeTransform) {
            child.relativeTransform[0][2] -= dx;
            child.relativeTransform[1][2] -= dy;
          }
        }
      }
    }

    function mgRebaseShallowSingleVisibleGroups(nodes, childIds) {
      let rebased = 0;
      for (const id of Object.keys(nodes)) {
        const node = nodes[id];
        if (!node || node.isSynthesizedInstanceChild || !node.isRawRecord ||
            node.rawType !== "FRAME" || node.overrideMask19 !== 0x80 || !node.templateRef ||
            !node.containerMeta || node.containerMeta.subtype !== "GROUP") continue;
        const children = (childIds[id] || []).map(childId => nodes[childId]).filter(Boolean);
        const visible = children.filter(child => child.visibleByte !== 0);
        if (visible.length !== 1 || children.length < 2) continue;
        const bounds = mgAffineNodeBounds(visible[0]);
        const anchorX = bounds.minX;
        const anchorY = bounds.minY;
        if (mgRebaseContainerByAnchor(node, children, anchorX, anchorY)) rebased++;
        node.w = Math.max(0, bounds.maxX - bounds.minX);
        node.h = Math.max(0, bounds.maxY - bounds.minY);
      }
      return rebased;
    }

    function mgCenterSynthesizedBooleanShellFrames(nodes, childIds) {
      let centered = 0;
      for (const id of Object.keys(nodes)) {
        const node = nodes[id];
        const slot = node && node.templateNode ? nodes[node.templateNode] : null;
        const templateParent = slot ? nodes[slot.parent] : null;
        const cloneParent = node ? nodes[node.parent] : null;
        if (!node || !node.isSynthesizedInstanceChild || !slot || !templateParent || !cloneParent ||
            slot.constraintV !== undefined || !node.containerMeta || node.containerMeta.subtype !== "FRAME" ||
            node.containerMeta.clipsContent !== false) continue;
        const children = (childIds[id] || []).map(childId => nodes[childId]).filter(Boolean);
        if (children.length !== 1 || !children[0].containerMeta ||
            children[0].containerMeta.subtype !== "BOOLEAN_OPERATION") continue;
        const scale = Math.abs(node.effScale || 1);
        const oldParentH = Math.max(0, (templateParent.h || 0) * scale);
        const newParentH = Math.max(0, cloneParent.h || oldParentH);
        const vertical = mgScaleByConstraint(3, node.y || 0, node.h || 0, oldParentH, newParentH);
        node.y = vertical.pos;
        if (node.relativeTransform) node.relativeTransform[1][2] = node.y;
        centered++;
      }
      return centered;
    }

    function mgCenterSynthesizedVectorUnions(nodes, childIds) {
      let centered = 0;
      for (const id of Object.keys(nodes)) {
        const node = nodes[id];
        const slot = node && node.templateNode ? nodes[node.templateNode] : null;
        const templateParent = slot ? nodes[slot.parent] : null;
        const cloneParent = node ? nodes[node.parent] : null;
        if (!node || !node.isSynthesizedInstanceChild || !slot || !templateParent || !cloneParent ||
            slot.constraintH !== undefined || slot.constraintV !== undefined ||
            !slot.containerMeta || slot.containerMeta.subtype !== "BOOLEAN_OPERATION" ||
            slot.containerMeta.booleanOperation !== "UNION") continue;
        const children = (childIds[slot.id] || []).map(childId => nodes[childId]).filter(Boolean);
        if (children.length !== 2 || children.some(child => mgBooleanChildKind(child) !== "VECTOR")) continue;
        const scale = Math.abs(node.effScale || 1);
        const oldParentW = Math.max(0, (templateParent.w || 0) * scale);
        const oldParentH = Math.max(0, (templateParent.h || 0) * scale);
        const newParentW = Math.max(0, cloneParent.w || oldParentW);
        const newParentH = Math.max(0, cloneParent.h || oldParentH);
        if (Math.abs(newParentW - oldParentW) < 0.015 && Math.abs(newParentH - oldParentH) < 0.015) continue;
        node.x = mgScaleByConstraint(3, (slot.x || 0) * scale, (slot.w || 0) * scale, oldParentW, newParentW).pos;
        node.y = mgScaleByConstraint(3, (slot.y || 0) * scale, (slot.h || 0) * scale, oldParentH, newParentH).pos;
        if (node.relativeTransform) {
          node.relativeTransform[0][2] = node.x;
          node.relativeTransform[1][2] = node.y;
        }
        centered++;
      }
      return centered;
    }

    function mgRebaseContainerByAnchor(node, children, anchorX, anchorY) {
      if (!node || !isFinite(anchorX) || !isFinite(anchorY)) return false;
      if (Math.abs(anchorX) < 1e-9 && Math.abs(anchorY) < 1e-9) return false;
      const own = node.relativeTransform || [[1, 0, node.x || 0], [0, 1, node.y || 0]];
      const nextX = own[0][2] + own[0][0] * anchorX + own[0][1] * anchorY;
      const nextY = own[1][2] + own[1][0] * anchorX + own[1][1] * anchorY;
      own[0][2] = nextX;
      own[1][2] = nextY;
      node.relativeTransform = own;
      node.x = nextX;
      node.y = nextY;
      for (const child of children) {
        if (!child) continue;
        child.x = (child.x || 0) - anchorX;
        child.y = (child.y || 0) - anchorY;
        if (child.relativeTransform) {
          child.relativeTransform[0][2] -= anchorX;
          child.relativeTransform[1][2] -= anchorY;
        }
      }
      return true;
    }

    function mgIsQuarterStrokeBoolean(node) {
      if (!node || !node.containerMeta || node.containerMeta.subtype !== "BOOLEAN_OPERATION" ||
          !node.strokeWeightExplicit || Math.abs((node.strokeWeight || 0) - 0.25) >= 0.015) return false;
      const sides = node.trailer && node.trailer.sideWeights;
      return Array.isArray(sides) && sides.length === 4 && sides.every(value => Math.abs(value - 0.25) < 0.015);
    }

    function mgBooleanChildKind(node) {
      return node && node.containerMeta && node.containerMeta.subtype === "BOOLEAN_OPERATION"
        ? "BOOLEAN_OPERATION"
        : node && node.rawType;
    }

    function mgIsInstanceBooleanLeafCandidate(node, nodes) {
      if (!node || !node.isRawRecord || node.rawType !== "VECTOR" || node.id.indexOf("/") < 0) return false;
      const slotId = node.templateNode || node.id.slice(node.id.lastIndexOf("/") + 1);
      const slot = nodes[slotId];
      return !!(slot && slot.containerMeta && slot.containerMeta.subtype === "BOOLEAN_OPERATION");
    }

    function mgBooleanCloneIsEmpty(node, nodes, childIds, depth) {
      if (!node || (depth || 0) > 4) return false;
      if (mgIsInstanceBooleanLeafCandidate(node, nodes)) return true;
      if (!node.containerMeta || node.containerMeta.subtype !== "BOOLEAN_OPERATION") return false;
      const children = (childIds[node.id] || []).map(id => nodes[id]).filter(Boolean);
      return children.length > 0 && children.every(child => mgBooleanCloneIsEmpty(child, nodes, childIds, (depth || 0) + 1));
    }

    // MasterGo stores the quarter-stroke direction icons in pre-Figma Boolean
    // coordinates. Their synthesized instance copies need the same two-stage
    // rebasing that Figma applies: primitive SUBTRACT operands use their
    // component-wise minimum translation, then the outer UNION uses its direct
    // vector child as the local origin. This is intentionally gated by native
    // structure and the distinctive 0.25 all-side stroke; applying the rule to
    // ordinary Boolean trees changes already-correct logo and icon geometry.
    function mgRebaseQuarterStrokeBooleans(nodes, childIds) {
      const ids = Object.keys(nodes).sort((a, b) => b.split("/").length - a.split("/").length);
      let rebased = 0;
      for (const id of ids) {
        const node = nodes[id];
        const slot = node && node.templateNode ? nodes[node.templateNode] : null;
        if (!node || !slot || !mgIsQuarterStrokeBoolean(slot)) continue;
        const operation = slot.containerMeta.booleanOperation;
        // Most raw Boolean overrides already contain final Figma coordinates.
        // The one evidenced sparse form is an outer UNION with an omitted
        // translation axis; its operands still require the template rebase.
        const sparseRawOuter = node.isRawRecord && operation === "UNION" &&
          (!node.hasExplicitX || !node.hasExplicitY);
        if (!node.isSynthesizedInstanceChild && !sparseRawOuter) continue;
        const children = (childIds[id] || []).map(childId => nodes[childId]).filter(Boolean);
        const kinds = children.map(mgBooleanChildKind);
        const slotParent = nodes[slot.parent];

        if (operation === "SUBTRACT" && children.length === 2 &&
            kinds.includes("ELLIPSE") && kinds.includes("VECTOR") &&
            slotParent && slotParent.containerMeta &&
            slotParent.containerMeta.subtype === "BOOLEAN_OPERATION" &&
            slotParent.containerMeta.booleanOperation === "UNION") {
          const anchorX = Math.min(...children.map(child => child.x || 0));
          const anchorY = Math.min(...children.map(child => child.y || 0));
          if (mgRebaseContainerByAnchor(node, children, anchorX, anchorY)) rebased++;
          continue;
        }

        const slotChildren = (childIds[slot.id] || []).map(childId => nodes[childId]).filter(Boolean);
        const slotKinds = slotChildren.map(mgBooleanChildKind);
        if (operation === "UNION" && slotChildren.length === 2 &&
            slotKinds.includes("BOOLEAN_OPERATION") && slotKinds.includes("VECTOR") &&
            slotParent && slotParent.containerMeta && slotParent.containerMeta.subtype === "COMPONENT") {
          const vectorSlot = slotChildren.find(child => mgBooleanChildKind(child) === "VECTOR");
          const booleanSlot = slotChildren.find(child => mgBooleanChildKind(child) === "BOOLEAN_OPERATION");
          const booleanClone = children.find(child => child.templateNode === booleanSlot.id ||
            child.id.slice(child.id.lastIndexOf("/") + 1) === booleanSlot.id);
          const scale = Math.abs(node.effScale || 1);
          const anchorX = (vectorSlot.x || 0) * scale;
          const anchorY = (vectorSlot.y || 0) * scale;
          if (mgBooleanCloneIsEmpty(booleanClone, nodes, childIds, 0)) {
            if (mgRebaseContainerByAnchor(node, [], anchorX, anchorY)) rebased++;
            node.w = (vectorSlot.w || 0) * scale;
            node.h = (vectorSlot.h || 0) * scale;
          } else {
            const vectorClone = children.find(child => child.templateNode === vectorSlot.id ||
              child.id.slice(child.id.lastIndexOf("/") + 1) === vectorSlot.id);
            const currentX = vectorClone ? vectorClone.x || 0 : anchorX;
            const currentY = vectorClone ? vectorClone.y || 0 : anchorY;
            if (mgRebaseContainerByAnchor(node, children, currentX, currentY)) rebased++;
          }
        }
      }
      return rebased;
    }

    function mgRebaseSynthesizedExcludedUnions(nodes, childIds) {
      let rebased = 0;
      for (const id of Object.keys(nodes)) {
        const node = nodes[id];
        const slot = node && node.templateNode ? nodes[node.templateNode] : null;
        if (!node || !node.isSynthesizedInstanceChild || !slot ||
            !slot.containerMeta || slot.containerMeta.subtype !== "BOOLEAN_OPERATION" ||
            slot.containerMeta.booleanOperation !== "UNION" || slot.strokeWeightExplicit) continue;
        const sides = slot.trailer && slot.trailer.sideWeights;
        if (!Array.isArray(sides) || sides.length !== 4 || sides.some(value => Math.abs(value - 1) >= 0.015)) continue;
        const slotParent = nodes[slot.parent];
        if (!slotParent || !slotParent.containerMeta || slotParent.containerMeta.subtype !== "COMPONENT") continue;
        const slotChildren = (childIds[slot.id] || []).map(childId => nodes[childId]).filter(Boolean);
        if (slotChildren.length !== 2) continue;
        const vectorSlot = slotChildren.find(child => mgBooleanChildKind(child) === "VECTOR");
        const excludedSlots = slotChildren.filter(child => child.containerMeta &&
          child.containerMeta.subtype === "BOOLEAN_OPERATION" &&
          child.containerMeta.booleanOperation === "EXCLUDE");
        const cloneChildren = (childIds[id] || []).map(childId => nodes[childId]).filter(Boolean);
        const scale = Math.abs(node.effScale || 1);
        if (!vectorSlot && excludedSlots.length === 2 && cloneChildren.length === 2) {
          // This native UNION keeps its template origin while its size and
          // descendants are scaled. Rebase by the unscaled-vs-scaled origin
          // delta so absolute descendant positions remain unchanged.
          if (mgRebaseContainerByAnchor(
            node,
            cloneChildren,
            (slot.x || 0) * (1 - scale),
            (slot.y || 0) * (1 - scale)
          )) rebased++;
          continue;
        }
        const excludedSlot = excludedSlots[0];
        if (!vectorSlot || !excludedSlot) continue;
        const excludedClone = cloneChildren.find(child => child.templateNode === excludedSlot.id ||
          child.id.slice(child.id.lastIndexOf("/") + 1) === excludedSlot.id);
        if (!excludedClone) continue;
        if (mgRebaseContainerByAnchor(
          node,
          [excludedClone],
          (vectorSlot.x || 0) * scale,
          (vectorSlot.y || 0) * scale
        )) rebased++;
      }
      return rebased;
    }

    function mgResolveInstanceVisibility(ownVisibleByte, overrideMask19, slotVisibleByte, isRawRecord) {
      if (ownVisibleByte !== undefined) return ownVisibleByte;
      // Share-export shallow records default to visible when the 0x04 mask
      // bit is set or the mask is absent. 0711-3 full-export stubs carry no
      // mask at all; they inherit the template child's visibility (27 hidden
      // template children were resurrected by the old always-visible rule).
      const shallowVisibleDefault = isRawRecord &&
        (overrideMask19 !== undefined ? (overrideMask19 & 0x04) !== 0 : mgShareModeActive);
      if (shallowVisibleDefault) return 1;
      return slotVisibleByte;
    }

    function mgShouldInheritStroke(strokeRef, overrideMask19, isRawRecord) {
      if (strokeRef) return false;
      return !(isRawRecord && overrideMask19 !== undefined && (overrideMask19 & 0x20000) !== 0);
    }

    function mgResolveBooleanLeafSize(own, natural, scale, overrideMask19) {
      const close = (a, b) => Math.abs(a - b) <= Math.max(0.015, Math.abs(b) * 1e-4);
      if (overrideMask19 !== undefined && (overrideMask19 & 0x10000) !== 0) return natural * scale;
      if (close(own, natural)) return own * scale;
      return own;
    }

    function mgApplyBooleanLeafNaturalLayout(node, slot, nodes, childIds, scale) {
      const close = (a, b) => Math.abs(a - b) <= Math.max(0.015, Math.abs(b) * 1e-4);
      if (!node || !slot || !slot.containerMeta || slot.containerMeta.subtype !== "BOOLEAN_OPERATION" ||
          !close(node.w || 0, (slot.w || 0) * scale) ||
          !close(node.h || 0, (slot.h || 0) * scale)) return false;
      const children = (childIds[slot.id] || []).map(id => nodes[id]).filter(Boolean);
      let bounds = null;

      const parent = nodes[slot.parent];
      if (slot.containerMeta.booleanOperation === "SUBTRACT" && parent &&
          parent.containerMeta && parent.containerMeta.subtype === "BOOLEAN_OPERATION" &&
          (childIds[parent.id] || []).length === 1 && children.length === 2) {
        const minX = Math.min(...children.map(child => child.x || 0));
        const minY = Math.min(...children.map(child => child.y || 0));
        const maxX = Math.max(...children.map(child => (child.x || 0) + (child.w || 0)));
        const maxY = Math.max(...children.map(child => (child.y || 0) + (child.h || 0)));
        bounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
      } else if (slot.containerMeta.booleanOperation === "UNION" && children.length === 2) {
        const vector = children.find(child => mgBooleanChildKind(child) === "VECTOR");
        const excluded = children.find(child => child.containerMeta &&
          child.containerMeta.subtype === "BOOLEAN_OPERATION" &&
          child.containerMeta.booleanOperation === "EXCLUDE");
        if (vector && excluded) bounds = { x: vector.x || 0, y: vector.y || 0, w: vector.w || 0, h: vector.h || 0 };
      }
      if (!bounds) return false;

      node.x = (node.x || 0) + bounds.x * scale;
      node.y = (node.y || 0) + bounds.y * scale;
      node.w = bounds.w * scale;
      node.h = bounds.h * scale;
      if (node.relativeTransform) {
        node.relativeTransform[0][2] = node.x;
        node.relativeTransform[1][2] = node.y;
      }
      return true;
    }

    // Expand every INSTANCE node (template ref via tag 1a) by walking its
    // component subtree; shallow override records that already exist keep their
    // own geometry, synthesized ones are constraint-scaled. Nested instances
    // re-queue with the accumulated path.
    // Attach each full-export stub to its override MIRROR record, independent
    // of template expansion (the referenced component may not even be present
    // in the file — 0712-2's nav-row component 0:761 was never copied in; the
    // mirror tree under the slot is the only template-side data). Stub ids
    // flatten intermediate non-instance containers, so mirrors are resolved
    // per path segment against the TRANSITIVE mirror set of the current scope
    // (slot or parent mirror), keyed by the mirrored template id.
    function mgAttachOverrideMirrors(nodes) {
      if (mgShareModeActive) return;
      const byParent = {};
      for (const id of Object.keys(nodes)) {
        const n = nodes[id];
        if (!n || !n.templateRef || id.indexOf("/") >= 0 || n.parent == null) continue;
        (byParent[n.parent] = byParent[n.parent] || []).push(n);
      }
      const flatCache = {};
      function flatten(scopeId) {
        if (flatCache[scopeId]) return flatCache[scopeId];
        const flat = {};
        const stack = [scopeId];
        let guard = 0;
        while (stack.length && guard++ < 4096) {
          const pid = stack.pop();
          for (const m of byParent[pid] || []) {
            if (flat[m.templateRef] === undefined) flat[m.templateRef] = m;
            stack.push(m.id);
          }
        }
        flatCache[scopeId] = flat;
        return flat;
      }
      // Resolve a stub path against the transitive mirror scopes starting at
      // `segs[anchor]`. A mirror's templateRef points at the SLOT for plain
      // children but at the slot's COMPONENT for nested-instance slots
      // (0712-2 icon mirrors carry tpl 0:795, the right-turn component, not
      // the slot 0:59042) — try both keys per segment.
      function resolvePath(segs, anchor) {
        let scope = segs[anchor];
        let mirror = null;
        for (let i = anchor + 1; i < segs.length; i++) {
          const flat = flatten(scope);
          const seg = segs[i];
          const segNode = nodes[seg];
          const m = flat[seg] || (segNode && segNode.templateRef ? flat[segNode.templateRef] : null);
          if (!m) return null;
          mirror = m;
          scope = m.id;
        }
        return mirror;
      }
      for (const id of Object.keys(nodes)) {
        const n = nodes[id];
        if (!n || !n.isRawRecord || n.mirrorNode || id.indexOf("/") < 0) continue;
        const segs = id.split("/");
        if (segs.length < 3) continue; // direct instance children have no mirror layer
        const mirror = resolvePath(segs, 1);
        if (mirror) n.mirrorNode = mirror.id;
      }
    }

    // Instance-child layers NEVER own their layer name or base box: both
    // follow the main component's child (MasterGo, like Figma, forbids
    // renaming inside instances; the API reports the component child's name
    // and base geometry even when characters are overridden). Sync bare-id
    // MIRROR records (on-canvas instance children) to their templateRef
    // target AFTER auto-naming settles the component-side names — 0712-2:
    // mirror chars "Highway 400" keeps, but name/w/h come from the component
    // text "Exit 87" (48 name + 71 size rows).
    function mgSyncMirrorIdentity(nodes) {
      if (mgShareModeActive) return;
      for (const id of Object.keys(nodes)) {
        const n = nodes[id];
        if (!n || !n.isRawRecord) continue;
        // On-canvas mirror records (bare id, parent is an instance/mirror):
        // name follows the templateRef target. Instance-child STUBS (slash
        // id): name follows the path-segment slot. Sizes are NOT synced —
        // hug boxes are live text metrics with no package-side truth.
        let tgt = null;
        if (id.indexOf("/") >= 0) {
          const lastSeg = id.slice(id.lastIndexOf("/") + 1);
          tgt = lastSeg !== id ? nodes[lastSeg] : null;
        } else if (n.templateRef && n.parent != null) {
          const parent = nodes[n.parent];
          const parentIsInstanceLike = parent &&
            ((parent.containerMeta && parent.containerMeta.subtype === "INSTANCE") || !!parent.templateRef);
          if (parentIsInstanceLike) tgt = nodes[n.templateRef];
        }
        if (tgt && tgt !== n && tgt.name != null) n.name = tgt.name;
      }
    }

    function mgExpandTemplateInstances(nodes, childIds) {
      // Full exports mirror nested-instance overrides as BARE-id record trees
      // under the instance's template slot: mirror.parent = the slot (or the
      // parent mirror), mirror.templateRef = the mirrored component child
      // (0712-2: nav row slot 0:58430 carries mirrors 0:58431… for component
      // 0:761's children 0:59022…). Index them once; share exports keep the
      // slash-composed override-record convention instead.
      const bareOverrideByParent = {};
      if (!mgShareModeActive) {
        for (const id of Object.keys(nodes)) {
          const n = nodes[id];
          if (!n || !n.templateRef || id.indexOf("/") >= 0 || n.parent == null) continue;
          (bareOverrideByParent[n.parent] = bareOverrideByParent[n.parent] || {})[n.templateRef] = n;
        }
      }
      const queue = [];
      for (const id of Object.keys(nodes)) {
        const n = nodes[id];
        if (n && n.templateRef && n.containerMeta && n.containerMeta.subtype === "INSTANCE" && nodes[n.templateRef]) {
          queue.push({ instId: id, tplSide: id });
        }
      }
      let added = 0;
      const expanded = {};
      while (queue.length) {
        const job = queue.shift();
        const instId = job.instId;
        if (expanded[instId] || instId.split("/").length > 8) continue;
        expanded[instId] = true;
        const inst = nodes[instId];
        // Fully-MATERIALIZED instances (editor-original full exports, Tesla
        // Page 1) carry their real canvas children as TYPED bare-id record
        // trees — and the 0712-2 baseline proves those bare ids ARE the API
        // child ids (component-inner dragme emits `0:77 Union`, not a slash
        // stub). Expanding such an instance would double every subtree; its
        // raw children are complete records, so no stubs are needed. Sparse
        // TYPELESS bare children (override mirrors) don't count — those
        // instances still expand and the mirrors feed the stubs data.
        if (!mgShareModeActive) {
          const rawKids = childIds[instId];
          let hasTypedRawChild = false;
          if (rawKids) {
            for (const cid of rawKids) {
              if (cid.indexOf("/") < 0 && nodes[cid] && nodes[cid].type) { hasTypedRawChild = true; break; }
            }
          }
          if (hasTypedRawChild) continue;
        }
        let comp = nodes[inst.templateRef || inst.templateNode];
        // A nested-instance STUB's tag 1a points at its template SLOT, not at
        // the component; hop through the slot so the walk descends the real
        // component subtree (the slot's own childIds hold override mirrors,
        // not template children). The slot doubles as the mirror-tree root.
        // The component's OWN record can be absent from the file (0712-2: nav
        // row's 0:761 was never copied into the document) while its subtree
        // records survive as an orphan tree — walk it through a virtual root
        // whose geometry comes from the slot (= the component's natural size).
        let jobSlotId = job.slotId || null;
        let virtualComp = null;
        if (!mgShareModeActive && comp && comp.containerMeta &&
            comp.containerMeta.subtype === "INSTANCE" && comp.templateRef) {
          // Deep override chains hang off the parent MIRROR record, not off
          // the template slot — keep a mirror id passed by the parent job and
          // only fall back to the slot itself.
          if (!jobSlotId) jobSlotId = comp.id;
          const realComp = nodes[comp.templateRef];
          if (realComp) {
            comp = realComp;
          } else if ((childIds[comp.templateRef] || []).length > 0) {
            virtualComp = { id: comp.templateRef, w: comp.w, h: comp.h, virtual: true };
            comp = virtualComp;
          } else {
            comp = null;
          }
        }
        if (!comp) continue;
        // instance scale factor (trailer tag 26) applies to every size-like
        // scalar in the subtree: stroke weights, corners, font sizes, vector
        // geometry. The stored value is ABSOLUTE (already accumulated across
        // nesting); an instance record without one is unscaled. A SYNTHESIZED
        // nested instance only borrows its template's trailer, whose factor is
        // the ambient scale inside the COMPONENT — its real ambient is the one
        // the parent walk already handed down.
        inst.effScale = (!inst.isSynthesizedInstanceChild && inst.trailer && inst.trailer.scaleFactor) ||
          inst.effScale || 1;
        // walk the template subtree breadth-first; parents are processed before
        // children so the parent's actual size is known for constraint scaling.
        // tplPath tracks the template-side path: component trees carry their
        // own nested-instance override records (e.g. `2:0748/2:0018`), which
        // take precedence over the raw template child as the clone source.
        const walk = [{ tplId: comp.id, cloneId: instId, tplPath: job.tplSide, ovId: jobSlotId, tplNodeOverride: virtualComp }];
        while (walk.length) {
          const cur = walk.shift();
          const tplNode = cur.tplNodeOverride || nodes[cur.tplId];
          const cloneNode = nodes[cur.cloneId];
          if (!tplNode || !cloneNode) continue;
          const tplChildren = (childIds[cur.tplId] || []);
          for (const childTplId of tplChildren) {
            let t = nodes[childTplId];
            if (!t) continue;
            const lastSegId = childTplId.indexOf("/") >= 0 ? childTplId.slice(childTplId.lastIndexOf("/") + 1) : childTplId;
            const overrideKey = cur.tplPath + "/" + lastSegId;
            if (overrideKey !== childTplId && nodes[overrideKey]) t = nodes[overrideKey];
            // Full-export bare override mirror: the record whose parent is the
            // current mirror (or the job's slot) and whose templateRef is this
            // template child overrides it, exactly like the share overrideKey.
            let bareOv = null;
            if (cur.ovId && bareOverrideByParent[cur.ovId]) {
              const ovTable = bareOverrideByParent[cur.ovId];
              const tplTarget = nodes[childTplId] && nodes[childTplId].templateRef;
              bareOv = ovTable[childTplId] || (tplTarget ? ovTable[tplTarget] : null) || null;
              if (bareOv) t = bareOv;
            }
            const cloneId = instId + "/" + lastSegId;
            let child = nodes[cloneId];
            // A real override record carries its OWN trailer, so its tag-26 is
            // this clone's ambient scale. A synthesized clone copies every key
            // off the template — including the template's trailer, whose factor
            // is the ambient scale INSIDE the component. Letting that win over
            // the instance's own scale scaled 核心功能 2's whole subtree by the
            // component's 1.111 instead of the page's 0.539.
            const ownRecord = !!child;
            if (!child) {
              child = mgSynthesizeInstanceChild(t, nodes[childTplId], cloneId, cur.cloneId, tplNode, cloneNode, inst.effScale);
              if (t.textStyleRef) child.textStyleInherited = true;
              nodes[cloneId] = child;
              added++;
            } else {
              // shallow override record: fill template-inherited gaps
              child.templateNode = childTplId;
              if (child.parent == null || child.parent === child.owner) child.parent = cur.cloneId;
            }
            // Remember the override MIRROR so inheritance passes THROUGH it:
            // raw stubs inherit stub → mirror → component child (the mirror
            // holds the per-instance overrides: opacity 0.4, hidden, recolor,
            // explicit-zero paddings — 0712-2 nav rows).
            if (bareOv) child.mirrorNode = bareOv.id;
            child.effScale = (ownRecord && child.trailer && child.trailer.scaleFactor) || inst.effScale;
            // Nested-instance decision must consult the TEMPLATE child too: a
            // raw stub for a nested instance carries only a bare `0f` container
            // (subtype FRAME), and walking it would descend into the slot's
            // override MIRRORS as if they were template children (0712-2: the
            // resized "directions" emitted 288 bogus `8:04694/0:584xx` clones).
            const tplChild = nodes[childTplId];
            const tplChildIsInstance = !mgShareModeActive && tplChild &&
              tplChild.containerMeta && tplChild.containerMeta.subtype === "INSTANCE" &&
              !!tplChild.templateRef;
            if ((child.templateRef && nodes[child.templateRef] &&
                child.containerMeta && child.containerMeta.subtype === "INSTANCE") || tplChildIsInstance) {
              // Prefer the MIRROR record as the child job's override root:
              // deeper mirrors are parented under it, not under the template
              // slot (0712-2: left turn's opacity/fills overrides live in the
              // waypoints mirror's subtree).
              queue.push({
                instId: cloneId,
                tplSide: lastSegId,
                slotId: !mgShareModeActive ? (bareOv ? bareOv.id : childTplId) : undefined
              });
            } else {
              walk.push({
                tplId: childTplId,
                cloneId: cloneId,
                tplPath: overrideKey !== childTplId && nodes[overrideKey] ? overrideKey : childTplId,
                ovId: bareOv ? bareOv.id : null
              });
            }
          }
        }
      }
      return added;
    }

    // MasterGo text layers auto-rename after their content unless the scalar
    // 05 manual-name lock is set (1 = keep the 04 layer name). Runs BEFORE
    // inheritance on the record's OWN characters only — inherited characters
    // must not rename a mirror/override record whose lock lives on itself
    // (0712-2 "Exit 87" mirrors hold no own chars). The lock falls back to
    // the template slot for slash-id stubs.
    function mgApplyTextAutoNames(nodes) {
      if (mgShareModeActive) return;
      for (const id of Object.keys(nodes)) {
        const n = nodes[id];
        if (!n || n.rawType !== "TEXT" || n.characters == null) continue;
        let lock = n.nameLocked;
        if (lock === undefined && id.indexOf("/") >= 0) {
          const slot = nodes[id.slice(id.lastIndexOf("/") + 1)];
          if (slot) lock = slot.nameLocked;
        }
        if (lock !== 1) n.name = String(n.characters).replace(/\n/g, " ");
      }
    }

    // Fill the container-meta fields `own` OMITS from `tpl`. Omission on an
    // instance/instance-child record means "not overridden", so the template's
    // value wins — but anything the record spells out, INCLUDING EXPLICIT
    // ZEROS, must survive (the 0806 status bar writes padding/spacing 0 while
    // its library master omits them, i.e. "runtime default 10").
    function mgFillContainerMeta(own, tpl) {
      if (!own || !tpl) return own;
      if (own.clipsContent === undefined && tpl.clipsContent !== undefined) own.clipsContent = tpl.clipsContent;
      if (!own.layoutMode && tpl.layoutMode) own.layoutMode = tpl.layoutMode;
      if (!own.primaryAlign && tpl.primaryAlign) own.primaryAlign = tpl.primaryAlign;
      if (!own.counterAlign && tpl.counterAlign) own.counterAlign = tpl.counterAlign;
      // Stamp what was BORROWED. mgInheritFromTemplate fills the meta in place
      // long before mgNativeProps runs, so by then "own corners" and "corners
      // copied from the component" are indistinguishable — and they scale
      // differently (own = final, borrowed = × instance scale). Without these
      // stamps 核心功能 2 kept the component's raw 16/20/24 instead of the
      // page's 8.62/10.77/12.93.
      if (!own.corners && tpl.corners) { own.corners = tpl.corners; own.cornersInherited = true; }
      if (own.itemSpacingMissing && !tpl.itemSpacingMissing) {
        own.itemSpacing = tpl.itemSpacing;
        own.itemSpacingMissing = false;
        own.itemSpacingInherited = true;
      }
      if (own.paddingsMissing && !tpl.paddingsMissing) {
        own.paddings = tpl.paddings;
        own.paddingsMissing = false;
        own.paddingsInherited = true;
      }
      return own;
    }

    // Shallow instance records omit everything the component already defines
    // (name, paints, stroke fields, corner/layout meta). Fill those gaps from
    // the template chain (tag 1a, followed transitively; expansion-assigned
    // templateNode is the fallback for stubs that omit the 1a field — 0712-2's
    // resized nav rows).
    function mgInheritFromTemplate(nodes) {
      for (const id of Object.keys(nodes)) {
        const n = nodes[id];
        if (!n) continue;
        // Positional/slot fields (constraints, visibility) belong to the
        // template CHILD this record overrides — the last path segment — not
        // to the component the tag-1a chain leads to.
        const lastSeg = id.indexOf("/") >= 0 ? id.slice(id.lastIndexOf("/") + 1) : null;
        const slot = lastSeg && lastSeg !== id ? nodes[lastSeg] : null;
        // A slash id IS the template link: `24:706/24:665` overrides `24:665`.
        // Requiring an explicit tag-1a ref left the stubs of instances whose
        // master carries no 1a chain (external library status bar) with none
        // of the component's strokeAlign/constraints/layout values.
        if (!n.templateRef && !n.templateNode && !slot) continue;
        const mirror = n.mirrorNode ? nodes[n.mirrorNode] : null;
        if (slot && slot !== n) {
          if (n.constraintH === undefined && slot.constraintH !== undefined) n.constraintH = slot.constraintH;
          if (n.constraintV === undefined && slot.constraintV !== undefined) n.constraintV = slot.constraintV;
          n.visibleByte = mgResolveInstanceVisibility(
            n.visibleByte,
            n.overrideMask19,
            // The mirror's visibility beats the template child's default; a
            // mirror WITHOUT the 07 byte means visible (full records omit the
            // default) — 0712-2 icon cross-tab: explicit `07 00` = hidden
            // 18/18, omitted = visible 6/6.
            mirror ? (mirror.visibleByte !== undefined ? mirror.visibleByte : 1) : slot.visibleByte,
            n.isRawRecord
          );
          // Translation inheritance is only evidenced for shallow FRAME
          // records whose slot is a Boolean operation. Those records decode
          // provisionally as GROUP with mask 0x80; omitted axes are sparse
          // slot values. Other shallow VECTOR/TEXT records use omission as an
          // explicit zero, so inheriting their slot translation is incorrect.
          const inheritsSlotTranslation = n.isRawRecord &&
            n.rawType === "FRAME" &&
            n.overrideMask19 === 0x80 &&
            n.containerMeta && n.containerMeta.subtype === "GROUP" &&
            slot.containerMeta && slot.containerMeta.subtype === "BOOLEAN_OPERATION";
          if (inheritsSlotTranslation) {
            const scale = Math.abs(n.effScale || 1);
            if (!n.hasExplicitX) n.x = (slot.x || 0) * scale;
            if (!n.hasExplicitY) n.y = (slot.y || 0) * scale;
            if (n.relativeTransform) {
              if (!n.hasExplicitX) n.relativeTransform[0][2] = n.x;
              if (!n.hasExplicitY) n.relativeTransform[1][2] = n.y;
            }
          }
          // Full-export stubs omit non-overridden fields entirely: an absent
          // transform axis inherits the template child's position (0712-1
          // Keyboard: ENTER stub has no `18` field, baseline x/y = template's
          // 20/18). Share stubs keep the omission-is-zero doctrine above, and
          // so do boolean-leaf members (mask bit 0x4000) — their omitted axes
          // really are 0 in the flattened-leaf coordinate space (43+84 cover
          // vectors regressed when inherited).
          if (!mgShareModeActive && n.isRawRecord &&
              (n.overrideMask19 === undefined || (n.overrideMask19 & 0x4000) === 0)) {
            const fullScale = Math.abs(n.effScale || 1);
            if (!n.hasExplicitX) {
              n.x = (slot.x || 0) * fullScale;
              if (n.relativeTransform) n.relativeTransform[0][2] = n.x;
            }
            if (!n.hasExplicitY) {
              n.y = (slot.y || 0) * fullScale;
              if (n.relativeTransform) n.relativeTransform[1][2] = n.y;
            }
            // Explicit stub strokeWeight is a FILLER unless the stroke
            // override bit (0x40000) is set in the 19-mask — cross-tabbed on
            // both full-export fixtures with zero violations (0712-1: 8 stubs
            // `10 00` + no bit, baseline = template's default 1; 0711-3: 49
            // stubs with the bit, baseline = own, incl. the album rects'
            // genuine 0).
            if (n.strokeWeightExplicit && !n.strokeWeightInherited &&
                (n.overrideMask19 === undefined || (n.overrideMask19 & 0x40000) === 0)) {
              n.strokeWeight = slot.strokeWeightExplicit ? slot.strokeWeight : 1;
              n.strokeWeightInherited = true;
            }
          }
          if (!n.tplW && slot.w) { n.tplW = slot.w; n.tplH = slot.h; }
          if (!n.hasExplicitMatrix && slot.relativeTransform) {
            const own = n.relativeTransform;
            n.relativeTransform = [
              [slot.relativeTransform[0][0], slot.relativeTransform[0][1], own ? own[0][2] : n.x || 0],
              [slot.relativeTransform[1][0], slot.relativeTransform[1][1], own ? own[1][2] : n.y || 0]
            ];
            n.rotation = mgNormalizeRotation(mgRotationFromMatrix(n.relativeTransform[0][0], n.relativeTransform[1][0]));
          }
          // A shallow boolean override omits the operation kind (`01 00` with
          // no `02`), decoding as GROUP; the slot record has the real subtype.
          if (n.containerMeta && n.containerMeta.subtype === "GROUP" &&
              slot.containerMeta && slot.containerMeta.subtype === "BOOLEAN_OPERATION") {
            n.containerMeta = slot.containerMeta;
          }
          // 0711-3 full exports store instance-child containers as bare stubs
          // (`1c 07 0f 00 00`, no structural fields at all): the container
          // KIND is positional and lives on the template child. Without this
          // the stubs all present as FRAME (144 GROUP + 135 BOOLEAN type
          // mismatches on the cover fixture).
          if (n.containerMeta && n.containerMeta.bareStub && slot.containerMeta &&
              (slot.containerMeta.subtype === "GROUP" || slot.containerMeta.subtype === "BOOLEAN_OPERATION" ||
               slot.containerMeta.subtype === "INSTANCE")) {
            n.containerMeta = slot.containerMeta;
          }
          // A bare stub with an override MIRROR takes the mirror's container
          // meta wholesale (explicit-zero paddings/itemSpacing, clips) — the
          // mirror is the per-instance truth (0712-2 "battery level").
          if (n.containerMeta && n.containerMeta.bareStub && mirror && mirror.containerMeta &&
              !mirror.containerMeta.bareStub) {
            n.containerMeta = mirror.containerMeta;
          }
        }
        // 0711-3 full exports: instance-child container stubs store their size
        // in TEMPLATE units when the user overrode it (route: own 307, tpl
        // 297, baseline 307×scale), but an UNMODIFIED size is written as the
        // final scaled copy (pagination: own 487.56 == tpl 580 × 0.8406 ==
        // baseline). So scale only values that do NOT already equal
        // template×scale (268/276 cross-tab; the misfits are live-text hug
        // frames). Share-export stubs store final sizes (2026-07 doctrine);
        // leaf stubs (VECTOR/TEXT) are final in both forms; instance roots are
        // always final.
        if (!mgShareModeActive && n.isRawRecord && n.containerMeta &&
            n.containerMeta.subtype !== "INSTANCE" &&
            n.trailer && isFinite(n.trailer.scaleFactor) && n.trailer.scaleFactor > 0 &&
            Math.abs(n.trailer.scaleFactor - 1) > 1e-9) {
          const s = n.trailer.scaleFactor;
          const tpl = nodes[n.templateRef];
          const tol = v => Math.max(0.02, Math.abs(v) * 1e-4);
          const wIsFinalCopy = tpl && isFinite(tpl.w) && Math.abs(n.w - tpl.w * s) < tol(tpl.w * s);
          const hIsFinalCopy = tpl && isFinite(tpl.h) && Math.abs(n.h - tpl.h * s) < tol(tpl.h * s);
          if (n.hasExplicitW && isFinite(n.w) && !wIsFinalCopy) n.w *= s;
          if (n.hasExplicitH && isFinite(n.h) && !hIsFinalCopy) n.h *= s;
        }
        // TEXT naming is finalized by mgApplyTextAutoNames (scalar 05 = the
        // manual-name lock) after inheritance fills characters.
        // Inheritance passes THROUGH the override mirror when one exists:
        // stub → mirror → component child (mirror.templateRef continues the
        // chain to the mirrored template node). When the 1a target (the
        // component) is absent from the file, fall back to the PATH-SEGMENT
        // slot node — 0712-2 copies component subtrees without their roots
        // (left turn's 0:773 missing, slot 0:59031 present with the
        // instance-root invisible-white fill, opacity 0.4, clips…).
        let t = (mirror || null) || nodes[n.templateRef || n.templateNode] || slot;
        if (!t && n.templateNode) t = nodes[n.templateNode];
        let guard = 0;
        while (t && guard++ < 6) {
          if (n.name == null && t.name != null) {
            // An unnamed instance of a VARIANT is named after the component
            // SET, not the variant slot ("标签栏", not "属性 1[a5]=首页").
            const tplSet = n.containerMeta && n.containerMeta.subtype === "INSTANCE" &&
              t.containerMeta && t.containerMeta.subtype === "COMPONENT" ? nodes[t.parent] : null;
            n.name = (tplSet && tplSet.name && tplSet.containerMeta &&
              tplSet.containerMeta.subtype === "COMPONENT_SET") ? tplSet.name : t.name;
          }
          if (!n.paintRef && t.paintRef) n.paintRef = t.paintRef;
          if (mgShouldInheritStroke(n.strokeRef, n.overrideMask19, n.isRawRecord) && t.strokeRef) {
            n.strokeRef = t.strokeRef;
          }
          if (!n.cornerRef && t.cornerRef) n.cornerRef = t.cornerRef;
          if (!n.strokeWeightExplicit && t.strokeWeightExplicit) {
            n.strokeWeight = t.strokeWeight;
            n.strokeWeightExplicit = true;
            n.strokeWeightInherited = true;
          }
          // Explicit `10 00` is a FILLER on template-linked BARE records too,
          // unless the 0x40000 stroke-override bit is set (0712-3 Secondary
          // Button variants: `10 00` + 1a ref to the default variant, mask
          // 0x80 — baseline strokeWeight is the chain default 1).
          if (!mgShareModeActive && n.isRawRecord &&
              n.strokeWeightExplicit && !n.strokeWeightInherited && n.strokeWeight === 0 &&
              (n.overrideMask19 === undefined || (n.overrideMask19 & 0x40000) === 0)) {
            n.strokeWeight = t.strokeWeightExplicit ? t.strokeWeight : 1;
            n.strokeWeightInherited = true;
          }
          // 0711-3: a stub with explicit strokeWeight 0 whose template leaves
          // the field missing (= default 1) still reports per-side weights of
          // 1 × scale in the baseline (48 album-cover rects). Remember the
          // template's effective weight for the side-weight fallback.
          if (!mgShareModeActive && n.isRawRecord && n.tplSideWeightBase === undefined &&
              n.strokeWeightExplicit && !n.strokeWeightInherited && n.strokeWeight === 0 &&
              !t.strokeWeightExplicit) {
            n.tplSideWeightBase = 1;
          }
          if (n.strokeAlignByte === undefined && t.strokeAlignByte !== undefined) n.strokeAlignByte = t.strokeAlignByte;
          if (n.strokeJoinByte === undefined && t.strokeJoinByte !== undefined) n.strokeJoinByte = t.strokeJoinByte;
          // Constraints and visibility are positional slot fields. A missing
          // slot value means the native default, not a component-root value.
          if (n.strokeCapByte === undefined && t.strokeCapByte !== undefined) n.strokeCapByte = t.strokeCapByte;
          if (!n.isMask && t.isMask) n.isMask = t.isMask;
          if (n.opacity === undefined && t.opacity !== undefined) n.opacity = t.opacity;
          if (!n.tplW && (t.tplW || t.w)) { n.tplW = t.tplW || t.w; n.tplH = t.tplH || t.h; }
          if (!n.dashPattern && t.dashPattern) n.dashPattern = t.dashPattern;
          if (n.blendModeByte === undefined && t.blendModeByte !== undefined) n.blendModeByte = t.blendModeByte;
          if (!n.geomHash && t.geomHash) n.geomHash = t.geomHash;
          if (!n.arcData && t.arcData) n.arcData = t.arcData;
          if (n.textAutoResize == null && t.textAutoResize != null) n.textAutoResize = t.textAutoResize;
          if (n.characters == null && t.characters != null) n.characters = t.characters;
          if (!n.fontName && t.fontName) n.fontName = t.fontName;
          if (n.textAlignH == null && t.textAlignH != null) n.textAlignH = t.textAlignH;
          if (n.textAlignV == null && t.textAlignV != null) n.textAlignV = t.textAlignV;
          if (!n.textStyleRef && t.textStyleRef) {
            // A template's style entry stores TEMPLATE values; the instance
            // scale still applies (own entries are final).
            n.textStyleRef = t.textStyleRef;
            n.textStyleInherited = true;
          }
          if (n.cornerRadius === 0 && t.cornerRadius) { n.cornerRadius = t.cornerRadius; n.cornerRadiusInherited = true; }
          if (!n.inheritedMeta && t.containerMeta &&
              (t.containerMeta.subtype === "COMPONENT" || t.containerMeta.subtype === "FRAME")) {
            n.inheritedMeta = t.containerMeta;
          }
          if (!n.inheritedTrailer && t.trailer) n.inheritedTrailer = t.trailer;
          // Container-meta fields an instance-child stub OMITS belong to the
          // template child — the stub spells out only what the instance
          // overrode (0806 tab bar: the stub carries its own itemSpacing 20 /
          // padding 24 but no layoutMode, align or clipsContent, and the
          // status-bar group stubs carry no padding at all, which the
          // full-export default-10 rule then invented).
          if (n.containerMeta && t.containerMeta && n.containerMeta !== t.containerMeta) {
            mgFillContainerMeta(n.containerMeta, t.containerMeta);
          }
          t = t.templateRef ? nodes[t.templateRef] : null;
        }
      }
    }

    function mgPruneInstanceBooleanLeaves(nodes, childIds) {
      let leafCount = 0;
      let prunedCount = 0;
      for (const id of Object.keys(nodes)) {
        const n = nodes[id];
        if (!mgIsInstanceBooleanLeafCandidate(n, nodes)) continue;
        const slotId = n.templateNode || id.slice(id.lastIndexOf("/") + 1);
        const slot = nodes[slotId];
        n.instanceBooleanLeaf = true;
        n.booleanLeafMaskConsistent = n.overrideMask19 === undefined || (n.overrideMask19 & 0x4000) !== 0;
        const scale = Math.abs(n.effScale || 1);
        if (!n.isSynthesizedInstanceChild && isFinite(scale) && scale > 0) {
          n.w = mgResolveBooleanLeafSize(n.w || 0, slot.w || 0, scale, n.overrideMask19);
          n.h = mgResolveBooleanLeafSize(n.h || 0, slot.h || 0, scale, n.overrideMask19);
        }
        mgApplyBooleanLeafNaturalLayout(n, slot, nodes, childIds, scale);
        const stack = (childIds[id] || []).slice();
        const seen = {};
        while (stack.length) {
          const childId = stack.pop();
          if (seen[childId]) continue;
          seen[childId] = true;
          prunedCount++;
          for (const kid of childIds[childId] || []) stack.push(kid);
        }
        childIds[id] = [];
        leafCount++;
      }
      return { leafCount: leafCount, prunedCount: prunedCount };
    }

    // The document header lists the real MasterGo pages as records shaped
    // `\x01 <id> \x00 \x02 <name> \x00 \x03`. Node records share that shape but
    // their `\x02` value is an id, so keep only records whose name is not an id.
    function parseMgPages(bytes, headerEnd) {
      const pages = [];
      const seen = {};
      // Node ids look like `2:1010` or slash-composed `2:1010/2:0162`; page ids
      // can additionally be short tokens like `M` (share/partial exports) or
      // colon-prefixed tokens like `:7384` (editor exports that embed external
      // library documents use colon tokens for page/canvas owners).
      const idRe = /^(?:[0-9]+:[0-9A-Za-z]+(?:\/[0-9]+:[0-9A-Za-z]+)*|[A-Za-z][0-9A-Za-z]{0,7}|:[0-9A-Za-z]{1,12})$/;
      const nodeIdRe = /^[0-9]+:[0-9A-Za-z]+(?:\/[0-9]+:[0-9A-Za-z]+)*$/;
      const limit = Math.min(headerEnd > 0 ? headerEnd : bytes.length, 200000);
      let p = 0;
      while (p < limit) {
        if (bytes[p] === 0x01) {
          let q = p + 1;
          while (q < limit && bytes[q] !== 0x00) q++;
          const id = decodeUtf8(bytes.subarray(p + 1, q));
          if (idRe.test(id) && bytes[q + 1] === 0x02) {
            let r = q + 2;
            while (r < limit && bytes[r] !== 0x00) r++;
            const name = decodeUtf8(bytes.subarray(q + 2, r));
            if (bytes[r + 1] === 0x03 && name) {
              // Page records (name is human text) form a contiguous run at the
              // very start. The first record whose `02` value is itself an id is a
              // node record — that marks the end of the page table, so stop there
              // to avoid picking up later component-property records.
              if (nodeIdRe.test(name)) break;
              // The `03` field is a fractional-index sort code (e.g. a4, a5P, a6)
              // that defines the page's display order.
              let c = r + 2;
              while (c < limit && bytes[c] !== 0x00) c++;
              const code = decodeUtf8(bytes.subarray(r + 2, c));
              // Optional `05 <a><r><g><b>` = page canvas color (zero-compressed
              // floats). The color is stored even for DEFAULT canvases (light
              // fixtures carry #F5F5F5, the Tesla file black); the one-byte
              // flag `06 01` among the fields that follow marks a USER-SET
              // background — only then does the import apply it (the 0711-3
              // cover stores black but is default; Page 1 stores black with
              // `06 01` and really is black).
              let background = null;
              if (bytes[c + 1] === 0x05) {
                let bp = c + 2;
                const channels = [];
                for (let i = 0; i < 4; i++) {
                  const zf = mgReadZeroFloat(bytes, bp);
                  channels.push(zf.value);
                  bp = zf.next;
                }
                let customized = false;
                while (bp + 1 < limit) {
                  const flagTag = bytes[bp];
                  if (flagTag < 0x06 || flagTag > 0x0c) break;
                  if (flagTag === 0x06 && bytes[bp + 1] === 0x01) customized = true;
                  bp += 2;
                }
                if (customized && channels.every(v => isFinite(v) && v >= 0 && v <= 1)) {
                  background = { a: channels[0], r: channels[1], g: channels[2], b: channels[3] };
                }
              }
              if (!seen[id]) { seen[id] = true; pages.push({ id: id, name: name, code: code, background: background }); }
              p = c + 1;
              continue;
            }
          }
        }
        p++;
      }
      // MasterGo orders pages by the `03` sort code, not by their physical position
      // in the header. Lexicographic order of that code = the display order.
      pages.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
      return pages;
    }

    function mgFallbackPageName(fileName) {
      const base = mgBasename(fileName || "mg-file").replace(/\.mg$/i, "");
      const us = base.lastIndexOf("_");
      return us >= 0 && us + 1 < base.length ? base.slice(us + 1) : base;
    }

    function mgIsFallbackRootNode(n) {
      if (!n || !n.type || n.parent != null) return false;
      return true;
    }

    // Keep exactly what the importer reads off instance-descendant records
    // (applyInstanceChildOverrides + a survivable frame-shell fallback):
    // type family, visibility, opacity, characters, fills/strokes (paint
    // override compare + IMAGE assetKey scan), boolean op, and a slim layout.
    // Dropped: vectorNetwork/vectorPaths (the whale), text runs, effects
    // details beyond blend, constraints/sizing, stroke geometry, arcData.
    // Keep-list for instance-descendant records. It MUST cover every field
    // `applyInstanceChildOverrides` (code.ts) reads — visible / opacity /
    // characters / fills / strokes / auto-layout spacing. Anything dropped here
    // reaches the override matcher as `undefined` and the override silently
    // never happens; the compare tool cannot catch it because CLI conversions
    // run unslimmed. See tools/tests/mgPackage.test.js.
    const MG_SLIM_LAYOUT_KEYS = [
      "x", "y", "width", "height", "relativeTransform", "rotation",
      "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom"
    ];

    function mgSlimInstanceDescendantProps(props) {
      if (!props) return props;
      const slim = {};
      if (props.type !== undefined) slim.type = props.type;
      if (props.sourceType !== undefined) slim.sourceType = props.sourceType;
      if (props.restoreType !== undefined) slim.restoreType = props.restoreType;
      if (props.name !== undefined) slim.name = props.name;
      if (props.characters !== undefined) slim.characters = props.characters;
      if (props.booleanOperation !== undefined) slim.booleanOperation = props.booleanOperation;
      if (props.shellPlaceholder !== undefined) slim.shellPlaceholder = props.shellPlaceholder;
      if (props.scence) slim.scence = props.scence;
      if (props.blend) slim.blend = props.blend;
      if (props.geometry) {
        slim.geometry = {};
        if (props.geometry.fills !== undefined) slim.geometry.fills = props.geometry.fills;
        if (props.geometry.strokes !== undefined) slim.geometry.strokes = props.geometry.strokes;
      }
      if (props.layout) {
        slim.layout = {};
        for (const key of MG_SLIM_LAYOUT_KEYS) {
          if (props.layout[key] !== undefined) slim.layout[key] = props.layout[key];
        }
      }
      return slim;
    }

    function convertMgPackageToV2Entries(zipEntries, fileName, options) {
      const documentBytes = getEntryByName(zipEntries, "document");
      if (!documentBytes) throw new Error(`"${fileName}" 不是有效的 .mg 文件（缺少 document）`);

      let meta = {};
      const metaBytes = getEntryByName(zipEntries, "meta.json");
      if (metaBytes) { try { meta = JSON.parse(decodeUtf8(metaBytes)); } catch (e) { /* ignore */ } }

      const { nodes, paints, geoms, fontStyles, effectTable } = mgDecodeNativeNodes(documentBytes);
      const styleDefs = mgScanStyleDefs(documentBytes, new TextDecoder("latin1").decode(documentBytes));
      const embeddedProps = mgExtractEmbeddedProps(documentBytes);
      const embeddedIndex = mgBuildEmbeddedIndex(embeddedProps);
      const embeddedOverlayUsed = {};
      let nodeIds = Object.keys(nodes);
      if (nodeIds.length === 0) throw new Error(`未能从 "${fileName}" 解析出任何图层`);

      // The real MasterGo pages come from the document header, in display order.
      // Partial native .mg exports can omit that header; when no pages are found,
      // the fallback below restores a single page from typed parent=null roots.
      const mgPages = parseMgPages(documentBytes, -1);

      // Child lists (parent → children) and per-parent index.
      let childIds = {};
      function sortNativeChildIds(ids) {
        ids.sort((a, b) => {
          const ac = nodes[a] && nodes[a].code ? nodes[a].code : "";
          const bc = nodes[b] && nodes[b].code ? nodes[b].code : "";
          if (ac !== bc) return ac < bc ? -1 : 1;
          return a < b ? -1 : a > b ? 1 : 0;
        });
      }
      function rebuildChildIds() {
        childIds = {};
        for (const id of nodeIds) childIds[id] = [];
        for (const id of nodeIds) {
          const p = nodes[id].parent;
          if (p != null) (childIds[p] = childIds[p] || []).push(id); // parent may be a page id
        }
        for (const p in childIds) sortNativeChildIds(childIds[p]);
      }
      rebuildChildIds();
      // Share-export template instances (tag 1a component refs) first; the
      // legacy name-based expansion only covers old-style fixtures.
      const expandedTemplateCount = mgExpandTemplateInstances(nodes, childIds);
      mgAttachOverrideMirrors(nodes);
      mgInheritFromTemplate(nodes);
      // Naming runs AFTER inheritance: override mirrors carry no own
      // characters — the name follows the INHERITED characters unless the
      // scalar-05 manual-name lock is set (0712-2 "Exit 87" mirrors).
      mgApplyTextAutoNames(nodes);
      // Mirror identities sync LAST: instance-child names/base boxes follow
      // the component child even when characters are overridden.
      mgSyncMirrorIdentity(nodes);
      if (expandedTemplateCount > 0) {
        nodeIds = Object.keys(nodes);
        rebuildChildIds();
      }
      const expandedInstanceCount = mgExpandInstanceLikeNodes(nodes, childIds);
      if (expandedInstanceCount > 0) {
        nodeIds = Object.keys(nodes);
        rebuildChildIds();
      }
      mgCenterSynthesizedBooleanShellFrames(nodes, childIds);
      mgCenterSynthesizedVectorUnions(nodes, childIds);
      mgRebaseSynthesizedGroups(nodes, childIds);
      mgRebaseShallowSingleVisibleGroups(nodes, childIds);
      mgRebaseQuarterStrokeBooleans(nodes, childIds);
      mgRebaseSynthesizedExcludedUnions(nodes, childIds);
      // A raw VECTOR overriding a Boolean template slot is already flattened.
      // Prune its template operands before computing page reachability/indexes.
      mgPruneInstanceBooleanLeaves(nodes, childIds);
      const isEmittedChild = (cid) => nodes[cid] && nodes[cid].type;
      // Number siblings over the same filtered child list the records emit
      // (typeless raw stubs are dropped there); numbering the raw list would
      // shift every sibling after a dropped stub and fail INDEX_MISMATCH.
      const indexInParent = {};
      for (const p in childIds) {
        let emittedIndex = 0;
        for (const cid of childIds[p]) {
          if (isEmittedChild(cid)) indexInParent[cid] = emittedIndex++;
        }
      }

      function subtreeOf(root) {
        const seen = {};
        const stack = [root];
        const list = [];
        while (stack.length) {
          const id = stack.pop();
          if (seen[id] || !nodes[id] || !nodes[id].type) continue;
          seen[id] = true;
          list.push(id);
          const kids = childIds[id] || [];
          for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]);
        }
        return list;
      }

      // A page's content = roots whose parent IS that page id. This naturally drops
      // off-canvas component-master subtrees (their roots are parented to a registry
      // id, not a page) and dedups duplicate copies (only one copy is parented to the
      // page).
      const reachable = {};
      const pageList = [];
      const rootIndexOverride = {};
      // Component/component-set masters live off-canvas: in share exports they
      // share the page owner, so drop them from the page roots explicitly.
      function isComponentMaster(id) {
        const n = nodes[id];
        const sub = n && n.containerMeta && n.containerMeta.subtype;
        return sub === "COMPONENT" || sub === "COMPONENT_SET";
      }
      for (const pg of mgPages) {
        // Off-canvas registry masters merely share the page owner and carry
        // no sort code — drop those from the page roots (share exports store
        // ALL masters that way; editor exports of a library file still hold a
        // few codeless foreign masters, e.g. pasted icons). Sort-CODED
        // masters legitimately sit ON the canvas and must stay — dropping
        // them lost all 20 of the Tesla fixture's components, and the 大文件
        // 0804 design system keeps every button/button-group master as a
        // coded canvas root.
        const roots = (childIds[pg.id] || []).filter(r => nodes[r] && nodes[r].type && !(isComponentMaster(r) && !nodes[r].code));
        roots.forEach((rootId, rootIndex) => { rootIndexOverride[rootId] = rootIndex; });
        let count = 0;
        for (const r of roots) for (const id of subtreeOf(r)) { if (!reachable[id]) { reachable[id] = true; count++; } }
        // Keep empty pages too: MasterGo files legitimately contain pages with
        // no layers (e.g. a leftover "Temp" page) and the v2 baseline exports them.
        if (count > 0 || roots.length === 0) pageList.push({ name: pg.name, roots: roots, count: count, background: pg.background || null });
      }

      if (Object.keys(reachable).length === 0) {
        const roots = nodeIds.filter(id => mgIsFallbackRootNode(nodes[id]));
        sortNativeChildIds(roots);
        let count = 0;
        roots.forEach((id, ix) => { rootIndexOverride[id] = ix; });
        for (const r of roots) for (const id of subtreeOf(r)) { if (!reachable[id]) { reachable[id] = true; count++; } }
        if (count > 0) pageList.push({ name: mgFallbackPageName(fileName), roots: roots, count: count });
      }
      if (Object.keys(reachable).length === 0) throw new Error(`"${fileName}" 中没有可识别的页面图层`);

      // NOTE on variant names: MasterGo spells them `Size[a2]=Large,Type[a0]=…`
      // and its OWN zip exporter keeps that raw form for 11 of 12 specimen
      // variants (only one came out normalized) — so the decoder emits the
      // raw names untouched to match the zip baseline. Normalizing here
      // traded 1 diff row for 11 (reverted 2026-07-12).
      // Layer records — reachable nodes only.
      const records = [];
      const nativeEmbeddedMatches = {};
      for (const id in reachable) {
        const n = nodes[id];
        const props = mgNativeProps(n, nodes, paints, geoms, fontStyles, effectTable);
        const preferredParentId = nativeEmbeddedMatches[n.parent] ? nativeEmbeddedMatches[n.parent].id : null;
        const overlay = mgFindEmbeddedOverlay(props, embeddedIndex, embeddedOverlayUsed, preferredParentId);
        if (overlay) nativeEmbeddedMatches[id] = overlay;
        mgApplyEmbeddedOverlay(props, overlay, !!preferredParentId);
        // Native-decoded blend fields win over stale embedded copies. The
        // blend-mode enum comes from scalar tag 0d; MasterGo reports
        // PASS_THROUGH for unset nodes (NORMAL only on sections/slices).
        if (props.blend) {
          props.blend.blendMode = (n.blendModeByte !== undefined && MG_BLEND_MODES[n.blendModeByte])
            ? MG_BLEND_MODES[n.blendModeByte]
            : ((props.type === "SECTION" || props.type === "SLICE") ? "NORMAL" : "PASS_THROUGH");
          props.blend.isMask = !!n.isMask;
          if (Array.isArray(props.blend.effects)) {
            props.blend.effects.forEach(e => {
              if (e && e.blendMode === "NORMAL") e.blendMode = "PASS_THROUGH";
            });
          }
        }
        if (props.sourceType === "INSTANCE") props.shellPlaceholder = true;
        // A VECTOR that still carries children at emission time is a Boolean
        // slot override whose operand subtree survived pruning (top-level raw
        // records have slash-less ids, so mgIsInstanceBooleanLeafCandidate
        // never saw them). Figma vectors cannot contain children — the import
        // would silently drop the whole subtree and fail the page count
        // check. These records carry no geometry or fills of their own (the
        // operands do), so restore them as a real Boolean combine instead.
        const emittedChildIds = (childIds[id] || []).filter(isEmittedChild);
        if (props.type === "VECTOR" && emittedChildIds.length > 0) {
          props.type = "BOOLEAN_OPERATION";
          props.sourceType = "BOOLEAN_OPERATION";
          props.restoreType = "BOOLEAN_OPERATION";
          if (!props.booleanOperation) {
            props.booleanOperation =
              (props.name.indexOf("Subtract") >= 0 || props.name.indexOf("减去") >= 0) ? "SUBTRACT" :
              (props.name.indexOf("Intersect") >= 0 || props.name.indexOf("交集") >= 0) ? "INTERSECT" :
              (props.name.indexOf("Exclude") >= 0 || props.name.indexOf("排除") >= 0) ? "EXCLUDE" : "UNION";
          }
          delete props.vectorNetwork;
          delete props.constraints;
        }
        delete props.__nativeContainerLayout;
        // MasterGo's plugin API washes the DEFAULT variant's stored name —
        // the .mg keeps `Size[a0]=Small,Type[a0]=Primary` while the v2
        // export says `Size=Small, Type=Primary`. Reproduce the wash so the
        // records match (and the 0712-3 "1 variant name washed" residual
        // closes): only when the component sits in a COMPONENT_SET and EVERY
        // key ends with [a0]; non-default variants pass through raw.
        let recordName = n.name || id;
        if (props.sourceType === "COMPONENT" && nodes[n.parent] && nodes[n.parent].containerMeta &&
            nodes[n.parent].containerMeta.subtype === "COMPONENT_SET") {
          const washed = mgWashDefaultVariantName(recordName);
          if (washed !== recordName) {
            recordName = washed;
            props.name = washed;
          }
        }
        const record = {
          version: 2,
          id: id,
          pageId: "",
          parentId: (nodes[n.parent] ? n.parent : null),
          index: rootIndexOverride[id] != null ? rootIndexOverride[id] : (indexInParent[id] || 0),
          name: recordName,
          childIds: (childIds[id] || []).filter(isEmittedChild),
          props: props
        };
        // Instance records remember their component (tag 1a template ref) so
        // the importer can re-link them via component.createInstance(). The
        // component's own record must exist in the package (full exports keep
        // masters on canvas; share exports drop them → no id, frame fallback).
        // MasterGo instances carry a uniform scale (trailer 26) that Figma
        // instances cannot express via child geometry (instance children are
        // locked to the component); the importer replays it with
        // InstanceNode.rescale().
        if (props.sourceType === "INSTANCE" && n.trailer && isFinite(n.trailer.scaleFactor) &&
            n.trailer.scaleFactor > 0 && Math.abs(n.trailer.scaleFactor - 1) > 1e-6) {
          record.instanceScale = n.trailer.scaleFactor;
        }
        if (props.sourceType === "INSTANCE" && n.templateRef && nodes[n.templateRef] &&
            reachable[n.templateRef] &&
            nodes[n.templateRef].containerMeta &&
            nodes[n.templateRef].containerMeta.subtype === "COMPONENT") {
          record.mainComponentId = n.templateRef;
        }
        // Library-style references (record-level, invisible to the comparator
        // like mainComponentId): the node's paint/effect refs and the text
        // run's style ref point straight at style DEFINITION records. Values
        // are already materialized into props; the importer re-binds them to
        // the restored Figma styles.
        // Off-canvas copy of a SHARED-LIBRARY component master (container
        // field `07 03 <libraryFileId+nodeId>`). MasterGo's own page traversal
        // never yields it, so it must not survive on the Figma canvas — but
        // instances still need it to exist while they re-link, so it is
        // restored normally and removed in the import's cleanup phase.
        if (n.containerMeta && n.containerMeta.libraryKey) record.libraryMaster = true;
        if (n.paintRef && styleDefs[n.paintRef]) record.fillStyleRef = n.paintRef;
        if (n.strokeRef && styleDefs[n.strokeRef]) record.strokeStyleRef = n.strokeRef;
        if (n.cornerRef && styleDefs[n.cornerRef]) record.effectStyleRef = n.cornerRef;
        if (n.textStyleRef && styleDefs[n.textStyleRef]) record.textStyleRef = n.textStyleRef;
        records.push(record);
      }
      // layoutPositioning now comes from the real per-node trailer flag
      // (`2e 01`, decoded in mgParseTrailer/mgNativeProps). The old
      // group-child-under-auto-layout heuristic that lived here mis-marked
      // plain group children as ABSOLUTE (统一集 02_02: v2 says AUTO) while
      // missing genuinely absolute children (03_01 按钮背景).
      // Plugin-runtime option: strip instance-DESCENDANT records down to the
      // fields the importer actually reads from them (positional override
      // matching: visible/opacity/characters/fills/strokes) plus a minimal
      // fallback skeleton. These records are never restored as nodes — the
      // instance children come from component.createInstance() — but on huge
      // full exports they are nearly all of the output (Tesla 0711-3: 219k of
      // 221k records, 455MB of 458MB JSON) and OOM-crash the Figma tab. Only
      // descendants of records that DO carry mainComponentId are slimmed, so
      // share-export instances (no reachable master → frame-shell restore
      // from these very records) keep full fidelity. The compare tool and
      // pythonParser call without options and keep byte-identical output.
      if (options && options.slimInstanceDescendants) {
        const recordById = {};
        for (const record of records) recordById[record.id] = record;
        const slimIds = {};
        for (const record of records) {
          if (!record.mainComponentId) continue;
          const stack = (record.childIds || []).slice();
          while (stack.length) {
            const cid = stack.pop();
            if (slimIds[cid]) continue;
            const child = recordById[cid];
            if (!child) continue;
            slimIds[cid] = true;
            for (const gid of child.childIds || []) stack.push(gid);
          }
        }
        let slimmedCount = 0;
        for (const record of records) {
          if (!slimIds[record.id]) continue;
          record.props = mgSlimInstanceDescendantProps(record.props);
          slimmedCount++;
        }
        if (slimmedCount > 0 && typeof console !== "undefined") {
          console.info("[mg] slimInstanceDescendants:", slimmedCount, "/", records.length, "records");
        }
      }
      const encoder = new TextEncoder();
      const out = {};
      const recordsById = {};
      for (const record of records) recordsById[record.id] = record;

      // The v2 exporter names image assets image-001, image-002, … in first-use
      // order; alias the decoder's hash-based refs the same way so packages
      // match byte-for-byte. The hash file stays the backing asset.
      const imageAliasByRef = {};
      function aliasPaintImages(paints) {
        if (!Array.isArray(paints)) return;
        for (const paint of paints) {
          if (!paint || paint.type !== "IMAGE" || !paint.imageRef) continue;
          if (imageAliasByRef[paint.imageRef] === undefined) {
            const alias = "image-" + String(Object.keys(imageAliasByRef).length + 1).padStart(3, "0");
            imageAliasByRef[paint.imageRef] = alias;
          }
          paint.imageRef = imageAliasByRef[paint.imageRef];
        }
      }
      for (const pg of pageList) {
        for (const record of collectPageRecords(pg)) {
          if (!record.props || !record.props.geometry) continue;
          aliasPaintImages(record.props.geometry.fills);
          aliasPaintImages(record.props.geometry.strokes);
        }
      }

      function writeLayerChunks(folder, pageId, pageRecords) {
        const chunkPaths = [];
        let chunkRecords = [];
        let chunkBytes = 0;
        function flushChunk() {
          if (chunkRecords.length === 0) return;
          const chunkPath = `${folder}/layers/layers-${String(chunkPaths.length).padStart(4, "0")}.json`;
          out[chunkPath] = encoder.encode(JSON.stringify({
            schema: "mastergo2figma.layers.v2",
            version: 2,
            pageId: pageId,
            records: chunkRecords
          }));
          chunkPaths.push(chunkPath);
          chunkRecords = [];
          chunkBytes = 0;
        }
        for (const record of pageRecords) {
          const recordBytes = JSON.stringify(record).length;
          if (chunkRecords.length > 0 && (chunkRecords.length >= 16 || chunkBytes + recordBytes > 64 * 1024)) flushChunk();
          chunkRecords.push(record);
          chunkBytes += recordBytes + (chunkRecords.length > 1 ? 1 : 0);
          if (chunkRecords.length >= 16 || chunkBytes >= 64 * 1024) flushChunk();
        }
        flushChunk();
        return chunkPaths;
      }

      function collectPageRecords(pg) {
        const seen = {};
        const result = [];
        for (const root of pg.roots) {
          for (const id of subtreeOf(root)) {
            if (seen[id] || !recordsById[id]) continue;
            seen[id] = true;
            result.push(recordsById[id]);
          }
        }
        return result;
      }

      // Carry over image bytes and register them under both the file name and the
      // bare hash, so an image fill's imageRef resolves regardless of which form
      // MasterGo used.
      const assets = {};
      let imageAssetCount = 0;
      for (const path in zipEntries) {
        if (!/^images\//i.test(path)) continue;
        const bytes = zipEntries[path];
        if (!bytes) continue;
        out[path] = bytes;
        const baseName = path.slice(path.lastIndexOf("/") + 1);
        if (!baseName) continue;
        const bareName = baseName.replace(/\.[^.]+$/, "");
        imageAssetCount++;
        assets[baseName] = { key: baseName, fileName: baseName, path: path };
        if (bareName && bareName !== baseName) {
          assets[bareName] = { key: bareName, fileName: baseName, path: path };
        }
      }
      for (const ref in imageAliasByRef) {
        const backing = assets[ref] || assets[ref.replace(/\.[^.]+$/, "")];
        if (backing) {
          const alias = imageAliasByRef[ref];
          assets[alias] = { key: alias, fileName: backing.fileName, path: backing.path };
        }
      }

      const manifestPages = [];
      let totalLayerCount = 0;
      for (let pi = 0; pi < pageList.length; pi++) {
        const pg = pageList[pi];
        const pageName = pg.name;
        const folder = `pages/page-${pi}`;
        const pageFile = `${folder}/index.json`;
        const pageId = `mgpage-${pi}`;
        const layerChunks = writeLayerChunks(folder, pageId, collectPageRecords(pg));
        const pageIndexJson = {
          schema: "mastergo2figma.page.v2",
          version: 2,
          id: pageId,
          name: pageName,
          folder: folder,
          rootNodeIds: pg.roots,
          layerChunks: layerChunks,
          layerCount: pg.count
        };
        // Page canvas color (native decode only; SendToFigma's v2 zips do not
        // carry it). The importer applies it as the page background paint.
        if (pg.background) pageIndexJson.background = pg.background;
        out[pageFile] = encoder.encode(JSON.stringify(pageIndexJson));
        manifestPages.push({ id: pageId, name: pageName, folder: folder, pageFile: pageFile, layerCount: pg.count });
        totalLayerCount += pg.count;
      }

      // Library styles payload: values pulled from the registries keyed by
      // the style id (fills → paint table, effects → effect registry, text →
      // font-style table third spelling). The zip baseline has no styles
      // concept, so this entry is additive — comparator/pythonParser ignore it.
      const emittedStyles = [];
      for (const sid in styleDefs) {
        const def = styleDefs[sid];
        if (def.category === "FILL" || def.category === "STROKE") {
          const fills = paints[sid];
          if (fills && fills.length) {
            // Strip per-node finalize temps — styles have no node size to
            // resolve them against (a radial style keeps the scan transform).
            const stylePaints = fills.map(mgCloneJsonValue);
            for (const sp of stylePaints) {
              if (sp && sp.__mgRadialMeta) delete sp.__mgRadialMeta;
              if (sp && sp.__mgLinearMeta) delete sp.__mgLinearMeta;
              if (sp && sp.__mgCropRect) delete sp.__mgCropRect;
            }
            emittedStyles.push({ id: sid, styleType: "PAINT", name: def.name, paints: stylePaints });
          }
        } else if (def.category === "EFFECT") {
          const fx = effectTable[sid];
          if (fx && fx.length) {
            emittedStyles.push({ id: sid, styleType: "EFFECT", name: def.name, effects: fx.map(mgCloneJsonValue) });
          }
        } else if (def.category === "TEXT") {
          const entry = fontStyles[sid];
          if (entry) {
            emittedStyles.push({
              id: sid, styleType: "TEXT", name: def.name,
              fontName: mgFontNameFromStyleEntry(entry) || { family: "Inter", style: "Regular" },
              fontSize: (entry.fontSize !== null && entry.fontSize > 0) ? entry.fontSize : 12,
              lineHeight: (entry.lineHeight !== null && entry.lineHeight > 0)
                ? { value: entry.lineHeight, unit: "PIXELS" } : { unit: "AUTO" },
              letterSpacing: mgLetterSpacingFromStyleEntry(entry, 1),
              textCase: entry.textCase || "ORIGINAL",
              textDecoration: entry.decoration || "NONE"
            });
          }
        }
      }
      if (emittedStyles.length > 0) {
        out["styles.json"] = encoder.encode(JSON.stringify({
          schema: "mastergo2figma.styles.v1",
          version: 1,
          styles: emittedStyles
        }));
      }
      out["manifest.json"] = encoder.encode(JSON.stringify({
        schema: "mastergo2figma.package.v2",
        version: 2,
        source: "mastergo",
        documentId: (meta && typeof meta.fileId === "number") ? meta.fileId : 0,
        exportedAt: new Date().toISOString(),
        scope: "mg-file",
        pages: manifestPages,
        assets: assets,
        stats: {
          pageCount: manifestPages.length,
          layerCount: totalLayerCount,
          imageAssetCount: imageAssetCount,
          missingImageAssetCount: 0
        }
      }));

      return out;
    }


  global.MasterGoMg = {
    isMgPackage: isMgPackage,
    convertMgPackageToV2Entries: convertMgPackageToV2Entries,
    __test: {
      resolveInstanceVisibility: mgResolveInstanceVisibility,
      shouldInheritStroke: mgShouldInheritStroke,
      decodeNativeNodes: mgDecodeNativeNodes,
      decodeGeometryBlob: mgDecodeGeometryBlob,
      parseContainerMeta: mgParseContainerMeta,
      walkScalarFields: mgWalkScalarFields,
      normalizeRotation: mgNormalizeRotation,
      parseTextRuns: mgParseTextRuns,
      scanPaints: mgScanPaints,
      slimInstanceDescendantProps: mgSlimInstanceDescendantProps,
      resolveBooleanLeafSize: mgResolveBooleanLeafSize,
      scaleByConstraint: mgScaleByConstraint,
      coversTemplateParent: mgCoversTemplateParent,
      radialAxisRatio: mgRadialAxisRatio,
      radialGradientTransform: mgRadialGradientTransform,
      rebaseContainerByAnchor: mgRebaseContainerByAnchor,
      usesCenteredGroupResize: mgUsesCenteredGroupResize
    }
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = global.MasterGoMg;
  }
})(typeof window !== "undefined" ? window : globalThis);
