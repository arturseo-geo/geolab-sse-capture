#!/usr/bin/env python3
# Copyright 2026 Artur Ferreira (The GEO Lab)
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#     http://www.apache.org/licenses/LICENSE-2.0
# See the NOTICE file distributed with this work for attribution.

"""
manifest.py -- Record provenance for each capture session.

Provenance must be RECORDED at capture time because the payload cannot tell
you which account produced it, and memory_scope is unreliable. This script
appends one row to manifest.csv per capture.

Run BEFORE or immediately after each prompt. The organise step joins on
conversation_id to produce deterministic filenames.
"""
import argparse
import csv
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

MANIFEST_FIELDS = [
    "timestamp_utc",
    "prompt_id",
    "run_number",
    "account_label",
    "conversation_id",
    "memory_state_as_set",
    "behavioural_memory_check_done",
    "notes",
]

MANIFEST_FILE = "manifest.csv"


def init_manifest(path):
    """Create manifest.csv with headers if it does not exist."""
    if not path.exists():
        with open(path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=MANIFEST_FIELDS)
            writer.writeheader()
        print(f"Created {path}")


def prompt_user():
    """Interactive prompts for manifest fields."""
    row = {}
    row["timestamp_utc"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    row["prompt_id"] = input("Prompt ID (e.g. P01, P07): ").strip()
    row["run_number"] = input("Run number (e.g. 1, 2): ").strip()
    row["account_label"] = input("Account label (e.g. plus, clean): ").strip()
    row["conversation_id"] = input("Conversation ID (paste from URL or leave blank to label later): ").strip()
    row["memory_state_as_set"] = input("Memory state as set [on/off]: ").strip().lower()
    row["behavioural_memory_check_done"] = input("Behavioural memory check done? [y/n]: ").strip().lower()
    row["notes"] = input("Notes (optional): ").strip()

    return row


def append_row(path, row):
    """Append one row to manifest.csv."""
    with open(path, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=MANIFEST_FIELDS)
        writer.writerow(row)


def label_recent(manifest_path, source_dir):
    """Find the most recent unlabelled conversation and offer to label it."""
    import json

    source = Path(source_dir)
    if not source.exists():
        print(f"Source directory not found: {source}")
        return

    # Load existing manifest conversation_ids
    labelled = set()
    if manifest_path.exists():
        with open(manifest_path, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                cid = row.get("conversation_id", "").strip()
                if cid:
                    labelled.add(cid)

    # Find conversation JSONs not yet labelled
    unlabelled = []
    for p in sorted(source.glob("*.txt"), key=lambda x: x.stat().st_mtime, reverse=True):
        if p.stat().st_size < 1000:
            continue
        with open(p, "r", encoding="utf-8", errors="replace") as f:
            head = f.read(50).strip()
        if not head.startswith("{"):
            continue
        try:
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                d = json.load(f)
            cid = d.get("conversation_id")
            title = d.get("title", "(untitled)")
            if cid and cid not in labelled:
                unlabelled.append((cid, title, p.name))
        except (json.JSONDecodeError, ValueError):
            continue

    # Deduplicate by conversation_id
    seen = set()
    unique = []
    for cid, title, fname in unlabelled:
        if cid not in seen:
            seen.add(cid)
            unique.append((cid, title, fname))

    if not unique:
        print("No unlabelled conversations found.")
        return

    print(f"\nUnlabelled conversations ({len(unique)}):")
    for i, (cid, title, fname) in enumerate(unique[:10]):
        print(f"  [{i}] {cid[:12]}... \"{title}\" ({fname})")

    choice = input("\nLabel which? [number, or Enter to skip]: ").strip()
    if not choice.isdigit() or int(choice) >= len(unique):
        return

    cid, title, fname = unique[int(choice)]
    print(f"\nLabelling: {cid} \"{title}\"")

    row = prompt_user()
    row["conversation_id"] = cid
    append_row(manifest_path, row)
    print(f"Appended to {manifest_path}")


def main():
    parser = argparse.ArgumentParser(description="Record capture provenance")
    parser.add_argument("--label", action="store_true",
                        help="Label the most recent unlabelled capture")
    parser.add_argument("--source", default=None,
                        help="Source directory for --label mode")
    parser.add_argument("-f", "--file", default=MANIFEST_FILE,
                        help="Manifest CSV path (default: manifest.csv)")
    args = parser.parse_args()

    manifest_path = Path(args.file)
    init_manifest(manifest_path)

    if args.label:
        source = args.source
        if source is None:
            home = Path.home()
            source = home / "Downloads" / "sse-capture"
            if not source.exists():
                source = Path("/mnt/c/Users") / os.environ.get("USER", "user") / "Downloads" / "sse-capture"
        label_recent(manifest_path, source)
    else:
        row = prompt_user()
        append_row(manifest_path, row)
        print(f"\nAppended to {manifest_path}")


if __name__ == "__main__":
    main()
