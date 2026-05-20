#!/usr/bin/env python3
"""Local HTTP relay for MasterGo2Figma JSON stream exports."""

from __future__ import annotations

import argparse
import json
import posixpath
import re
import shutil
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


TRANSFER_ID_RE = re.compile(r"^[A-Za-z0-9_.-]+$")


class RelayState:
    def __init__(self, output_root: Path) -> None:
        self.output_root = output_root.resolve()
        self.transfers: dict[str, dict] = {}


def json_bytes(payload: dict) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def safe_transfer_id(value: str) -> str:
    if not value or not TRANSFER_ID_RE.match(value):
        raise ValueError("invalid transfer id")
    return value


def safe_relative_path(value: str) -> Path:
    if not value or not isinstance(value, str):
        raise ValueError("empty file path")
    if "\\" in value:
        raise ValueError("backslash is not allowed in file path")
    if value.startswith("/"):
        raise ValueError("absolute file path is not allowed")

    normalized = posixpath.normpath(value)
    if normalized in ("", ".") or normalized == ".." or normalized.startswith("../") or "/../" in normalized:
        raise ValueError("unsafe file path")
    return Path(*normalized.split("/"))


def path_within(root: Path, relative: Path) -> Path:
    target = (root / relative).resolve()
    target.relative_to(root.resolve())
    return target


