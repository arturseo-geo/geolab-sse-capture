#!/usr/bin/env python3
# Copyright 2026 Artur Ferreira (The GEO Lab)
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#     http://www.apache.org/licenses/LICENSE-2.0
# See the NOTICE file distributed with this work for attribution.

"""
scrub.py -- Strip tokens and secrets from capture files.

Writes *.scrubbed.json copies to /scrubbed. NEVER modifies originals.
Strips: conduit_token values, Authorization/cookie header values,
JWT-shaped strings (three base64url segments separated by dots, starting eyJ).

--bundle produces a share-ready folder: scrubbed capture + report files.
"""
import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path


# JWT pattern: three base64url segments separated by dots, first starts with eyJ
JWT_PATTERN = re.compile(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+')


def scrub_value(value):
    """Scrub a string value, replacing JWTs and known sensitive patterns."""
    if not isinstance(value, str):
        return value
    # Replace JWTs
    value = JWT_PATTERN.sub("[SCRUBBED_JWT]", value)
    # Replace Bearer tokens
    value = re.sub(r'Bearer\s+[A-Za-z0-9_.-]+', 'Bearer [SCRUBBED]', value)
    return value


def scrub_dict(obj):
    """Recursively scrub a parsed JSON object."""
    if isinstance(obj, dict):
        result = {}
        for k, v in obj.items():
            k_lower = k.lower()
            # Completely redact known sensitive keys
            if k_lower in ("conduit_token", "authorization", "cookie",
                           "set-cookie", "x-csrf-token", "ad_data_token",
                           "ads_spam_integrity_payload"):
                result[k] = "[SCRUBBED]"
            elif k_lower == "token" and isinstance(v, str) and v.startswith("eyJ"):
                result[k] = "[SCRUBBED_JWT]"
            else:
                result[k] = scrub_dict(v)
        return result
    elif isinstance(obj, list):
        return [scrub_dict(item) for item in obj]
    elif isinstance(obj, str):
        return scrub_value(obj)
    else:
        return obj


def scrub_sse_text(text):
    """Scrub an SSE stream text file (not JSON)."""
    text = JWT_PATTERN.sub("[SCRUBBED_JWT]", text)
    text = re.sub(r'Bearer\s+[A-Za-z0-9_.-]+', 'Bearer [SCRUBBED]', text)
    text = re.sub(r'"conduit_token"\s*:\s*"[^"]*"', '"conduit_token":"[SCRUBBED]"', text)
    text = re.sub(r'"token"\s*:\s*"eyJ[^"]*"', '"token":"[SCRUBBED_JWT]"', text)
    text = re.sub(r'"ad_data_token"\s*:\s*"[^"]*"', '"ad_data_token":"[SCRUBBED]"', text)
    text = re.sub(r'"ads_spam_integrity_payload"\s*:\s*"[^"]*"', '"ads_spam_integrity_payload":"[SCRUBBED]"', text)
    return text


def scrub_file(input_path, output_dir):
    """Scrub one file. Returns output path."""
    input_path = Path(input_path)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    with open(input_path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    # Determine if JSON or SSE
    stripped = content.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            data = json.loads(content)
            scrubbed = scrub_dict(data)
            out_name = input_path.stem + ".scrubbed.json"
            out_path = output_dir / out_name
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(scrubbed, f, indent=2, ensure_ascii=False)
            return out_path
        except json.JSONDecodeError:
            pass

    # Treat as text (SSE or other)
    scrubbed_text = scrub_sse_text(content)
    out_name = input_path.stem + ".scrubbed.txt"
    out_path = output_dir / out_name
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(scrubbed_text)
    return out_path


def scrub_folder(input_dir, output_dir):
    """Scrub all .txt and .json files in a folder."""
    input_dir = Path(input_dir)
    output_dir = Path(output_dir)
    count = 0

    for ext in ("*.txt", "*.json"):
        for p in sorted(input_dir.glob(ext)):
            if ".scrubbed." in p.name or ".report." in p.name:
                continue
            scrub_file(p, output_dir)
            count += 1

    print(f"Scrubbed {count} files to {output_dir}/")
    return count


def bundle(capture_path, output_dir):
    """Produce a share-ready bundle: scrubbed capture + report files."""
    capture_path = Path(capture_path)
    output_dir = Path(output_dir)
    bundle_dir = output_dir / f"bundle_{capture_path.stem}"
    bundle_dir.mkdir(parents=True, exist_ok=True)

    # Scrub the capture
    scrub_file(capture_path, bundle_dir)

    # Copy report files if they exist alongside the capture
    parent = capture_path.parent
    stem = capture_path.stem
    for suffix in (".report.txt", ".report.json"):
        report_path = parent / f"{stem}{suffix}"
        if report_path.exists():
            shutil.copy2(report_path, bundle_dir / report_path.name)

    print(f"Bundle created: {bundle_dir}/")
    for f in sorted(bundle_dir.iterdir()):
        print(f"  {f.name}")
    return bundle_dir


def main():
    parser = argparse.ArgumentParser(description="Scrub tokens from capture files")
    parser.add_argument("input", help="File or folder to scrub")
    parser.add_argument("-o", "--output", default="scrubbed",
                        help="Output directory (default: ./scrubbed)")
    parser.add_argument("--bundle", action="store_true",
                        help="Produce a share-ready bundle (scrubbed + reports)")
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    if args.bundle:
        if not input_path.is_file():
            print("--bundle requires a single file, not a folder", file=sys.stderr)
            sys.exit(1)
        bundle(input_path, args.output)
    elif input_path.is_dir():
        scrub_folder(input_path, args.output)
    else:
        out = scrub_file(input_path, args.output)
        print(f"Scrubbed: {out}")


if __name__ == "__main__":
    main()
