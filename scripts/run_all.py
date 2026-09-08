#!/usr/bin/env python3
# Copyright 2026 Artur Ferreira (The GEO Lab)
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#     http://www.apache.org/licenses/LICENSE-2.0
# See the NOTICE file distributed with this work for attribution.

"""
run_all.py -- Single entrypoint: organise -> report -> diff (if pair) -> export_paths.

Usage:
    python scripts/run_all.py [source_dir]
    python scripts/run_all.py ~/Downloads/sse-capture
"""
import argparse
import os
import sys
from pathlib import Path

# Ensure scripts/ is on the path for imports
sys.path.insert(0, str(Path(__file__).parent))

from organise import organise
from report import generate_report
from export_paths import export_paths


def find_diff_pairs(organised_dir):
    """Find pairs of files that share a prompt_id prefix (e.g. P07_run1, P07_run2)."""
    import re
    files = sorted(Path(organised_dir).glob("*.json"))
    files = [f for f in files if ".report." not in f.name and ".meta." not in f.name
             and ".scrubbed." not in f.name]

    # Group by prompt_id prefix
    groups = {}
    for f in files:
        match = re.match(r'^(P\d+)_run(\d+)_', f.name)
        if match:
            pid = match.group(1)
            groups.setdefault(pid, []).append(f)

    pairs = []
    for pid, group_files in groups.items():
        if len(group_files) >= 2:
            group_files.sort()
            pairs.append((group_files[0], group_files[1]))
    return pairs


def main():
    parser = argparse.ArgumentParser(description="Run full pipeline: organise -> report -> diff -> export")
    parser.add_argument("source", nargs="?", default=None,
                        help="Source directory with raw captures (default: ~/Downloads/sse-capture)")
    parser.add_argument("-o", "--output", default="organised",
                        help="Output directory for organised files (default: ./organised)")
    parser.add_argument("-c", "--config", default=None,
                        help="Config directory (default: ./config)")
    parser.add_argument("-m", "--manifest", default="manifest.csv",
                        help="Path to manifest.csv")
    args = parser.parse_args()

    config_dir = args.config
    if config_dir is None:
        config_dir = str(Path(__file__).parent.parent / "config")

    # Step 1: Organise
    print("=" * 60)
    print("STEP 1: ORGANISE")
    print("=" * 60)

    source = args.source
    if source is None:
        home = Path.home()
        source = home / "Downloads" / "sse-capture"
        if not source.exists():
            source = Path("/mnt/c/Users") / os.environ.get("USER", "user") / "Downloads" / "sse-capture"
    source = Path(source)

    organise(str(source), args.output, Path(args.manifest))

    # Step 2: Report on each organised capture
    print()
    print("=" * 60)
    print("STEP 2: REPORTS")
    print("=" * 60)

    organised = Path(args.output)
    json_files = sorted(organised.glob("*.json"))
    json_files = [f for f in json_files if ".report." not in f.name
                  and ".meta." not in f.name and ".scrubbed." not in f.name]

    for jf in json_files:
        print(f"\n--- Report: {jf.name} ---")
        try:
            report_text, report_dict = generate_report(str(jf), config_dir)
            stem = jf.stem
            txt_path = organised / f"{stem}.report.txt"
            json_path = organised / f"{stem}.report.json"
            with open(txt_path, "w", encoding="utf-8") as f:
                f.write(report_text)
            with open(json_path, "w", encoding="utf-8") as f:
                import json as json_mod
                json_mod.dump(report_dict, f, indent=2, ensure_ascii=False)
            print(f"  Written: {txt_path.name}, {json_path.name}")
        except Exception as e:
            print(f"  ERROR: {e}")

    # Step 3: Diff pairs
    print()
    print("=" * 60)
    print("STEP 3: DIFFS")
    print("=" * 60)

    pairs = find_diff_pairs(args.output)
    if pairs:
        from diff import diff_captures
        for p1, p2 in pairs:
            print(f"\n--- Diff: {p1.name} vs {p2.name} ---")
            try:
                output = diff_captures(str(p1), str(p2), config_dir)
                diff_path = organised / f"diff_{p1.stem}_vs_{p2.stem}.txt"
                with open(diff_path, "w", encoding="utf-8") as f:
                    f.write(output)
                print(output)
                print(f"\n  Written: {diff_path.name}")
            except Exception as e:
                print(f"  ERROR: {e}")
    else:
        print("  No run pairs found for diffing.")

    # Step 4: Export paths
    print()
    print("=" * 60)
    print("STEP 4: EXPORT OWNED-DOMAIN PATHS")
    print("=" * 60)

    for jf in json_files:
        try:
            export_paths(str(jf), config_dir, args.output)
        except Exception as e:
            print(f"  ERROR on {jf.name}: {e}")

    print()
    print("Done. Review outputs in", args.output)


if __name__ == "__main__":
    main()
