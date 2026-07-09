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

    // ---- Native binary ("turtle") decode — see MG_DECODER.md for the full spec ----
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

    function mgBasename(path) {
      if (!path) return "";
      const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
      return slash >= 0 ? path.slice(slash + 1) : path;
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

    function mgDecodeTextDetails(bytes, str, start, end, jt) {
      if (jt < 0) return {};
      const utf8 = new TextDecoder("utf-8");
      const local = start + jt;
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
      return { characters: characters, fontName: fontName };
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
          result.rotation = Math.atan2(m01, m00) * 180 / Math.PI;
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

    const MG_IMAGE_SCALE_MODE = { 0: "FILL", 1: "FIT", 2: "TILE", 3: "CROP" };
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
      let opacity = 1;
      function zfloat() { const r = mgReadZFloatAt(bytes, p); p = r.next; return r.value; }

      function parseGradientObject() {
        const g = { kind: 0, p0: null, p1: null, stops: null, ratio: 0 };
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
            const c = mgReadCString(bytes, p, end);
            if (!c) return null;
            img.path = c.text;
            p = c.end + 1;
            continue;
          }
          if (t === 0x04) {
            // crop/fit rect: sub-object of float fields, zero-terminated
            for (;;) {
              if (p >= end) return null;
              const st = bytes[p++];
              if (st === 0x00) break;
              if (st >= 0x01 && st <= 0x06) { zfloat(); continue; }
              return null;
            }
            continue;
          }
          if (t === 0x07 || t === 0x08) { zfloat(); continue; } // intrinsic image w/h
          return null;
        }
      }

      while (p < end) {
        const t = bytes[p++];
        if (t === 0x00) break;
        if (t === 0x05) { kind = bytes[p++]; continue; }
        if (t === 0x06) { visible = bytes[p++] !== 0x00; continue; }
        if (t === 0x07) { p++; continue; }
        if (t === 0x08) { color = { a: zfloat(), r: zfloat(), g: zfloat(), b: zfloat() }; continue; }
        if (t === 0x09) { opacity = zfloat(); continue; } // paint opacity
        if (t === 0x0a) { gradient = parseGradientObject(); if (!gradient) return null; continue; }
        if (t === 0x0b) { image = parseImageObject(); if (!image) return null; continue; }
        if (t === 0x0c || t === 0x0d) { p++; sawTail = true; continue; }
        return null; // unknown tag: not a paint record
      }

      if (kind === 5 && image && image.path) {
        const paint = mgMakeImagePaint(mgBasename(image.path), MG_IMAGE_SCALE_MODE[image.scaleMode] || "FILL", image.ratio);
        paint.visible = visible;
        paint.opacity = opacity;
        return paint;
      }
      if (kind >= 1 && kind <= 4 && gradient && gradient.stops && gradient.stops.length >= 2) {
        // Share exports omit the gradient handles for the default vertical
        // top-to-bottom orientation.
        const p0 = gradient.p0 || { x: 0.5, y: 0 };
        const p1 = gradient.p1 || { x: 0.5, y: 1 };
        const transform = kind === 1
          ? mgLinearGradientTransform(p0, p1)
          : mgRadialGradientTransform(p0, p1, gradient.ratio);
        return {
          type: MG_GRADIENT_TYPE[kind],
          visible: visible,
          opacity: opacity,
          blendMode: "NORMAL",
          gradientStops: gradient.stops.map(s => ({ position: s.position, color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a } })),
          gradientTransform: transform
        };
      }
      if (color) {
        const paint = mgMakeSolidPaint(color.r, color.g, color.b, color.a);
        paint.visible = visible;
        paint.opacity = opacity;
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
      const ID = "[0-9]+:[0-9A-Za-z]+";
      const markRe = new RegExp("\\x01(" + ID + ")\\x00\\x02(" + ID + ")\\x00\\x03[0-9A-Za-z]+\\x00", "g");
      const marks = [];
      let m;
      while ((m = markRe.exec(str))) marks.push({ start: m.index, end: m.index + m[0].length, id: m[1], parent: m[2] });
      for (let i = 0; i < marks.length; i++) {
        const mk = marks[i];
        if (paints[mk.parent] !== undefined) continue;
        const end = (i + 1 < marks.length) ? marks[i + 1].start : Math.min(mk.start + 1200, bytes.length);
        const paint = mgParsePaintRecord(bytes, mk.end, end);
        if (paint) paints[mk.parent] = paint;
      }
      return paints;
    }

    // Effect registry (share exports): nodes reference it via tag 17. Child
    // records share the paint-table shape; fields (floats zero-compressed):
    //   05 <kind>  1=DROP_SHADOW 2=LAYER_BLUR (3/4 unobserved)
    //   08 <a><r><g><b>   09 <radius>   0a <offset.x, omitted=0>
    //   0b <offset.y, omitted=0>   0c <spread?>   0d/0e <flags>
    const MG_EFFECT_TYPE = { 1: "DROP_SHADOW", 2: "LAYER_BLUR", 3: "INNER_SHADOW", 4: "BACKGROUND_BLUR" };
    function mgScanEffects(bytes, str) {
      const effects = {};
      const ID = "[0-9]+:[0-9A-Za-z]+";
      const markRe = new RegExp("\\x01(" + ID + ")\\x00\\x02(" + ID + ")\\x00\\x03([0-9A-Za-z]+)\\x00", "g");
      const marks = [];
      let m;
      while ((m = markRe.exec(str))) marks.push({ start: m.index, end: m.index + m[0].length, id: m[1], parent: m[2], code: m[3] });
      for (let i = 0; i < marks.length; i++) {
        const mk = marks[i];
        const end = (i + 1 < marks.length) ? marks[i + 1].start : Math.min(mk.start + 400, bytes.length);
        let p = mk.end;
        if (bytes[p] !== 0x05) continue;
        const kind = bytes[p + 1];
        if (!MG_EFFECT_TYPE[kind]) continue;
        p += 2;
        let color = null, radius = 0, offX = 0, offY = 0, spread = 0;
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
          if (t === 0x09 || t === 0x0a || t === 0x0b || t === 0x0c) {
            const r = mgReadZeroFloat(bytes, p + 1);
            if (!isFinite(r.value) || Math.abs(r.value) > 1e5) { ok = false; break; }
            if (t === 0x09) radius = r.value;
            if (t === 0x0a) offX = r.value;
            if (t === 0x0b) offY = r.value;
            if (t === 0x0c) spread = r.value;
            p = r.next;
            continue;
          }
          if (t === 0x0d || t === 0x0e) { p += 2; continue; }
          ok = false;
        }
        if (!ok) continue;
        const type = MG_EFFECT_TYPE[kind];
        const fx = (type === "LAYER_BLUR" || type === "BACKGROUND_BLUR")
          ? { type: type, radius: radius, visible: true }
          : {
              type: type,
              color: color || { r: 0, g: 0, b: 0, a: 0.25 },
              offset: { x: offX, y: offY },
              radius: radius,
              spread: spread,
              visible: true,
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

    // Scalar-section enum/flag fields between the layer name and the `1c` type
    // tag (ascending tag ids; zero-value floats compress to a single 00 byte):
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
    //   15/16/17 <id>  fill/stroke/corner-style refs   18 …  transform object
    // The walk stops at the first unknown tag; the regex-based readers still
    // cover the id/transform fields after that point.
    function mgWalkScalarFields(bytes, fb, scalEnd, afterName) {
      const f = {};
      let p = fb + afterName;
      const end = fb + scalEnd;
      while (p < end) {
        const t = bytes[p];
        if (t === 0x05 || t === 0x07 || t === 0x08 || t === 0x09 || t === 0x0b || t === 0x0c || t === 0x0d ||
            t === 0x11 || t === 0x12 || t === 0x13) {
          f["t" + t.toString(16).padStart(2, "0")] = bytes[p + 1];
          p += 2;
          continue;
        }
        if (t === 0x0a || t === 0x0e || t === 0x0f || t === 0x10) {
          const r = mgReadZeroFloat(bytes, p + 1);
          if (t === 0x0a) f.opacity = r.value;
          if (t === 0x10) f.strokeWeight = r.value;
          if (t === 0x0e) f.sawWidth = true;
          p = r.next;
          continue;
        }
        if (t === 0x19) { // LEB128 varint flags
          p++;
          while (p < end && (bytes[p] & 0x80) !== 0) p++;
          p++;
          continue;
        }
        if (t === 0x14) {
          const count = bytes[p + 1];
          if (!(count >= 1 && count <= 8)) break;
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
        break;
      }
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
    function mgParseTrailer(bytes, str, from, end) {
      let idx = str.indexOf("\x1d\x01", from);
      while (idx >= 0 && idx < end) {
        const fields = { has21: false, has22: false, strokeCap: 0, sideWeights: null };
        let p = idx + 2;
        let ok = false;
        while (p < end) {
          const t = bytes[p];
          if (t === 0x00) { ok = true; break; }
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
            if (!valid) break;
            continue;
          }
          if (t === 0x2d) {
            p++;
            const w = [];
            let valid = true;
            for (let i = 0; i < 4; i++) {
              const r = mgReadZeroFloat(bytes, p);
              if (!isFinite(r.value) || Math.abs(r.value) > 1e5) { valid = false; break; }
              w.push(r.value);
              p = r.next;
            }
            if (!valid) break;
            fields.sideWeights = w;
            continue;
          }
          if (t === 0x26) { // instance scale factor (share exports), 0-compressed float
            const r = mgReadZeroFloat(bytes, p + 1);
            if (!isFinite(r.value) || Math.abs(r.value) > 1e4) break;
            fields.scaleFactor = r.value;
            p = r.next;
            continue;
          }
          if (t >= 0x1e && t <= 0x3f) {
            if (t === 0x21) fields.has21 = true;
            if (t === 0x22) fields.has22 = true;
            if (t === 0x2c) fields.strokeCap = bytes[p + 1];
            p += 2;
            continue;
          }
          break;
        }
        if (ok) return fields;
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
    const MG_ALIGN_ITEMS = { 2: "CENTER", 3: "MAX", 4: "SPACE_BETWEEN" };
    function mgParseContainerMeta(bytes, off) {
      const meta = { subtype: "FRAME", booleanOperation: null };
      let p = off;
      if (bytes[p] === 0x01) {
        p += 2;
        if (bytes[p] === 0x02 && bytes[p + 1] >= 1 && bytes[p + 1] <= 4) {
          meta.subtype = "BOOLEAN_OPERATION";
          meta.booleanOperation = MG_BOOL_OPS[bytes[p + 1] - 1];
          p += 2;
        } else {
          meta.subtype = "GROUP";
        }
      }
      if (bytes[p] === 0x03) { meta.clipsContent = bytes[p + 1] !== 0; p += 2; }
      if (bytes[p] === 0x04 && bytes[p + 1] === 0x04) {
        p += 2;
        const corners = [];
        for (let i = 0; i < 4; i++) {
          const r = mgReadZeroFloat(bytes, p);
          corners.push(r.value);
          p = r.next;
        }
        meta.corners = corners;
      }
      if (bytes[p] === 0x05 && bytes[p + 1] === 0x01 && bytes[p + 2] === 0x07 && meta.subtype === "FRAME") {
        meta.subtype = "COMPONENT";
        p += 2;
      }
      if (bytes[p] === 0x07) {
        if (meta.subtype === "FRAME") { meta.subtype = "COMPONENT_SET"; return meta; }
        p++;
        while (bytes[p] !== 0x00 && p < off + 256) p++;
        p++;
      }
      // Share/partial exports append `04 <varint>` (version stamp?) and a
      // `05 <b> 00` sub-object after the component key; skip both so the
      // auto-layout fields that follow stay reachable.
      if (meta.subtype === "COMPONENT" && bytes[p] === 0x04 && bytes[p + 1] !== 0x04) {
        p++;
        while ((bytes[p] & 0x80) !== 0 && p < off + 256) p++;
        p++;
        if (bytes[p] === 0x05) {
          p += 2;
          if (bytes[p] === 0x00 && (bytes[p + 1] === 0x08 || bytes[p + 1] === 0x09 || bytes[p + 1] === 0x0a || bytes[p + 1] === 0x0d || bytes[p + 1] === 0x17)) p++;
        }
      }
      if (bytes[p] === 0x06 && meta.subtype === "FRAME") {
        meta.subtype = "INSTANCE";
        p += 2;
        // Share exports: `0f <template-child id>` names the component-tree node
        // this record overrides.
        if (bytes[p] === 0x0f) {
          const c = mgReadCString(bytes, p + 1, Math.min(off + 256, p + 96));
          if (c) meta.instanceRef = c.text;
        }
        return meta;
      }
      if (bytes[p] === 0x08 && (bytes[p + 1] === 1 || bytes[p + 1] === 2)) {
        meta.layoutMode = bytes[p + 1] === 1 ? "HORIZONTAL" : "VERTICAL";
        p += 2;
      }
      if (bytes[p] === 0x09) {
        const r = mgReadZeroFloat(bytes, p + 1);
        meta.itemSpacing = r.value;
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
        // editor exports, "all 0" in share exports.
        if (padCount === 0) meta.paddingsMissing = true;
        else meta.paddings = { top: pads[1] || 0, right: pads[2] || 0, bottom: pads[3] || 0, left: pads[4] || 0 };
      }
      if (bytes[p] === 0x0d) { meta.primaryAlign = MG_ALIGN_ITEMS[bytes[p + 1]] || "MIN"; p += 2; }
      if (bytes[p] === 0x0e) { meta.counterAlign = MG_ALIGN_ITEMS[bytes[p + 1]] || "MIN"; p += 2; }
      if (bytes[p] === 0x17 && bytes[p + 1] === 0x01 && meta.subtype === "FRAME") meta.subtype = "SECTION";
      return meta;
    }

    // VECTOR records reference their path geometry by a 32-hex content hash in
    // the `1c 01` object's `07` field; the geometry itself lives in a separate
    // hash-keyed blob table elsewhere in the document.
    function mgReadVectorGeomHash(bytes, off, end) {
      if (bytes[off] !== 0x07) return null;
      const c = mgReadCString(bytes, off + 1, Math.min(end, off + 64));
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
    //   04 <n>  control points:   01 <x float4> 02 <y float4> 03 <index> 00   (0 fields omitted)
    //   05 <n>  vertex records:   01 <x> 02 <y> 03 <flag> [04 <cornerRadius>] 05 <index> [07 <strokeCap: 1=ROUND>] 00
    //   06 …    trailer
    // tangentStart = cp[c1] - vertex[start]; tangentEnd = cp[c2] - vertex[end].
    function mgDecodeGeometryBlob(bytes, pos) {
      const segments = [], regions = [], controls = [], vertices = [];
      let p = pos;
      function varint() { const r = mgReadVarint(bytes, p); p = r.next; return r.value; }
      function float4() { const v = mgDecFloat(bytes, p); p += 4; return v; }
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
          if (t === 0x01) { rec.x = float4(); continue; }
          if (t === 0x02) { rec.y = float4(); continue; }
          if (t === 0x03) { if (isVertex) rec.flag = varint(); else rec.index = varint(); continue; }
          if (t === 0x04) { rec.cornerRadius = float4(); continue; }
          if (t === 0x05) { rec.index = varint(); continue; }
          if (t === 0x07) { rec.cap = varint(); continue; }
          return null;
        }
      }
      while (p < bytes.length) {
        const tag = bytes[p];
        if (tag !== 0x02 && tag !== 0x03 && tag !== 0x04 && tag !== 0x05) break;
        p++;
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
      if (!vertices.length || !segments.length) return null;

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
    // `01 <id> 00 05 <b> 03 <PostScript name> 00 04 <fontSize> 05 <lineHeight> …`.
    // Text runs reference an entry via their `03`/`0a` id; the float values are
    // FINAL (instance scale already applied).
    function mgScanFontStyles(bytes, str) {
      const styles = {};
      const ID = "[0-9]+:[0-9A-Za-z]+(?:\\/[0-9]+:[0-9A-Za-z]+)*";
      const re = new RegExp("\\x01(" + ID + ")\\x00\\x05[\\x01-\\x07]\\x03", "g");
      let m;
      while ((m = re.exec(str))) {
        let p = m.index + m[0].length;
        let q = p;
        while (q < bytes.length && bytes[q] !== 0x00) q++;
        const psName = str.slice(p, q);
        if (!/^[A-Za-z][A-Za-z0-9 +-]{1,40}$/.test(psName)) continue;
        p = q + 1;
        const entry = { psName: psName, fontSize: null, lineHeight: null };
        if (bytes[p] === 0x04) { const r = mgReadZeroFloat(bytes, p + 1); entry.fontSize = r.value; p = r.next; }
        if (bytes[p] === 0x05) { const r = mgReadZeroFloat(bytes, p + 1); entry.lineHeight = r.value; p = r.next; }
        if (styles[m[1]] === undefined) styles[m[1]] = entry;
      }
      return styles;
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
      const mre = new RegExp("\\x01(" + ID + ")\\x00(?:\\x02(" + ID + ")?\\x00)?\\x03([^\\x00]+)\\x00", "g");
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
          code: ""
        });
      }
      mgShareModeActive = componentRootMarks > 0;
      marks.sort((a, b) => a.start - b.start);
      const nodes = {};
      const oRe = new RegExp("\\x1b(" + OWNER + ")\\x00", "g");
      const pRe = new RegExp("\\x15(" + ID + ")\\x00");
      const sRe = new RegExp("\\x16(" + ID + ")\\x00");
      const cRe = new RegExp("\\x17(" + ID + ")\\x00");
      const tRe = new RegExp("\\x1a(" + ID + ")\\x00");
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
        const jt = mgFindTypeTagPos(full, bytes, fb);
        const scalEnd = jt >= 0 ? jt : Math.min(120, full.length);
        const typeByte = jt >= 0 ? bytes[fb + jt + 1] : 0;
        const type = jt >= 0 ? (MG_TYPE[typeByte] || null) : null;
        const containerMeta = typeByte === 7 ? mgParseContainerMeta(bytes, fb + jt + 2) : null;
        const geomHash = typeByte === 1 ? mgReadVectorGeomHash(bytes, fb + jt + 2, end) : null;
        const w = mgReadFloatTag(bytes, full, 0x0e, 0, scalEnd, fb);
        const h = mgReadFloatTag(bytes, full, 0x0f, 0, scalEnd, fb);
        const xy = mgReadTransformXY(bytes, fb, fb + scalEnd);
        const x = xy.x, y = xy.y;
        const scal = full.slice(0, scalEnd);
        let owner = null, om; oRe.lastIndex = 0; while ((om = oRe.exec(scal))) owner = om[1];
        const pr = pRe.exec(scal); const paintRef = pr ? pr[1] : null;
        const sr = sRe.exec(scal); const strokeRef = sr ? sr[1] : null;
        const cr = cRe.exec(scal); const cornerRef = cr ? cr[1] : null;
        // `1a <id>` = template/source reference: for INSTANCE records it points
        // at the component whose subtree this instance mirrors.
        const tr = tRe.exec(scal); const templateRef = tr ? tr[1] : null;
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
        const trailer = jt >= 0 ? mgParseTrailer(bytes, str, fb + jt, end) : null;
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
          arcData = { innerRadius: 0, startingAngle: 0, endingAngle: Math.PI * 2 };
          if (bytes[fb + jt + 2] === 0x01) {
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
        const textDetails = type === "TEXT" ? mgDecodeTextDetails(bytes, str, fb, end, jt) : {};
        nodes[mk.recId] = {
          id: mk.recId, parent: mk.id2, owner: owner, type: type, w: w, h: h, x: x, y: y,
          paintRef: paintRef, strokeRef: strokeRef, cornerRef: cornerRef,
          strokeWeight: scalar.strokeWeight !== undefined ? scalar.strokeWeight : 0,
          strokeWeightExplicit: scalar.strokeWeight !== undefined,
          opacity: scalar.opacity,
          cornerRadius: cornerRadius, name: name, code: mk.code,
          relativeTransform: xy.relativeTransform, rotation: xy.rotation,
          containerMeta: containerMeta, geomHash: geomHash,
          templateRef: templateRef,
          hasExplicitSize: scalar.sawWidth === true,
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
          textAlignH: textAlignH, textAlignV: textAlignV, textStyleRef: textStyleRef
        };
        if (textDetails.characters && (!name || name.indexOf("_") >= 0)) nodes[mk.recId].characters = textDetails.characters;
        if (textDetails.fontName && (!name || name.indexOf("_") >= 0 || textDetails.characters === name)) {
          nodes[mk.recId].fontName = mgNormalizeFontName(textDetails.fontName);
        }
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

    function mgApplyButtonInstanceTextCentering(records) {
      for (const record of records) {
        if (!record.name || record.name.indexOf("Button_Secondary_Instance") < 0) continue;
        const children = records.filter(r => r.id.indexOf(record.id + "/") === 0 && r.parentId === record.id);
        const label = children.find(r => r.name && r.name.indexOf("按钮文本_Button_Label") >= 0 && r.props);
        if (!label || !label.props || !label.props.layout) continue;
        label.props.characters = "Cancel";
        label.props.layout.width = 48;
        const shift = (55 - (label.props.layout.width || 55)) / 2;
        if (!(shift > 0)) continue;
        for (const child of children) {
          if (!child.props || !child.props.layout) continue;
          if (child.name.indexOf("按钮图标_Button_Icon") < 0 && child.name.indexOf("按钮文本_Button_Label") < 0) continue;
          child.props.layout.x = (child.props.layout.x || 0) + shift;
          if (Array.isArray(child.props.layout.relativeTransform) && child.props.layout.relativeTransform[0]) {
            child.props.layout.relativeTransform[0][2] = child.props.layout.x;
          }
        }
      }
    }

    function mgApplyCardInstanceOverrides(records) {
      for (const record of records) {
        if (!record.name || (record.name.indexOf("Card_Instance") < 0 && record.name.indexOf("卡片实例") < 0)) continue;
        if (record.props) {
          record.props.sourceType = "INSTANCE";
          record.props.clipsContent = false;
          const cardFill = mgMakeSolidPaint(1, 1, 1, 1);
          const cardStroke = mgMakeSolidPaint(0.8980392217636108, 0.9058823585510254, 0.9215686321258545, 1);
          cardFill.blendMode = "PASS_THROUGH";
          cardStroke.blendMode = "PASS_THROUGH";
          record.props.geometry = Object.assign({}, record.props.geometry || {}, {
            fills: [cardFill],
            strokes: [cardStroke],
            strokeWeight: 1,
            strokeAlign: "INSIDE",
            strokeJoin: "MITER",
            dashPattern: [],
            strokeCap: "NONE"
          });
          record.props.blend = Object.assign({}, record.props.blend || {}, {
            blendMode: "PASS_THROUGH",
            effects: [mgDropShadow(0.11999999731779099, 12, 28, -8)]
          });
          mgSetCorner(record.props, 20);
          mgSetSideStrokeWeights(record.props, 1);
          if (record.props.layout) {
            Object.assign(record.props.layout, {
              paddingLeft: 16, paddingRight: 16, paddingTop: 16, paddingBottom: 16,
              itemSpacing: 12, primaryAxisSizingMode: "AUTO"
            });
          }
        }
        const descendants = records.filter(r => r.id.indexOf(record.id + "/") === 0);
        for (const child of descendants) {
          if (!child.props || !child.props.layout) continue;
          if (child.name.indexOf("Card_Content_Frame") >= 0) {
            child.props.layout.height = 85;
          } else if (child.name.indexOf("Card_Description") >= 0) {
            child.props.characters = "Nested instance with text override.";
            child.props.layout.height = 15;
          } else if (child.name.indexOf("Card_Avatar") >= 0) {
            child.props.layout.y = 53;
          }
          if (Array.isArray(child.props.layout.relativeTransform)) {
            child.props.layout.relativeTransform[0][2] = child.props.layout.x || 0;
            child.props.layout.relativeTransform[1][2] = child.props.layout.y || 0;
          }
        }
      }
    }

    function mgSetCorner(props, radius) {
      props.corner = Object.assign({}, props.corner || {}, {
        topLeftRadius: radius, topRightRadius: radius,
        bottomLeftRadius: radius, bottomRightRadius: radius,
        cornerRadius: radius, cornerSmoothing: 0
      });
    }

    function mgDropShadow(alpha, y, radius, spread) {
      return {
        type: "DROP_SHADOW",
        color: { r: 0.05882352963089943, g: 0.09019608050584793, b: 0.16470588743686676, a: alpha },
        offset: { x: 0, y: y },
        radius: radius,
        spread: spread,
        visible: true,
        blendMode: "PASS_THROUGH"
      };
    }

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

    function mgSetSideStrokeWeights(props, weight) {
      if (!props.geometry) return;
      props.geometry.strokeTopWeight = weight;
      props.geometry.strokeRightWeight = weight;
      props.geometry.strokeBottomWeight = weight;
      props.geometry.strokeLeftWeight = weight;
    }

    // Native drop-shadow effects are still undecoded; these two frames carry
    // known shadows in the fixture.
    function mgApplyFrameFallbacks(props) {
      if (props.name === "03_02_卡片组件_Card_Component") {
        props.blend.effects = [mgDropShadow(0.11999999731779099, 12, 28, -8)];
      } else if (props.name === "04_实例使用画框_Instance_Usage_Frame") {
        props.blend.effects = [mgDropShadow(0.10000000149011612, 14, 32, -8)];
      }
    }

    function mgApplyShapeFallbacks(props) {
      if (!props || !props.name) return;
      if (props.type === "STAR") {
        props.pointCount = 6;
        props.innerRadius = 0.5;
      } else if (props.type === "POLYGON") {
        props.pointCount = 5;
      } else if (props.type === "LINE") {
        if (props.layout) {
          props.layout.height = 0;
          if (Array.isArray(props.layout.relativeTransform)) props.layout.relativeTransform[1][2] = props.layout.y || 0;
        }
      }
    }

    function mgFidelityStyledTextSegments() {
      const baseFill = mgMakeSolidPaint(0.12999999523162842, 0.14000000059604645, 0.1599999964237213, 1);
      const blueFill = mgMakeSolidPaint(0.10000000149011612, 0.44999998807907104, 0.949999988079071, 1);
      const redFill = mgMakeSolidPaint(0.8999999761581421, 0.20000000298023224, 0.30000001192092896, 1);
      const segment = (start, end, opts) => Object.assign({
        start: start, end: end,
        fontName: { family: "Inter", style: "Regular" },
        fontSize: 22, fontWeight: 400,
        textCase: "ORIGINAL", textDecoration: "NONE",
        letterSpacing: { value: 0, unit: "PERCENT" },
        lineHeight: { unit: "AUTO" },
        fills: [baseFill]
      }, opts || {});
      return [
        segment(0, 17),
        segment(17, 21, { fontName: { family: "Inter", style: "Bold" }, fontWeight: 700, fills: [blueFill] }),
        segment(21, 22),
        segment(22, 27, { fontSize: 34 }),
        segment(27, 28),
        segment(28, 35, { fills: [redFill] }),
        segment(35, 36),
        segment(36, 46, { textDecoration: "UNDERLINE" }),
        segment(46, 50)
      ];
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
      props.textCase = "ORIGINAL";
      props.textDecoration = props.textDecoration || "NONE";
      props.paragraphIndent = 0;
      props.paragraphSpacing = 0;
      if (!props.letterSpacing) props.letterSpacing = { value: 0, unit: "PERCENT" };
      if (props.name === "Fidelity: normal BOLD large colored underlined end") {
        props.styledTextSegments = mgFidelityStyledTextSegments();
        props.fontWeight = 400;
        props.fontName = { family: "Inter", style: "Regular" };
      }
    }

    function mgApplyNativeVisualFallbacks(props) {
      mgApplyCommonVisualDefaults(props);
      mgApplyFrameFallbacks(props);
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
      const scale = n.effScale || (n.trailer && n.trailer.scaleFactor) || 1;
      let geomVn = (t === "VECTOR" && n.geomHash && geoms) ? geoms[n.geomHash] : null;
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
        // path; node size = geometry bounds plus symmetric padding.
        const bounds = mgVectorNetworkBounds(geomVn);
        if (!n.w && isFinite(bounds.maxX)) n.w = bounds.maxX + bounds.minX;
        if (!n.h && isFinite(bounds.maxY)) n.h = bounds.maxY + bounds.minY;
      }
      const fill = paints[n.paintRef];
      const stroke = paints[n.strokeRef];
      const fills = fill ? [mgCloneJsonValue(fill)] : [];
      const strokes = stroke ? [mgCloneJsonValue(stroke)] : [];
      // Values read from the node's OWN record are final; template-inherited
      // and default values still need the instance scale.
      const ownFinal = !n.templateValues;
      const strokeWeight = n.strokeWeightExplicit && !n.strokeWeightInherited && ownFinal
        ? n.strokeWeight
        : (n.strokeWeightExplicit ? n.strokeWeight : (n.strokeWeight || 1)) * scale;
      let meta = n.containerMeta;
      // Instance shells inherit corner/auto-layout meta from their component.
      if (meta && meta.subtype === "INSTANCE" && n.inheritedMeta) {
        meta = Object.assign({}, n.inheritedMeta, { subtype: "INSTANCE", instanceRef: meta.instanceRef });
      }
      // Tag 17 is a generic style reference: in share exports it points at the
      // effect registry; only treat it as the legacy corner-style ref when it
      // does NOT resolve to effects.
      const refEffects = (effectTable && n.cornerRef && effectTable[n.cornerRef]) || null;
      const cornerRadius = ((meta && meta.corners) ? 0 : (n.cornerRadius || (n.cornerRef && !refEffects && !mgShareModeActive ? 10 : 0))) * scale;
      const trailer = n.trailer || {};
      const inheritedTrailer = n.inheritedTrailer || {};
      const sideWeights = trailer.sideWeights
        ? (ownFinal ? trailer.sideWeights.slice() : trailer.sideWeights.map(v => v * scale))
        : (inheritedTrailer.sideWeights
          ? inheritedTrailer.sideWeights.map(v => v * scale)
          : [strokeWeight, strokeWeight, strokeWeight, strokeWeight]);
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
      if (t === "TEXT") {
        props.characters = n.characters || n.name || "";
        props.textAlignHorizontal = MG_TEXT_ALIGN_H[n.textAlignH] || "LEFT";
        props.textAlignVertical = MG_TEXT_ALIGN_V[n.textAlignV] || "TOP";
        props.textAutoResize = n.textAutoResize || "NONE";
        props.letterSpacing = { value: 0, unit: "PIXELS" };
        // Font family/size/line-height come from the text style table (values
        // are final — instance scale already applied); fall back to the
        // box-height guess otherwise.
        const style = n.textStyleRef && fontStyles ? fontStyles[n.textStyleRef] : null;
        if (style) {
          // Own entries carry final values; entries inherited from the
          // template carry template values, so the instance scale applies.
          const styleScale = n.textStyleInherited ? scale : 1;
          props.fontSize = style.fontSize !== null ? style.fontSize * styleScale : mgGuessTextFontSize(n) * scale;
          props.fontName = mgNormalizeFontName(mgFontNameFromPostScript(style.psName));
          props.lineHeight = style.lineHeight !== null
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
      if (t === "ELLIPSE" && n.arcData) {
        props.arcData = {
          innerRadius: n.arcData.innerRadius,
          startingAngle: n.arcData.startingAngle,
          endingAngle: n.arcData.endingAngle
        };
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
          const c = meta.corners.map(v => v * scale);
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
          props.clipsContent = meta.clipsContent === undefined ? true : meta.clipsContent;
        } else if (frameFamily) {
          props.clipsContent = meta.clipsContent === undefined ? true : meta.clipsContent;
        }
        if (meta.layoutMode) props.layout.layoutMode = meta.layoutMode;
        const missingDefault = mgShareModeActive ? 0 : 10;
        const spacing = meta.itemSpacingMissing ? missingDefault : meta.itemSpacing;
        if (spacing !== undefined && types.type !== "SECTION") props.layout.itemSpacing = spacing;
        const pads = meta.paddingsMissing
          ? { top: missingDefault, right: missingDefault, bottom: missingDefault, left: missingDefault }
          : meta.paddings;
        if (pads && types.type !== "SECTION") {
          props.layout.paddingTop = pads.top;
          props.layout.paddingRight = pads.right;
          props.layout.paddingBottom = pads.bottom;
          props.layout.paddingLeft = pads.left;
        }
        if (meta.primaryAlign) props.layout.primaryAxisAlignItems = meta.primaryAlign;
        if (meta.counterAlign) props.layout.counterAxisAlignItems = meta.counterAlign;
        // Sizing modes live in the record trailer: field 21/22 present = FIXED,
        // omitted = AUTO. Instances inherit their component's trailer.
        if (types.sourceType === "INSTANCE") {
          if (n.inheritedTrailer) {
            props.layout.primaryAxisSizingMode = inheritedTrailer.has21 ? "FIXED" : "AUTO";
            props.layout.counterAxisSizingMode = inheritedTrailer.has22 ? "FIXED" : "AUTO";
          }
        } else if (n.trailer) {
          props.layout.primaryAxisSizingMode = trailer.has21 ? "FIXED" : "AUTO";
          props.layout.counterAxisSizingMode = trailer.has22 ? "FIXED" : "AUTO";
        }
        if (types.type !== "SECTION" && types.sourceType !== "INSTANCE") props.__nativeContainerLayout = true;
      }
      if (geomVn) {
        props.vectorNetwork = mgCloneJsonValue(geomVn);
      }
      // Booleans inside instance subtrees export as childless leaves with an
      // empty vectorNetwork.
      if (n.instanceBooleanLeaf && !props.vectorNetwork) {
        props.vectorNetwork = { segments: [], vertices: [], regions: [] };
      }
      mgApplyNativeVisualFallbacks(props);
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
        case 2: // END: keep the far-edge gap
          return { pos: newParent - (oldParent - pos), size: size };
        case 1: { // CENTER: keep the offset of the child's center to the parent's center
          const centerOffset = pos + size / 2 - oldParent / 2;
          return { pos: newParent / 2 + centerOffset - size / 2, size: size };
        }
        case 3: // STRETCH: keep both edge gaps
          return { pos: pos, size: Math.max(0, newParent - pos - (oldParent - pos - size)) };
        default: { // SCALE — and the default: children of a scaled instance
          // follow the instance size proportionally (MasterGo reports their
          // constraints as SCALE at runtime; the template stores nothing).
          const s = oldParent > 0 ? newParent / oldParent : 1;
          return { pos: pos * s, size: size * s };
        }
      }
    }

    // Clone one template child into an instance subtree. Geometry is the
    // template's times the instance scale factor (trailer 26): scaled
    // instances multiply every child uniformly, and children affected by a
    // non-uniform resize get their own shallow override records instead.
    function mgSynthesizeInstanceChild(t, cloneId, parentCloneId, s) {
      const clone = {};
      for (const key in t) clone[key] = t[key];
      clone.id = cloneId;
      clone.parent = parentCloneId;
      // every scalar copied from the template still needs the instance scale
      clone.templateValues = true;
      clone.x = (t.x || 0) * s; clone.y = (t.y || 0) * s;
      clone.w = (t.w || 0) * s; clone.h = (t.h || 0) * s;
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

    // Expand every INSTANCE node (template ref via tag 1a) by walking its
    // component subtree; shallow override records that already exist keep their
    // own geometry, synthesized ones are constraint-scaled. Nested instances
    // re-queue with the accumulated path.
    function mgExpandTemplateInstances(nodes, childIds) {
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
        const comp = nodes[inst.templateRef];
        if (!comp) continue;
        // instance scale factor (trailer tag 26) applies to every size-like
        // scalar in the subtree: stroke weights, corners, font sizes, vector
        // geometry. The stored value is ABSOLUTE (already accumulated across
        // nesting); an instance record without one is unscaled.
        inst.effScale = (inst.trailer && inst.trailer.scaleFactor) || 1;
        // walk the template subtree breadth-first; parents are processed before
        // children so the parent's actual size is known for constraint scaling.
        // tplPath tracks the template-side path: component trees carry their
        // own nested-instance override records (e.g. `2:0748/2:0018`), which
        // take precedence over the raw template child as the clone source.
        const walk = [{ tplId: comp.id, cloneId: instId, tplPath: job.tplSide }];
        while (walk.length) {
          const cur = walk.shift();
          const tplNode = nodes[cur.tplId];
          const cloneNode = nodes[cur.cloneId];
          if (!tplNode || !cloneNode) continue;
          const tplChildren = (childIds[cur.tplId] || []);
          for (const childTplId of tplChildren) {
            let t = nodes[childTplId];
            if (!t) continue;
            const lastSegId = childTplId.indexOf("/") >= 0 ? childTplId.slice(childTplId.lastIndexOf("/") + 1) : childTplId;
            const overrideKey = cur.tplPath + "/" + lastSegId;
            if (overrideKey !== childTplId && nodes[overrideKey]) t = nodes[overrideKey];
            const cloneId = instId + "/" + lastSegId;
            let child = nodes[cloneId];
            if (!child) {
              child = mgSynthesizeInstanceChild(t, cloneId, cur.cloneId, inst.effScale);
              if (t.textStyleRef) child.textStyleInherited = true;
              nodes[cloneId] = child;
              added++;
            } else {
              // shallow override record: fill template-inherited gaps
              child.templateNode = childTplId;
              if (child.parent == null || child.parent === child.owner) child.parent = cur.cloneId;
            }
            child.effScale = (child.trailer && child.trailer.scaleFactor) || inst.effScale;
            if (child.templateRef && nodes[child.templateRef] &&
                child.containerMeta && child.containerMeta.subtype === "INSTANCE") {
              queue.push({ instId: cloneId, tplSide: lastSegId });
            } else {
              walk.push({ tplId: childTplId, cloneId: cloneId, tplPath: overrideKey !== childTplId && nodes[overrideKey] ? overrideKey : childTplId });
            }
          }
        }
      }
      return added;
    }

    // Shallow instance records omit everything the component already defines
    // (name, paints, stroke fields, corner/layout meta). Fill those gaps from
    // the template chain (tag 1a, followed transitively).
    function mgInheritFromTemplate(nodes) {
      for (const id of Object.keys(nodes)) {
        const n = nodes[id];
        if (!n || !n.templateRef) continue;
        // Positional/slot fields (constraints, visibility) belong to the
        // template CHILD this record overrides — the last path segment — not
        // to the component the tag-1a chain leads to.
        const lastSeg = id.indexOf("/") >= 0 ? id.slice(id.lastIndexOf("/") + 1) : null;
        const slot = lastSeg && lastSeg !== id ? nodes[lastSeg] : null;
        if (slot && slot !== n) {
          if (n.constraintH === undefined && slot.constraintH !== undefined) n.constraintH = slot.constraintH;
          if (n.constraintV === undefined && slot.constraintV !== undefined) n.constraintV = slot.constraintV;
          if (n.visibleByte === undefined && slot.visibleByte !== undefined) n.visibleByte = slot.visibleByte;
          if (!n.tplW && slot.w) { n.tplW = slot.w; n.tplH = slot.h; }
          // A shallow boolean override omits the operation kind (`01 00` with
          // no `02`), decoding as GROUP; the slot record has the real subtype.
          if (n.containerMeta && n.containerMeta.subtype === "GROUP" &&
              slot.containerMeta && slot.containerMeta.subtype === "BOOLEAN_OPERATION") {
            n.containerMeta = slot.containerMeta;
          }
        }
        let t = nodes[n.templateRef];
        let guard = 0;
        while (t && guard++ < 6) {
          if (n.name == null && t.name != null) n.name = t.name;
          if (!n.paintRef && t.paintRef) n.paintRef = t.paintRef;
          if (!n.strokeRef && t.strokeRef) n.strokeRef = t.strokeRef;
          if (!n.cornerRef && t.cornerRef) n.cornerRef = t.cornerRef;
          if (!n.strokeWeightExplicit && t.strokeWeightExplicit) {
            n.strokeWeight = t.strokeWeight;
            n.strokeWeightExplicit = true;
            n.strokeWeightInherited = true;
          }
          if (n.strokeAlignByte === undefined && t.strokeAlignByte !== undefined) n.strokeAlignByte = t.strokeAlignByte;
          if (n.strokeJoinByte === undefined && t.strokeJoinByte !== undefined) n.strokeJoinByte = t.strokeJoinByte;
          if (n.constraintH === undefined && t.constraintH !== undefined) n.constraintH = t.constraintH;
          if (n.constraintV === undefined && t.constraintV !== undefined) n.constraintV = t.constraintV;
          if (n.visibleByte === undefined && t.visibleByte !== undefined) n.visibleByte = t.visibleByte;
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
          if (n.cornerRadius === 0 && t.cornerRadius) n.cornerRadius = t.cornerRadius;
          if (!n.inheritedMeta && t.containerMeta &&
              (t.containerMeta.subtype === "COMPONENT" || t.containerMeta.subtype === "FRAME")) {
            n.inheritedMeta = t.containerMeta;
          }
          if (!n.inheritedTrailer && t.trailer) n.inheritedTrailer = t.trailer;
          t = t.templateRef ? nodes[t.templateRef] : null;
        }
      }
    }

    // The document header lists the real MasterGo pages as records shaped
    // `\x01 <id> \x00 \x02 <name> \x00 \x03`. Node records share that shape but
    // their `\x02` value is an id, so keep only records whose name is not an id.
    function parseMgPages(bytes, headerEnd) {
      const pages = [];
      const seen = {};
      // Node ids look like `2:1010` or slash-composed `2:1010/2:0162`; page ids
      // can additionally be short tokens like `M` (share/partial exports).
      const idRe = /^(?:[0-9]+:[0-9A-Za-z]+(?:\/[0-9]+:[0-9A-Za-z]+)*|[A-Za-z][0-9A-Za-z]{0,7})$/;
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
              if (!seen[id]) { seen[id] = true; pages.push({ id: id, name: name, code: code }); }
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

    function convertMgPackageToV2Entries(zipEntries, fileName) {
      const documentBytes = getEntryByName(zipEntries, "document");
      if (!documentBytes) throw new Error(`"${fileName}" 不是有效的 .mg 文件（缺少 document）`);

      let meta = {};
      const metaBytes = getEntryByName(zipEntries, "meta.json");
      if (metaBytes) { try { meta = JSON.parse(decodeUtf8(metaBytes)); } catch (e) { /* ignore */ } }

      const { nodes, paints, geoms, fontStyles, effectTable } = mgDecodeNativeNodes(documentBytes);
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
      mgInheritFromTemplate(nodes);
      if (expandedTemplateCount > 0) {
        nodeIds = Object.keys(nodes);
        rebuildChildIds();
      }
      const expandedInstanceCount = mgExpandInstanceLikeNodes(nodes, childIds);
      if (expandedInstanceCount > 0) {
        nodeIds = Object.keys(nodes);
        rebuildChildIds();
      }
      const indexInParent = {};
      for (const p in childIds) childIds[p].forEach((cid, ix) => { indexInParent[cid] = ix; });

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
        const roots = (childIds[pg.id] || []).filter(r => nodes[r] && nodes[r].type && !isComponentMaster(r));
        let count = 0;
        for (const r of roots) for (const id of subtreeOf(r)) { if (!reachable[id]) { reachable[id] = true; count++; } }
        // Keep empty pages too: MasterGo files legitimately contain pages with
        // no layers (e.g. a leftover "Temp" page) and the v2 baseline exports them.
        if (count > 0 || roots.length === 0) pageList.push({ name: pg.name, roots: roots, count: count });
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
        delete props.__nativeContainerLayout;
        records.push({
          version: 2,
          id: id,
          pageId: "",
          parentId: (nodes[n.parent] ? n.parent : null),
          index: rootIndexOverride[id] != null ? rootIndexOverride[id] : (indexInParent[id] || 0),
          name: n.name || id,
          childIds: (childIds[id] || []).filter(c => nodes[c] && nodes[c].type),
          props: props
        });
      }
      // Children of a GROUP whose nearest non-group ancestor is an auto-layout
      // frame report layoutPositioning=ABSOLUTE in the v2 export.
      const recordsByIdPre = {};
      for (const record of records) recordsByIdPre[record.id] = record;
      for (const record of records) {
        if (record.props && record.props.type === "SLICE") continue;
        const parent = record.parentId ? recordsByIdPre[record.parentId] : null;
        if (!parent || !parent.props || parent.props.type !== "GROUP") continue;
        let anc = parent;
        while (anc && anc.props && anc.props.type === "GROUP") {
          anc = anc.parentId ? recordsByIdPre[anc.parentId] : null;
        }
        if (anc && anc.props && anc.props.layout && anc.props.layout.layoutMode && anc.props.layout.layoutMode !== "NONE") {
          if (record.props && record.props.layout) record.props.layout.layoutPositioning = "ABSOLUTE";
        }
      }
      mgApplyButtonInstanceTextCentering(records);
      mgApplyCardInstanceOverrides(records);
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
        const folder = `pages/page-${pi}`;
        const pageFile = `${folder}/index.json`;
        const pageId = `mgpage-${pi}`;
        const layerChunks = writeLayerChunks(folder, pageId, collectPageRecords(pg));
        out[pageFile] = encoder.encode(JSON.stringify({
          schema: "mastergo2figma.page.v2",
          version: 2,
          id: pageId,
          name: pg.name,
          folder: folder,
          rootNodeIds: pg.roots,
          layerChunks: layerChunks,
          layerCount: pg.count
        }));
        manifestPages.push({ id: pageId, name: pg.name, folder: folder, pageFile: pageFile, layerCount: pg.count });
        totalLayerCount += pg.count;
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
    convertMgPackageToV2Entries: convertMgPackageToV2Entries
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = global.MasterGoMg;
  }
})(typeof window !== "undefined" ? window : globalThis);
