#!/usr/bin/env python3
# Copyright 2026 Artur Ferreira (The GEO Lab)
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#     http://www.apache.org/licenses/LICENSE-2.0
# See the NOTICE file distributed with this work for attribution.

"""
export_paths.py -- Export owned-domain URLs for server-log reconciliation.

Writes one file per capture: owned_paths_{prompt_id}_run{n}.txt with every
owned-domain URL the payload reported, labelled by source (pool / safe_urls / cited).
"""
import argparse
import json
import sys
from pathlib import Path

from report import (
    extract_retrieval_pool,
    extract_cited_set,
    load_config_list,
    load_conversation,
    domain_of,
)


def export_paths(capture_path, config_dir=None, output_dir=None):
    if config_dir is None:
        config_dir = Path(__file__).parent.parent / "config"
    else:
        config_dir = Path(config_dir)

    owned_domains = load_config_list(config_dir / "owned_domains.txt")
    if not owned_domains:
        print("No owned domains configured in config/owned_domains.txt")
        return

    data = load_conversation(capture_path)
    pool, _ = extract_retrieval_pool(data)
    cited, _ = extract_cited_set(data)
    safe_urls = data.get("safe_urls", [])

    # Collect all owned-domain URLs with source labels
    entries = []
    seen = set()

    for e in pool:
        if e["domain"] in [od.lower().strip().removeprefix("www.") for od in owned_domains]:
            key = e["url"]
            if key not in seen:
                seen.add(key)
                entries.append((e["url"], "pool"))

    for url in safe_urls:
        dom = domain_of(url)
        if dom in [od.lower().strip().removeprefix("www.") for od in owned_domains]:
            if url not in seen:
                seen.add(url)
                entries.append((url, "safe_urls"))
            elif url in seen:
                # Add safe_urls tag to existing
                for i, (u, tags) in enumerate(entries):
                    if u == url and "safe_urls" not in tags:
                        entries[i] = (u, tags + "+safe_urls")

    for c in cited:
        if c["domain"] in [od.lower().strip().removeprefix("www.") for od in owned_domains]:
            if c["url"] not in seen:
                seen.add(c["url"])
                entries.append((c["url"], "cited"))
            else:
                for i, (u, tags) in enumerate(entries):
                    if u == c["url"] and "cited" not in tags:
                        entries[i] = (u, tags + "+cited")

    if not entries:
        print(f"No owned-domain URLs found in {capture_path}")
        return

    # Determine output filename
    stem = Path(capture_path).stem
    out_dir = Path(output_dir) if output_dir else Path(capture_path).parent
    out_path = out_dir / f"owned_paths_{stem}.txt"

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(f"# Owned-domain URLs from: {Path(capture_path).name}\n")
        f.write(f"# Conversation: {data.get('conversation_id', '?')}\n")
        f.write(f"# For server-log reconciliation against OpenAI crawler ranges:\n")
        f.write(f"#   https://openai.com/searchbot.json\n")
        f.write(f"#   https://openai.com/chatgpt-user.json\n")
        f.write(f"#   https://openai.com/gptbot.json\n")
        f.write(f"#\n")
        for url, source in entries:
            f.write(f"{url}  [{source}]\n")

    print(f"Exported {len(entries)} owned-domain URLs to {out_path}")
    return out_path


def main():
    parser = argparse.ArgumentParser(description="Export owned-domain paths for log reconciliation")
    parser.add_argument("capture", help="Path to organised conversation JSON")
    parser.add_argument("-c", "--config", default=None, help="Config directory")
    parser.add_argument("-o", "--output", default=None, help="Output directory")
    args = parser.parse_args()

    if not Path(args.capture).exists():
        print(f"File not found: {args.capture}", file=sys.stderr)
        sys.exit(1)

    export_paths(args.capture, args.config, args.output)


if __name__ == "__main__":
    main()
