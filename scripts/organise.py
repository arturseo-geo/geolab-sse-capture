#!/usr/bin/env python3
# Copyright 2026 Artur Ferreira (The GEO Lab)
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#     http://www.apache.org/licenses/LICENSE-2.0
# See the NOTICE file distributed with this work for attribution.

"""
organise.py -- Reduce raw sse-capture output to one observation per conversation.

One ChatGPT session produces ~10 files per capture: conversation JSON at
various stages, SSE streams, conduit_token stubs, status stubs, empty lists,
sidebar item lists. This script deduplicates to the latest-state conversation
JSON per conversation_id, plus its SSE stream if present.

Originals are never modified or deleted. Organised copies go to ./organised/.
"""
import argparse
import csv
import json
import os
import shutil
import sys
from pathlib import Path


def classify_file(path):
    """Classify a .txt capture file. Returns (kind, conversation_id, update_time, size)."""
    size = path.stat().st_size

    if size < 5:
        return ("empty", None, 0, size)

    with open(path, "r", encoding="utf-8", errors="replace") as f:
        head = f.read(200)

    # SSE stream files start with "event:"
    if head.strip().startswith("event:"):
        # Try to extract conversation_id from the stream
        conv_id = None
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if '"conversation_id"' in line and line.startswith("data:"):
                    try:
                        d = json.loads(line[5:].strip())
                        conv_id = d.get("conversation_id")
                        if conv_id:
                            break
                    except (json.JSONDecodeError, ValueError):
                        pass
        return ("sse_stream", conv_id, 0, size)

    if head.strip() == "[]":
        return ("empty_list", None, 0, size)

    if head.strip() == "null":
        return ("null_stub", None, 0, size)

    if not head.strip().startswith("{"):
        return ("unknown", None, 0, size)

    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            data = json.load(f)
    except (json.JSONDecodeError, ValueError):
        return ("json_error", None, 0, size)

    # Stubs: conduit_token + status
    if set(data.keys()) <= {"conduit_token", "status"}:
        return ("conduit_stub", None, 0, size)

    # Status-only stubs
    if set(data.keys()) <= {"status"}:
        return ("status_stub", None, 0, size)

    # Sidebar item lists
    if set(data.keys()) <= {"items", "total", "limit", "offset", "cursor", "has_missing_conversations"}:
        return ("sidebar_list", None, 0, size)

    # Completions stubs
    if set(data.keys()) <= {"completions"}:
        return ("completions_stub", None, 0, size)

    # Detail error stubs
    if set(data.keys()) <= {"detail"}:
        return ("detail_stub", None, 0, size)

    # Conversation JSON -- the target
    conv_id = data.get("conversation_id")
    update_time = data.get("update_time", 0) or 0
    if conv_id:
        return ("conversation", conv_id, update_time, size)

    return ("other_json", None, 0, size)


def load_manifest(manifest_path):
    """Load manifest.csv and return a dict keyed by conversation_id."""
    rows = {}
    if not manifest_path.exists():
        return rows
    with open(manifest_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            cid = row.get("conversation_id", "").strip()
            if cid:
                rows[cid] = row
    return rows


def build_output_name(conv_id, manifest_row):
    """Build a deterministic filename from manifest data."""
    short_id = conv_id[:8]
    if manifest_row:
        pid = manifest_row.get("prompt_id", "").strip()
        run = manifest_row.get("run_number", "").strip()
        acct = manifest_row.get("account_label", "").strip().replace(" ", "-")
        if pid and run and acct:
            return f"{pid}_run{run}_{acct}_{short_id}"
    return f"UNLABELLED_{short_id}"


def organise(source_dir, output_dir, manifest_path):
    source = Path(source_dir)
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)

    txt_files = sorted(source.glob("*.txt"))
    if not txt_files:
        print(f"No .txt files found in {source}")
        return

    manifest = load_manifest(manifest_path)

    # Classify all files
    conversations = {}  # conv_id -> list of (path, update_time, size)
    sse_streams = {}    # conv_id -> list of (path, size)
    discarded = {"conduit_stub": 0, "status_stub": 0, "empty_list": 0,
                 "null_stub": 0, "sidebar_list": 0, "completions_stub": 0,
                 "detail_stub": 0, "empty": 0, "unknown": 0, "json_error": 0,
                 "other_json": 0}

    for p in txt_files:
        kind, conv_id, ut, size = classify_file(p)

        if kind == "conversation" and conv_id:
            conversations.setdefault(conv_id, []).append((p, ut, size))
        elif kind == "sse_stream" and conv_id:
            sse_streams.setdefault(conv_id, []).append((p, size))
        elif kind in discarded:
            discarded[kind] += 1
        else:
            discarded["other_json"] = discarded.get("other_json", 0) + 1

    print(f"Source: {source}")
    print(f"Conversation IDs found: {len(conversations)}")
    print(f"SSE streams with conversation_id: {len(sse_streams)}")
    print(f"Discarded: {sum(discarded.values())} files "
          f"({', '.join(f'{v} {k}' for k, v in discarded.items() if v)})")

    warnings = []
    for conv_id, files in sorted(conversations.items()):
        # Pick latest: highest update_time, then largest file on ties
        best = max(files, key=lambda x: (x[1], x[2]))
        best_path = best[0]

        manifest_row = manifest.get(conv_id)
        base_name = build_output_name(conv_id, manifest_row)

        if not manifest_row:
            warnings.append(f"  WARNING: no manifest row for {conv_id[:12]}... -> {base_name}.json")

        # Copy conversation JSON
        dest_json = output / f"{base_name}.json"
        shutil.copy2(best_path, dest_json)

        # Copy SSE stream if present (largest one)
        if conv_id in sse_streams:
            best_sse = max(sse_streams[conv_id], key=lambda x: x[1])
            dest_sse = output / f"{base_name}.sse.txt"
            shutil.copy2(best_sse[0], dest_sse)

        # Copy corresponding .meta.json if it exists
        meta_path = best_path.with_suffix("").with_suffix(".meta.json")
        if not meta_path.exists():
            # Try matching pattern: same timestamp prefix
            stem = best_path.stem
            meta_path = best_path.parent / f"{stem}.meta.json"
        if meta_path.exists():
            dest_meta = output / f"{base_name}.meta.json"
            shutil.copy2(meta_path, dest_meta)

    print(f"\nOrganised {len(conversations)} conversations to {output}/")
    if warnings:
        print(f"\n{len(warnings)} unlabelled conversations:")
        for w in warnings:
            print(w)


def main():
    parser = argparse.ArgumentParser(description="Organise raw sse-capture files")
    parser.add_argument("source", nargs="?", default=None,
                        help="Source directory (default: ~/Downloads/sse-capture)")
    parser.add_argument("-o", "--output", default="organised",
                        help="Output directory (default: ./organised)")
    parser.add_argument("-m", "--manifest", default="manifest.csv",
                        help="Path to manifest.csv (default: ./manifest.csv)")
    args = parser.parse_args()

    source = args.source
    if source is None:
        # Platform-aware default
        home = Path.home()
        source = home / "Downloads" / "sse-capture"
        if not source.exists():
            # Try Windows path under WSL
            source = Path("/mnt/c/Users") / os.environ.get("USER", "user") / "Downloads" / "sse-capture"

    organise(source, args.output, Path(args.manifest))


if __name__ == "__main__":
    main()
