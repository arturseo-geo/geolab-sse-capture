#!/usr/bin/env python3
# Copyright 2026 Artur Ferreira (The GEO Lab)
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#     http://www.apache.org/licenses/LICENSE-2.0
# See the NOTICE file distributed with this work for attribution.

"""
diff.py -- Compare two organised captures of the same prompt_id.

Prints pool overlap (Jaccard), domains unique to each run, owned-domain
status side by side, cited-set overlap, and engine metadata mismatches.
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


def jaccard(a, b):
    if not a and not b:
        return 1.0
    intersection = a & b
    union = a | b
    return len(intersection) / len(union) if union else 0.0


def diff_captures(path1, path2, config_dir=None):
    if config_dir is None:
        config_dir = Path(__file__).parent.parent / "config"
    else:
        config_dir = Path(config_dir)

    owned_domains = load_config_list(config_dir / "owned_domains.txt")

    d1 = load_conversation(path1)
    d2 = load_conversation(path2)

    lines = []
    lines.append(f"DIFF REPORT")
    lines.append(f"=" * 60)
    lines.append(f"  Run 1: {Path(path1).name}")
    lines.append(f"  Run 2: {Path(path2).name}")
    lines.append(f"  Conv 1: {d1.get('conversation_id', '?')}")
    lines.append(f"  Conv 2: {d2.get('conversation_id', '?')}")
    lines.append("")

    # Engine metadata comparison
    lines.append("ENGINE METADATA COMPARISON")
    lines.append("-" * 40)
    meta_fields = ["default_model_slug", "memory_scope", "is_do_not_remember",
                    "is_temporary_chat", "conversation_origin"]
    mismatches = []
    for field in meta_fields:
        v1 = d1.get(field)
        v2 = d2.get(field)
        match = "==" if v1 == v2 else "!= MISMATCH"
        lines.append(f"  {field:<28} {str(v1):<20} {str(v2):<20} {match}")
        if v1 != v2:
            mismatches.append(field)

    # Model slug from messages
    slugs1 = set()
    slugs2 = set()
    from report import extract_messages
    for msg, meta in extract_messages(d1):
        ms = meta.get("model_slug")
        if ms:
            slugs1.add(ms)
    for msg, meta in extract_messages(d2):
        ms = meta.get("model_slug")
        if ms:
            slugs2.add(ms)
    if slugs1 != slugs2:
        lines.append(f"  ** MODEL SLUG MISMATCH: run1={slugs1} vs run2={slugs2} **")
        mismatches.append("model_slug")

    if mismatches:
        lines.append(f"  METADATA MISMATCHES: {', '.join(mismatches)}")
    else:
        lines.append(f"  Metadata: identical")

    # Retrieval pool comparison
    lines.append("")
    lines.append("RETRIEVAL POOL COMPARISON")
    lines.append("-" * 40)

    pool1, total1 = extract_retrieval_pool(d1)
    pool2, total2 = extract_retrieval_pool(d2)

    urls1 = {e["url"] for e in pool1}
    urls2 = {e["url"] for e in pool2}
    domains1 = {e["domain"] for e in pool1}
    domains2 = {e["domain"] for e in pool2}

    j_url = jaccard(urls1, urls2)
    j_dom = jaccard(domains1, domains2)

    lines.append(f"  Pool: run1={total1} entries, {len(pool1)} unique URLs; run2={total2} entries, {len(pool2)} unique URLs")
    lines.append(f"  URL Jaccard overlap: {j_url:.3f}")
    lines.append(f"  Domain Jaccard overlap: {j_dom:.3f}")

    only1 = domains1 - domains2
    only2 = domains2 - domains1
    if only1:
        lines.append(f"  Domains only in run1 ({len(only1)}):")
        for d in sorted(only1):
            lines.append(f"    {d}")
    if only2:
        lines.append(f"  Domains only in run2 ({len(only2)}):")
        for d in sorted(only2):
            lines.append(f"    {d}")

    # Cited set comparison
    lines.append("")
    lines.append("CITED SET COMPARISON")
    lines.append("-" * 40)

    cited1, method1 = extract_cited_set(d1)
    cited2, method2 = extract_cited_set(d2)

    cited_urls1 = {c["url"] for c in cited1}
    cited_urls2 = {c["url"] for c in cited2}
    cited_doms1 = {c["domain"] for c in cited1}
    cited_doms2 = {c["domain"] for c in cited2}

    j_cited = jaccard(cited_urls1, cited_urls2)
    lines.append(f"  Cited: run1={len(cited1)}, run2={len(cited2)}")
    lines.append(f"  Cited URL Jaccard: {j_cited:.3f}")
    lines.append(f"  Cited only in run1: {sorted(cited_doms1 - cited_doms2)}")
    lines.append(f"  Cited only in run2: {sorted(cited_doms2 - cited_doms1)}")

    # Owned domain comparison
    lines.append("")
    lines.append("OWNED DOMAIN STATUS (side by side)")
    lines.append("-" * 40)

    safe1 = set(d1.get("safe_urls", []))
    safe2 = set(d2.get("safe_urls", []))

    stable = True
    for od in owned_domains:
        od_clean = od.lower().strip().removeprefix("www.")

        p1 = "YES" if any(e["domain"] == od_clean for e in pool1) else "no"
        p2 = "YES" if any(e["domain"] == od_clean for e in pool2) else "no"

        s1 = "YES" if any(domain_of(u) == od_clean for u in safe1) else "no"
        s2 = "YES" if any(domain_of(u) == od_clean for u in safe2) else "no"

        c1 = "YES" if any(c["domain"] == od_clean for c in cited1) else "no"
        c2 = "YES" if any(c["domain"] == od_clean for c in cited2) else "no"

        status1 = f"pool={p1} safe={s1} cited={c1}"
        status2 = f"pool={p2} safe={s2} cited={c2}"

        if status1 != status2:
            stable = False
            lines.append(f"  {od_clean}")
            lines.append(f"    run1: {status1}")
            lines.append(f"    run2: {status2}  ** DIFFERS **")
        else:
            lines.append(f"  {od_clean}")
            lines.append(f"    both: {status1}")

    lines.append("")
    if stable:
        lines.append("VERDICT: STABLE (owned-domain status identical across runs)")
    else:
        lines.append("VERDICT: UNSTABLE (owned-domain status differs between runs)")

    lines.append("")
    lines.append("-" * 60)
    lines.append("A single-run observation is not a finding. Use n>=2 runs and report stability.")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Diff two captures of the same prompt")
    parser.add_argument("run1", help="Path to run 1 organised JSON")
    parser.add_argument("run2", help="Path to run 2 organised JSON")
    parser.add_argument("-c", "--config", default=None, help="Config directory")
    args = parser.parse_args()

    for p in [args.run1, args.run2]:
        if not Path(p).exists():
            print(f"File not found: {p}", file=sys.stderr)
            sys.exit(1)

    output = diff_captures(args.run1, args.run2, args.config)
    print(output)


if __name__ == "__main__":
    main()