class RelayHandler(BaseHTTPRequestHandler):
    server_version = "MasterGo2FigmaRelay/0.1"

    @property
    def state(self) -> RelayState:
        return self.server.state  # type: ignore[attr-defined]

    def do_OPTIONS(self) -> None:
        self.send_json({"ok": True})

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.send_json({
                "ok": True,
                "outputRoot": str(self.state.output_root),
            })
            return
        self.send_error_json(404, "not found")

    def do_POST(self) -> None:
        try:
            parsed = urlparse(self.path)
            parts = [part for part in parsed.path.split("/") if part]
            if len(parts) < 3 or parts[0] != "transfers":
                raise HttpError(404, "not found")

            transfer_id = safe_transfer_id(parts[1])
            action = "/".join(parts[2:])

            if action == "start":
                self.handle_transfer_start(transfer_id)
            elif action == "files/start":
                self.handle_file_start(transfer_id)
            elif action == "files/chunk":
                self.handle_file_chunk(transfer_id, parse_qs(parsed.query))
            elif action == "files/end":
                self.handle_file_end(transfer_id)
            elif action == "files/abort":
                self.handle_file_abort(transfer_id)
            elif action == "complete":
                self.handle_transfer_complete(transfer_id)
            else:
                raise HttpError(404, "not found")
        except HttpError as error:
            self.send_error_json(error.status, error.message)
        except Exception as error:
            self.send_error_json(500, str(error))

    def handle_transfer_start(self, transfer_id: str) -> None:
        payload = self.read_json()
        transfer_dir = (self.state.output_root / transfer_id).resolve()
        transfer_dir.mkdir(parents=True, exist_ok=True)
        transfer = {
            "id": transfer_id,
            "dir": transfer_dir,
            "filename": str(payload.get("filename") or ""),
            "files": {},
            "startedAt": payload.get("startedAt"),
            "totalBytes": 0,
        }
        self.state.transfers[transfer_id] = transfer
        self.write_metadata(transfer, "_transfer-start.json", payload)
        print(f"[relay] start {transfer_id} -> {transfer_dir}")
        self.send_json({"ok": True, "outputDir": str(transfer_dir)})

    def handle_file_start(self, transfer_id: str) -> None:
        transfer = self.require_transfer(transfer_id)
        payload = self.read_json()
        index = self.require_index(payload.get("index"))
        relative = safe_relative_path(str(payload.get("path") or ""))
        target = path_within(transfer["dir"], relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"")
        transfer["files"][index] = {
            "path": str(relative).replace("\\", "/"),
            "target": target,
            "size": int(payload.get("size") or 0),
            "totalChunks": int(payload.get("totalChunks") or 0),
            "nextChunk": 0,
            "bytes": 0,
            "ended": False,
        }
        self.send_json({"ok": True})

    def handle_file_chunk(self, transfer_id: str, query: dict[str, list[str]]) -> None:
        transfer = self.require_transfer(transfer_id)
        index = self.require_index((query.get("index") or [""])[0])
        chunk_index = self.require_index((query.get("chunkIndex") or [""])[0])
        file_state = self.require_file(transfer, index)
        if chunk_index != file_state["nextChunk"]:
            raise HttpError(409, f"unexpected chunk index {chunk_index}; expected {file_state['nextChunk']}")

        data = self.read_body()
        with file_state["target"].open("ab") as output:
            output.write(data)
        file_state["nextChunk"] += 1
        file_state["bytes"] += len(data)
        transfer["totalBytes"] += len(data)
        self.send_json({"ok": True, "bytes": file_state["bytes"]})

    def handle_file_end(self, transfer_id: str) -> None:
        transfer = self.require_transfer(transfer_id)
        payload = self.read_json()
        index = self.require_index(payload.get("index"))
        file_state = self.require_file(transfer, index)
        file_state["ended"] = True
        self.send_json({
            "ok": True,
            "path": file_state["path"],
            "bytes": file_state["bytes"],
        })

    def handle_file_abort(self, transfer_id: str) -> None:
        transfer = self.require_transfer(transfer_id)
        payload = self.read_json()
        index = self.require_index(payload.get("index"))
        if index in transfer["files"]:
            transfer["files"][index]["aborted"] = True
            transfer["files"][index]["abortReason"] = str(payload.get("reason") or "")
        self.send_json({"ok": True})

    def handle_transfer_complete(self, transfer_id: str) -> None:
        transfer = self.require_transfer(transfer_id)
        payload = self.read_json()
        pending = [
            state["path"]
            for state in transfer["files"].values()
            if not state.get("ended") and not state.get("aborted")
        ]
        if pending:
            raise HttpError(409, f"{len(pending)} files are still pending")

        summary = {
            "id": transfer_id,
            "filename": payload.get("filename") or transfer.get("filename") or "",
            "fileCount": len(transfer["files"]),
            "totalBytes": transfer["totalBytes"],
            "stats": payload.get("stats") or {},
            "isFinal": payload.get("isFinal", True),
            "completedAt": payload.get("completedAt"),
            "files": [
                {
                    "index": index,
                    "path": state["path"],
                    "bytes": state["bytes"],
                    "chunks": state["nextChunk"],
                }
                for index, state in sorted(transfer["files"].items())
            ],
        }
        self.write_metadata(transfer, "_transfer-summary.json", summary)
        zip_path = self.create_transfer_zip(transfer)
        shutil.rmtree(transfer["dir"])
        print(f"[relay] complete {transfer_id}: {summary['fileCount']} files, {summary['totalBytes']} bytes -> {zip_path}")
        self.send_json({
            "ok": True,
            "outputDir": str(transfer["dir"]),
            "zipPath": str(zip_path),
            "fileCount": summary["fileCount"],
            "totalBytes": summary["totalBytes"],
        })

    def create_transfer_zip(self, transfer: dict) -> Path:
        transfer_dir = transfer["dir"]
        zip_path = transfer_dir.with_suffix(".zip")
        if zip_path.exists():
            zip_path.unlink()
        excluded_names = {"_transfer-start.json", "_transfer-summary.json", ".DS_Store"}
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for file_path in sorted(transfer_dir.rglob("*")):
                if not file_path.is_file() or file_path.name in excluded_names:
                    continue
                archive.write(file_path, file_path.relative_to(transfer_dir).as_posix())
        return zip_path

    def require_transfer(self, transfer_id: str) -> dict:
        transfer = self.state.transfers.get(transfer_id)
        if not transfer:
            raise HttpError(404, "unknown transfer")
        return transfer

    def require_file(self, transfer: dict, index: int) -> dict:
        file_state = transfer["files"].get(index)
        if not file_state:
            raise HttpError(404, f"unknown file index {index}")
        return file_state

    def require_index(self, value) -> int:
        try:
            index = int(value)
        except Exception as error:
            raise HttpError(400, "invalid file or chunk index") from error
        if index < 0:
            raise HttpError(400, "negative file or chunk index")
        return index

    def read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length > 0 else b""

    def read_json(self) -> dict:
        body = self.read_body()
        if not body:
            return {}
        try:
            payload = json.loads(body.decode("utf-8"))
        except Exception as error:
            raise HttpError(400, "invalid JSON body") from error
        if not isinstance(payload, dict):
            raise HttpError(400, "JSON body must be an object")
        return payload

    def write_metadata(self, transfer: dict, name: str, payload: dict) -> None:
        target = path_within(transfer["dir"], Path(name))
        target.write_bytes(json_bytes(payload))

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status: int, message: str) -> None:
        self.send_json({"ok": False, "error": message}, status)

    def send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def log_message(self, fmt: str, *args) -> None:
        print(f"[relay] {self.address_string()} - {fmt % args}")


class HttpError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def main() -> None:
    parser = argparse.ArgumentParser(description="MasterGo2Figma local JSON relay")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--output", default="mastergo2figma-relay-output")
    args = parser.parse_args()

    output_root = Path(args.output).resolve()
    output_root.mkdir(parents=True, exist_ok=True)

    server = ThreadingHTTPServer((args.host, args.port), RelayHandler)
    server.state = RelayState(output_root)  # type: ignore[attr-defined]
    print(f"[relay] listening on http://{args.host}:{args.port}")
    print(f"[relay] output root: {output_root}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[relay] stopped")


if __name__ == "__main__":
    main()
