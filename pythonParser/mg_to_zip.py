#!/usr/bin/env python3
"""Convert a native MasterGo .mg file into a plugin-importable v2 .zip package.

This Python CLI intentionally reuses the JavaScript decoder used by the plugin
(`ReceiveFromMasterGo/src/ui/mgPackage.js`) so the standalone conversion and the
plugin import path stay behaviorally identical.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DECODER = ROOT / "ReceiveFromMasterGo" / "src" / "ui" / "mgPackage.js"


NODE_RUNNER = r"""
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const inputPath = process.argv[2];
const outputPath = process.argv[3];
const decoderPath = process.argv[4];
const fileName = process.argv[5] || "input.mg";

const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const zipEntries = {};
for (const key of Object.keys(payload.entries || {})) {
  zipEntries[key] = new Uint8Array(Buffer.from(payload.entries[key], "base64"));
}

const sandbox = {
  console,
  TextDecoder,
  TextEncoder,
  Uint8Array,
  ArrayBuffer,
  DataView,
  Date,
  RegExp,
  JSON,
  Math,
  Number,
  String,
  Boolean,
  Object,
  Array,
  Error,
  Promise,
  setTimeout,
  clearTimeout,
  window: {}
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(decoderPath, "utf8"), sandbox, { filename: decoderPath });

const converter = sandbox.window && sandbox.window.MasterGoMg;
if (!converter || typeof converter.convertMgPackageToV2Entries !== "function") {
  throw new Error(`Decoder did not expose window.MasterGoMg.convertMgPackageToV2Entries: ${decoderPath}`);
}

const outEntries = converter.convertMgPackageToV2Entries(zipEntries, fileName);
const encoded = {};
for (const key of Object.keys(outEntries)) {
  encoded[key] = Buffer.from(outEntries[key]).toString("base64");
}

fs.writeFileSync(outputPath, JSON.stringify({ entries: encoded }));
"""


def read_zip_entries(path: Path) -> dict[str, bytes]:
    try:
        with zipfile.ZipFile(path, "r") as zf:
            return {
                info.filename: zf.read(info.filename)
                for info in zf.infolist()
                if not info.is_dir()
            }
    except zipfile.BadZipFile as exc:
        raise SystemExit(f"Not a valid .mg/.zip package: {path}") from exc


def write_zip_entries(entries: dict[str, bytes], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name in sorted(entries.keys()):
            zf.writestr(name, entries[name])


def convert_with_js_decoder(
    mg_path: Path,
    output_path: Path,
    decoder_path: Path,
    node_bin: str,
) -> None:
    if not decoder_path.is_file():
        raise SystemExit(f"Decoder not found: {decoder_path}")

    source_entries = read_zip_entries(mg_path)
    payload = {
        "entries": {
            name: base64.b64encode(data).decode("ascii")
            for name, data in source_entries.items()
        }
    }

    with tempfile.TemporaryDirectory(prefix="mg-to-zip-") as tmp:
        tmp_path = Path(tmp)
        input_json = tmp_path / "input.json"
        output_json = tmp_path / "output.json"
        runner_js = tmp_path / "runner.js"
        input_json.write_text(json.dumps(payload), encoding="utf-8")
        runner_js.write_text(NODE_RUNNER, encoding="utf-8")

        try:
            subprocess.run(
                [
                    node_bin,
                    str(runner_js),
                    str(input_json),
                    str(output_json),
                    str(decoder_path),
                    mg_path.name,
                ],
                check=True,
            )
        except FileNotFoundError as exc:
            raise SystemExit(f"Node.js executable not found: {node_bin}") from exc
        except subprocess.CalledProcessError as exc:
            raise SystemExit(f"Decoder failed with exit code {exc.returncode}") from exc

        converted = json.loads(output_json.read_text(encoding="utf-8"))
        out_entries = {
            name: base64.b64decode(data)
            for name, data in converted.get("entries", {}).items()
        }

    if "manifest.json" not in out_entries:
        raise SystemExit("Conversion failed: output package is missing manifest.json")
    write_zip_entries(out_entries, output_path)


def default_output_path(input_path: Path) -> Path:
    return input_path.with_name(f"{input_path.stem}-mastergo2figma.zip")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert a native MasterGo .mg file into a MasterGo2Figma v2 import zip.",
    )
    parser.add_argument("input", type=Path, help="Path to the source .mg file")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="Output .zip path. Defaults to <input>-mastergo2figma.zip",
    )
    parser.add_argument(
        "--decoder",
        type=Path,
        default=DEFAULT_DECODER,
        help=f"Path to mgPackage.js decoder (default: {DEFAULT_DECODER})",
    )
    parser.add_argument(
        "--node",
        default=os.environ.get("NODE", "node"),
        help="Node.js executable to use (default: NODE env or 'node')",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    input_path = args.input.resolve()
    if not input_path.is_file():
        raise SystemExit(f"Input file not found: {input_path}")

    output_path = (args.output or default_output_path(input_path)).resolve()
    convert_with_js_decoder(input_path, output_path, args.decoder.resolve(), args.node)
    print(f"Wrote {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
