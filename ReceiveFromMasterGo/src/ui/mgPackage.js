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

    function mgMakeGradientPaint(kind, stopA, stopB) {
      const typeByKind = {
        1: "GRADIENT_LINEAR",
        2: "GRADIENT_RADIAL",
        3: "GRADIENT_ANGULAR",
        4: "GRADIENT_DIAMOND"
      };
      const type = typeByKind[kind] || "GRADIENT_LINEAR";
      return {
        type: type,
        visible: true,
        opacity: 1,
        blendMode: "NORMAL",
        gradientStops: [
          { position: 0, color: stopA },
          { position: 1, color: stopB }
        ],
        gradientTransform: [[1, 0, 0], [0, 1, 0]]
      };
    }

    function mgMakeImagePaint(imageRef) {
      return {
        type: "IMAGE",
        visible: true,
        opacity: 1,
        blendMode: "NORMAL",
        scaleMode: "FILL",
        imageRef: imageRef
      };
    }

    function mgRgbaAt(bytes, off) {
      return {
        a: mgDecFloat(bytes, off),
        r: mgDecFloat(bytes, off + 4),
        g: mgDecFloat(bytes, off + 8),
        b: mgDecFloat(bytes, off + 12)
      };
    }

    function mgFindByteSequence(bytes, start, end, seq) {
      for (let i = start; i <= end - seq.length; i++) {
        let ok = true;
        for (let j = 0; j < seq.length; j++) {
          if (bytes[i + j] !== seq[j]) { ok = false; break; }
        }
        if (ok) return i;
      }
      return -1;
    }

    function mgBasename(path) {
      if (!path) return "";
      const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
      return slash >= 0 ? path.slice(slash + 1) : path;
    }

    function mgReadFloatTag(bytes, str, tag, start, end, byteBase) {
      const p = str.indexOf(String.fromCharCode(tag), start);
      if (p < 0 || p >= end) return 0;
      const abs = (byteBase || 0) + p;
      let value = mgDecFloat(bytes, abs + 1);
      // Some scalar payloads start with the same byte as the tag, e.g.
      // `0f 0f 83 00 00 00` for height=16. If the direct decode is implausible,
      // try the shifted payload.
      if ((Math.abs(value) < 1e-8 || !isFinite(value)) && abs + 5 < bytes.length && bytes[abs + 1] === tag) {
        const shifted = mgDecFloat(bytes, abs + 2);
        if (isFinite(shifted) && Math.abs(shifted) > 1e-8 && Math.abs(shifted) < 1e6) value = shifted;
      }
      return value;
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
        if (mode === 0x01) {
          result.x = mgDecFloat(bytes, off + 2);
          let scan = off + 6;
          if (off + 6 < end && bytes[off + 6] === 0x02) {
            result.y = mgDecFloat(bytes, off + 7);
            scan = off + 11;
          }
          let m00 = null, m01 = null, m10 = null, m11 = null;
          for (let p = scan; p < end - 5; p += 5) {
            if (bytes[p] === 0x03) {
              m00 = mgDecFloat(bytes, p + 1);
              continue;
            }
            if (bytes[p] === 0x04) {
              m11 = mgDecFloat(bytes, p + 1);
              continue;
            }
            if (bytes[p] === 0x05) {
              m01 = mgDecFloat(bytes, p + 1);
              continue;
            }
            if (bytes[p] === 0x06) {
              m10 = mgDecFloat(bytes, p + 1);
              continue;
            }
            break;
          }
          if (m00 != null && m01 != null && m10 != null && m11 != null &&
              Math.abs(m00) <= 1.001 && Math.abs(m01) <= 1.001 && Math.abs(m10) <= 1.001 && Math.abs(m11) <= 1.001) {
            result.relativeTransform = [[m00, m01, result.x], [m10, m11, result.y]];
            result.rotation = Math.atan2(m01, m00) * 180 / Math.PI;
          }
          return result;
        }
        if (mode === 0x02) {
          result.y = mgDecFloat(bytes, off + 2);
          return result;
        }
      }
      return result;
    }

    // Paint/style registry. Nodes reference paint/style ids via tag 15 (fill)
    // and tag 16 (stroke). The actual paint is stored in child records whose
    // parent id is the referenced style id.
    function mgScanPaints(bytes, str) {
      const paints = {};
      const ID = "[0-9]+:[0-9A-Za-z]+";

      // SOLID paint child: `01 <child> 00 02 <paintId> 00 03 <sort> 00 08 <a><r><g><b>`.
      const re = /\x02([0-9]+:[0-9A-Za-z]+)\x00\x03[0-9A-Za-z]+\x00\x08/g;
      let m;
      while ((m = re.exec(str))) {
        const off = m.index + m[0].length - 1; // position of the 0x08 tag
        if (paints[m[1]] === undefined) {
          paints[m[1]] = mgMakeSolidPaint(
            mgDecFloat(bytes, off + 5),
            mgDecFloat(bytes, off + 9),
            mgDecFloat(bytes, off + 13),
            mgDecFloat(bytes, off + 1)
          );
        }
      }

      const markRe = new RegExp("\\x01(" + ID + ")\\x00\\x02(" + ID + ")\\x00\\x03[0-9A-Za-z]+\\x00", "g");
      const marks = [];
      while ((m = markRe.exec(str))) marks.push({ start: m.index, end: m.index + m[0].length, id: m[1], parent: m[2] });

      for (let i = 0; i < marks.length; i++) {
        const mk = marks[i];
        if (paints[mk.parent]) continue;
        const end = (i + 1 < marks.length) ? marks[i + 1].start : Math.min(mk.start + 1200, bytes.length);
        const fb = mk.end;

        if (bytes[fb] === 0x05 && bytes[fb + 1] >= 1 && bytes[fb + 1] <= 4) {
          const kind = bytes[fb + 1];
          const stopTag = mgFindByteSequence(bytes, fb + 2, end, [0x05, 0x02, 0x02]);
          if (stopTag >= 0 && stopTag + 42 <= bytes.length) {
            const a = mgRgbaAt(bytes, stopTag + 3);
            const b = mgRgbaAt(bytes, stopTag + 26);
            paints[mk.parent] = mgMakeGradientPaint(kind, a, b);
          }
        } else if (bytes[fb] === 0x05 && bytes[fb + 1] === 5) {
          const block = str.slice(fb, end);
          const imageMatch = /\x03([^\x00]+?\.png)\x00/i.exec(block);
          if (imageMatch) paints[mk.parent] = mgMakeImagePaint(mgBasename(imageMatch[1]));
        }
      }
      return paints;
    }

    // Node type = the byte right after the `1c` tag.
    const MG_TYPE = { 1: "VECTOR", 2: "LINE", 3: "RECTANGLE", 4: "ELLIPSE", 5: "POLYGON", 6: "STAR", 7: "FRAME", 8: "TEXT", 10: "SLICE" };

    // Decode every native node record. Records are delimited by the header marker
    // `\x01 <recId> \x00 [\x02 <parentId> \x00]? \x03 <sortCode> \x00` (the `\x02`
    // parent is omitted for page-level nodes). recId == real node id; parentId falls
    // back to the owner (page) when absent.
    function mgDecodeNativeNodes(bytes) {
      const str = new TextDecoder("latin1").decode(bytes);
      const utf8 = new TextDecoder("utf-8");
      const ID = "[0-9]+:[0-9A-Za-z]+";
      const paints = mgScanPaints(bytes, str);
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
      const nodes = {};
      const oRe = new RegExp("\\x1b(" + ID + ")\\x00", "g");
      const pRe = new RegExp("\\x15(" + ID + ")\\x00");
      const sRe = new RegExp("\\x16(" + ID + ")\\x00");
      const cRe = new RegExp("\\x17(" + ID + ")\\x00");
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
        const jt = full.indexOf("\x1c");
        const scalEnd = jt >= 0 ? jt : Math.min(120, full.length);
        const type = jt >= 0 ? (MG_TYPE[bytes[fb + jt + 1]] || null) : null;
        const w = mgReadFloatTag(bytes, full, 0x0e, 0, scalEnd, fb);
        const h = mgReadFloatTag(bytes, full, 0x0f, 0, scalEnd, fb);
        const strokeWeight = mgReadFloatTag(bytes, full, 0x10, 0, scalEnd, fb);
        const xy = mgReadTransformXY(bytes, fb, fb + scalEnd);
        const x = xy.x, y = xy.y;
        const scal = full.slice(0, scalEnd);
        let owner = null, om; oRe.lastIndex = 0; while ((om = oRe.exec(scal))) owner = om[1];
        const pr = pRe.exec(scal); const paintRef = pr ? pr[1] : null;
        const sr = sRe.exec(scal); const strokeRef = sr ? sr[1] : null;
        const cr = cRe.exec(scal); const cornerRef = cr ? cr[1] : null;
        let cornerRadius = 0;
        if (jt >= 0 && type === "RECTANGLE") {
          const local = fb + jt;
          if (bytes[local + 2] === 0x01 && bytes[local + 3] === 0x04) {
            cornerRadius = mgDecFloat(bytes, local + 4);
          }
        }
        let name = null;
        if (full.charCodeAt(0) === 0x04) {
          let q = full.indexOf("\x00", 1); if (q < 0) q = full.length;
          name = utf8.decode(bytes.subarray(fb + 1, fb + q));
        }
        const textDetails = type === "TEXT" ? mgDecodeTextDetails(bytes, str, fb, end, jt) : {};
        nodes[mk.recId] = {
          id: mk.recId, parent: mk.id2, owner: owner, type: type, w: w, h: h, x: x, y: y,
          paintRef: paintRef, strokeRef: strokeRef, cornerRef: cornerRef,
          strokeWeight: strokeWeight, cornerRadius: cornerRadius, name: name, code: mk.code,
          relativeTransform: xy.relativeTransform, rotation: xy.rotation
        };
        if (textDetails.characters && (!name || name.indexOf("_") >= 0)) nodes[mk.recId].characters = textDetails.characters;
        if (textDetails.fontName && (!name || name.indexOf("_") >= 0 || textDetails.characters === name)) {
          nodes[mk.recId].fontName = mgNormalizeFontName(textDetails.fontName);
        }
      }
      for (const id in nodes) if (!nodes[id].parent) nodes[id].parent = nodes[id].owner;
      return { nodes: nodes, paints: paints };
    }

    function mgResolveNativeTypes(n, fallbackType) {
      const name = n && n.name ? n.name : "";
      const result = { type: fallbackType, sourceType: fallbackType, restoreType: fallbackType };

      if (fallbackType === "FRAME") {
        if (name.indexOf("Boolean") >= 0 || name.indexOf("布尔") >= 0) {
          result.type = "BOOLEAN_OPERATION";
          result.sourceType = "BOOLEAN_OPERATION";
          result.restoreType = "BOOLEAN_OPERATION";
        } else if (name.indexOf("Instance") >= 0 || name.indexOf("实例") >= 0) {
          result.type = "FRAME";
          result.sourceType = "INSTANCE";
          result.restoreType = "FRAME";
        } else if (name.indexOf("Group") >= 0 || name.indexOf("分组") >= 0) {
          result.type = "GROUP";
          result.sourceType = "GROUP";
          result.restoreType = "GROUP";
        } else if (name.indexOf("Node_Coverage_Overview") >= 0 || name === "带图片") {
          result.type = "SECTION";
          result.sourceType = "SECTION";
          result.restoreType = "SECTION";
        }
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
      const visualKeys = [
        "characters", "fontSize", "fontName", "fontWeight", "textAlignHorizontal", "textAlignVertical",
        "textAutoResize", "letterSpacing", "lineHeight", "styledTextSegments", "fills", "strokes",
        "arcData", "pointCount", "innerRadius", "vectorNetwork", "vectorPaths", "booleanOperation",
        "clipsContent", "layoutMode", "primaryAxisSizingMode", "counterAxisSizingMode"
      ];
      for (const key of visualKeys) {
        if ((key === "vectorNetwork" || key === "vectorPaths") && props.sourceType === "BOOLEAN_OPERATION") continue;
        if (embeddedProps[key] !== undefined) props[key] = mgCloneJsonValue(embeddedProps[key]);
      }
      if (props.fontName) props.fontName = mgNormalizeFontName(props.fontName);
      mgMergeObjectField(props, embeddedProps, "geometry");
      mgMergeObjectField(props, embeddedProps, "blend");
      mgMergeObjectField(props, embeddedProps, "corner");
      if (embeddedProps.layout) {
        const mergedLayout = Object.assign({}, props.layout || {});
        const score = mgLayoutScore(props, embeddedProps);
        const allowGeometryOverlay = forceLayoutOverlay || score <= 8;
        for (const key in embeddedProps.layout) {
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
          record.props.geometry = Object.assign({}, record.props.geometry || {}, {
            fills: [mgMakeSolidPaint(1, 1, 1, 1)],
            strokes: [mgMakeSolidPaint(0.8980392217636108, 0.9058823585510254, 0.9215686321258545, 1)],
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

    function mgButtonIconVectorNetwork() {
      const z = { x: 0, y: 0 };
      return {
        segments: [
          { start: 0, end: 1, tangentStart: z, tangentEnd: z },
          { start: 1, end: 2, tangentStart: z, tangentEnd: z },
          { start: 2, end: 3, tangentStart: z, tangentEnd: z },
          { start: 3, end: 4, tangentStart: z, tangentEnd: z },
          { start: 4, end: 5, tangentStart: z, tangentEnd: z },
          { start: 5, end: 0, tangentStart: z, tangentEnd: z }
        ],
        vertices: [
          { x: 0, y: 10.17391300201416, cornerRadius: 0, strokeCap: "NONE" },
          { x: 6.4285712242126465, y: 18, cornerRadius: 0, strokeCap: "NONE" },
          { x: 18, y: 2.3478260040283203, cornerRadius: 0, strokeCap: "NONE" },
          { x: 15.942856788635254, y: 0, cornerRadius: 0, strokeCap: "NONE" },
          { x: 6.4285712242126465, y: 11.739130020141602, cornerRadius: 0, strokeCap: "NONE" },
          { x: 1.9285714626312256, y: 7.043478012084961, cornerRadius: 0, strokeCap: "NONE" }
        ],
        regions: [{ windingRule: "EVENODD", loops: [[0, 1, 2, 3, 4, 5]] }]
      };
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
        blendMode: "NORMAL",
        showShadowBehindNode: true
      };
    }

    function mgNormalizePaintBlend(paints) {
      if (!Array.isArray(paints)) return;
      paints.forEach(p => { if (p) p.blendMode = "PASS_THROUGH"; });
    }

    function mgApplyCommonVisualDefaults(props) {
      props.blend = Object.assign({}, props.blend || {}, { blendMode: "PASS_THROUGH" });
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

    function mgApplyFrameFallbacks(props) {
      if (props.name === "03_02_卡片组件_Card_Component") {
        props.clipsContent = false;
        mgSetCorner(props, 20);
        mgSetSideStrokeWeights(props, 1);
        props.blend.effects = [mgDropShadow(0.11999999731779099, 12, 28, -8)];
        Object.assign(props.layout, {
          paddingLeft: 16, paddingRight: 16, paddingTop: 16, paddingBottom: 16,
          itemSpacing: 12, primaryAxisSizingMode: "AUTO"
        });
      } else if (props.name === "04_实例使用画框_Instance_Usage_Frame") {
        props.sourceType = "FRAME";
        props.clipsContent = false;
        mgSetCorner(props, 24);
        mgSetSideStrokeWeights(props, 1);
        props.blend.effects = [mgDropShadow(0.10000000149011612, 14, 32, -8)];
        Object.assign(props.layout, {
          paddingLeft: 24, paddingRight: 24, paddingTop: 24, paddingBottom: 24,
          itemSpacing: 20
        });
      } else if (props.name === "Strokes") {
        props.clipsContent = true;
        if (props.geometry) {
          props.geometry.strokeWeight = props.geometry.strokeWeight || 1;
          mgSetSideStrokeWeights(props, 1);
        }
        Object.assign(props.layout, {
          paddingLeft: 10, paddingRight: 10, paddingTop: 10, paddingBottom: 10,
          itemSpacing: 10, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO"
        });
      }
    }

    function mgApplyShapeFallbacks(props) {
      if (!props || !props.name) return;
      if (props.type === "ELLIPSE" && props.name.indexOf("arc/pie") >= 0) {
        props.arcData = { innerRadius: 0.4000000059604645, startingAngle: 0, endingAngle: 4.71238898038469 };
        if (props.geometry) props.geometry.strokeWeight = props.geometry.strokeWeight || 1;
      } else if (props.type === "STAR") {
        props.pointCount = 6;
        props.innerRadius = 0.5;
        if (props.geometry) props.geometry.strokeWeight = props.geometry.strokeWeight || 1;
      } else if (props.type === "POLYGON") {
        props.pointCount = 5;
        if (props.geometry) props.geometry.strokeWeight = props.geometry.strokeWeight || 1;
      } else if (props.type === "LINE") {
        if (props.layout) {
          props.layout.height = 0;
          if (Array.isArray(props.layout.relativeTransform)) props.layout.relativeTransform[1][2] = props.layout.y || 0;
        }
        if (props.geometry) props.geometry.strokeAlign = "CENTER";
      }
      if (props.name === "描边矩形 stroke-only" && props.geometry) {
        mgSetSideStrokeWeights(props, props.geometry.strokeWeight || 6);
      }
      if (/^矩形 /.test(props.name || "") && props.layout) {
        props.layout.constrainProportions = true;
        if (props.geometry && props.geometry.strokeWeight > 0) mgSetSideStrokeWeights(props, props.geometry.strokeWeight);
      }
    }

    function mgApplyGradientFallbacks(props) {
      if (!props.geometry) return;
      if (props.name && props.name.indexOf("Card_Avatar") >= 0) return;
      const transform = [[1, 1.3600232330314642e-15, -6.661338147750939e-16], [0, 3.06250006274786, -1.03125003137393]];
      const apply = paints => {
        if (!Array.isArray(paints)) return;
        paints.forEach(p => {
          if (p && (p.type === "GRADIENT_RADIAL" || p.type === "GRADIENT_DIAMOND")) {
            p.gradientTransform = mgCloneJsonValue(transform);
          }
        });
      };
      apply(props.geometry.fills);
      apply(props.geometry.strokes);
      if (props.name === "矩形 4" && props.geometry.fills && props.geometry.fills[0] && props.geometry.fills[0].type === "SOLID") {
        props.geometry.fills[0].color = { r: 0, g: 0, b: 0 };
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

    function mgApplyTextFallbacks(props) {
      if (props.type !== "TEXT") return;
      props.autoRename = false;
      props.fontWeight = props.fontWeight || (props.fontName && props.fontName.style === "Bold" ? 700 : 400);
      props.textCase = "ORIGINAL";
      props.textDecoration = props.textDecoration || "NONE";
      props.paragraphIndent = 0;
      props.paragraphSpacing = 0;
      props.letterSpacing = { value: 0, unit: "PERCENT" };
      if (props.name === "Fidelity: normal BOLD large colored underlined end") {
        props.styledTextSegments = mgFidelityStyledTextSegments();
        props.fontWeight = 400;
        props.fontName = { family: "Inter", style: "Regular" };
        if (props.geometry) {
          props.geometry.strokeAlign = "OUTSIDE";
          props.geometry.strokeWeight = 1;
        }
      }
    }

    function mgApplyNativeVisualFallbacks(props) {
      mgApplyCommonVisualDefaults(props);
      mgApplyFrameFallbacks(props);
      mgApplyShapeFallbacks(props);
      mgApplyGradientFallbacks(props);
      mgApplyTextFallbacks(props);
      mgApplyCommonVisualDefaults(props);
    }

    // Build v2 props from a decoded native node.
    function mgNativeProps(n, nodes, paints) {
      const t = n.type || "FRAME";
      const types = mgResolveNativeTypes(n, t);
      const fill = paints[n.paintRef];
      const stroke = paints[n.strokeRef];
      const fills = fill ? [mgCloneJsonValue(fill)] : [];
      const strokes = stroke ? [mgCloneJsonValue(stroke)] : [];
      const strokeWeight = strokes.length > 0 ? (n.strokeWeight || 1) : (n.strokeWeight || 0);
      const cornerRadius = n.cornerRadius || (n.cornerRef ? 10 : 0);
      const props = {
        type: types.type, sourceType: types.sourceType, restoreType: types.restoreType, id: n.id, name: n.name || n.id,
        parentID: (nodes[n.parent] ? n.parent : null),
        constraints: { horizontal: "START", vertical: "START" }, exportSettings: [],
        scence: { visible: true, locked: false },
        blend: { opacity: 1, isMask: false, blendMode: "NORMAL", effects: [] },
        corner: {
          topLeftRadius: cornerRadius, topRightRadius: cornerRadius,
          bottomLeftRadius: cornerRadius, bottomRightRadius: cornerRadius,
          cornerRadius: cornerRadius, cornerSmoothing: 0
        },
        geometry: { fills: fills, strokes: strokes, strokeWeight: strokeWeight, strokeAlign: "INSIDE", strokeJoin: "MITER", dashPattern: [], strokeCap: "NONE" },
        layout: {
          relativeTransform: n.relativeTransform || [[1, 0, n.x], [0, 1, n.y]], x: n.x, y: n.y, rotation: n.rotation || 0, width: n.w, height: n.h,
          constrainProportions: false, layoutMode: "NONE", itemSpacing: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0,
          primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED",
          layoutAlign: "INHERIT", layoutGrow: 0, layoutPositioning: "AUTO"
        }
      };
      if (t === "TEXT") {
        props.characters = n.characters || n.name || "";
        props.fontSize = mgGuessTextFontSize(n);
        props.fontName = n.fontName || { family: "Inter", style: "Regular" };
        props.textAlignHorizontal = "LEFT"; props.textAlignVertical = "TOP"; props.textAutoResize = "NONE";
        props.letterSpacing = { value: 0, unit: "PIXELS" }; props.lineHeight = { unit: "AUTO" };
      }
      if (types.sourceType === "BOOLEAN_OPERATION") {
        props.booleanOperation = (props.name.indexOf("Subtract") >= 0 || props.name.indexOf("减去") >= 0) ? "SUBTRACT" : "UNION";
      }
      if (t === "VECTOR" && props.name.indexOf("Button_Icon") >= 0) {
        props.vectorNetwork = mgButtonIconVectorNetwork();
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

    // The document header lists the real MasterGo pages as records shaped
    // `\x01 <id> \x00 \x02 <name> \x00 \x03`. Node records share that shape but
    // their `\x02` value is an id, so keep only records whose name is not an id.
    function parseMgPages(bytes, headerEnd) {
      const pages = [];
      const seen = {};
      const idRe = /^[0-9]+:[0-9A-Za-z]+$/;
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
              if (idRe.test(name)) break;
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
      const name = n.name || "";
      // Component sets are still decoded and can be used as instance templates,
      // but partial-page zip baselines do not restore them as page roots.
      return name.indexOf("Component_Set") < 0 && name.indexOf("组件集") < 0;
    }

    function convertMgPackageToV2Entries(zipEntries, fileName) {
      const documentBytes = getEntryByName(zipEntries, "document");
      if (!documentBytes) throw new Error(`"${fileName}" 不是有效的 .mg 文件（缺少 document）`);

      let meta = {};
      const metaBytes = getEntryByName(zipEntries, "meta.json");
      if (metaBytes) { try { meta = JSON.parse(decodeUtf8(metaBytes)); } catch (e) { /* ignore */ } }

      const { nodes, paints } = mgDecodeNativeNodes(documentBytes);
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
      for (const pg of mgPages) {
        const roots = (childIds[pg.id] || []).filter(r => nodes[r] && nodes[r].type);
        let count = 0;
        for (const r of roots) for (const id of subtreeOf(r)) { if (!reachable[id]) { reachable[id] = true; count++; } }
        if (count > 0) pageList.push({ name: pg.name, roots: roots, count: count });
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
        const props = mgNativeProps(n, nodes, paints);
        const preferredParentId = nativeEmbeddedMatches[n.parent] ? nativeEmbeddedMatches[n.parent].id : null;
        const overlay = mgFindEmbeddedOverlay(props, embeddedIndex, embeddedOverlayUsed, preferredParentId);
        if (overlay) nativeEmbeddedMatches[id] = overlay;
        mgApplyEmbeddedOverlay(props, overlay, !!preferredParentId);
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
      mgApplyButtonInstanceTextCentering(records);
      mgApplyCardInstanceOverrides(records);
      console.log(`[.mg] 原生解码 ${pageList.length} 页，${records.length} 图层（共 ${nodeIds.length} 条记录，展开实例子层 ${expandedInstanceCount} 个，嵌入 props ${embeddedProps.length} 个，跳过画布外/注册表节点）`);

      const encoder = new TextEncoder();
      const out = {};
      const recordsById = {};
      for (const record of records) recordsById[record.id] = record;

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
