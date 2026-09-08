#!/usr/bin/env python3
# Copyright 2026 Artur Ferreira (The GEO Lab)
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#     http://www.apache.org/licenses/LICENSE-2.0
# See the NOTICE file distributed with this work for attribution.

"""
report.py -- Generate a plain-text report and report.json from one organised capture.

Sections: Engine Metadata, Debug Window Status, Retrieval Pool, Cited Set,
Safe_URLs by Layer, Owned Domains, Injection/Personalisation Markers,
Location Signals, Fan-out Queries.
"""
import argparse
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse


def load_config_list(path):
    """Load a config file with one entry per line, ignoring comments and blanks.

    Checks for a .local.txt override first (e.g. owned_domains.local.txt),
    which is gitignored so users can keep real values out of the repo.
    Falls back to the committed file if no local override exists.
    """
    # Check for .local.txt override (gitignored, user's real values)
    local_path = path.with_suffix(".local.txt")
    if local_path.exists():
        path = local_path

    entries = []
    if not path.exists():
        return entries
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                entries.append(line)
    return entries


def load_conversation(path):
    """Load a conversation JSON file."""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return json.load(f)


def domain_of(url):
    """Extract bare domain from a URL or bare-domain string."""
    if not url:
        return ""
    if "://" not in url and "/" not in url:
        d = url.lower().strip()
        return d[4:] if d.startswith("www.") else d
    try:
        parsed = urlparse(url if "://" in url else f"https://{url}")
        d = (parsed.hostname or "").lower()
        return d[4:] if d.startswith("www.") else d
    except Exception:
        return url.lower().strip()


def extract_messages(data):
    """Yield (message_dict, metadata_dict) for every message in the conversation."""
    mapping = data.get("mapping", {})
    for node_id, node in mapping.items():
        msg = node.get("message")
        if not msg:
            continue
        meta = msg.get("metadata", {})
        yield msg, meta


def section_engine_metadata(data):
    """ENGINE METADATA section."""
    lines = ["ENGINE METADATA", "=" * 60]
    lines.append(f"  default_model_slug    : {data.get('default_model_slug', '(not present)')}")

    # Find resolved model_slug from message metadata
    model_slugs = set()
    for msg, meta in extract_messages(data):
        ms = meta.get("model_slug")
        if ms:
            model_slugs.add(ms)
    if model_slugs:
        lines.append(f"  resolved model_slug   : {', '.join(sorted(model_slugs))}")
    else:
        lines.append(f"  resolved model_slug   : (not present in message metadata)")

    lines.append(f"  conversation_origin   : {data.get('conversation_origin', '(not present)')}")
    lines.append(f"  memory_scope          : {data.get('memory_scope', '(not present)')} (self-reported, known unreliable)")
    lines.append(f"  is_do_not_remember    : {data.get('is_do_not_remember', '(not present)')}")
    lines.append(f"  is_temporary_chat     : {data.get('is_temporary_chat', '(not present)')}")
    return lines


def section_debug_window(data):
    """DEBUG WINDOW STATUS section.

    The verdict keys on fetch-and-score internals ONLY:
      should_fetch, page_contents, meta_tags, crawl_date, score objects.
    Fan-out / rewritten search queries are reported separately; their
    presence alone does NOT make the window "open".
    """
    lines = ["", "DEBUG WINDOW STATUS", "=" * 60]

    full_text = json.dumps(data)

    # Fetch-and-score internals (these define OPEN vs CLOSED)
    window_fields = [
        "should_fetch", "page_contents", "meta_tags", "crawl_date", "score",
    ]
    window_counts = {}
    for field in window_fields:
        c = full_text.count(f'"{field}"')
        if c > 0:
            window_counts[field] = c

    # Checklist
    for field in window_fields:
        c = window_counts.get(field, 0)
        status = f"present ({c})" if c else "absent"
        lines.append(f"    {field:<20}: {status}")

    if window_counts:
        total = sum(window_counts.values())
        lines.append(f"  DEBUG WINDOW: OPEN ({total} fetch/score fields present)")
    else:
        lines.append(f"  DEBUG WINDOW: CLOSED (0 fetch/score fields; only citation layer visible)")

    # Fan-out / rewritten queries (reported separately, never affects verdict)
    query_fields = ["search_queries", "fan_out_queries", "rewritten_query"]
    query_total = 0
    for field in query_fields:
        c = full_text.count(f'"{field}"')
        query_total += c
    if query_total:
        lines.append(f"  Fan-out queries: {query_total} exposed (does not affect window verdict)")
    else:
        lines.append(f"  Fan-out queries: not exposed")

    return lines


def extract_retrieval_pool(data):
    """Extract entries from search_result_groups.

    Returns (pool_unique, total_entry_count) where pool_unique is a list of
    dicts deduplicated by URL and total_entry_count is the raw count before
    deduplication.
    """
    pool = []
    seen_urls = set()
    total_entries = 0
    for msg, meta in extract_messages(data):
        groups = meta.get("search_result_groups", [])
        for group in groups:
            for entry in group.get("entries", []):
                url = entry.get("url", "")
                if not url:
                    continue
                total_entries += 1
                if url not in seen_urls:
                    seen_urls.add(url)
                    pool.append({
                        "domain": domain_of(url),
                        "url": url,
                        "title": entry.get("title", ""),
                        "snippet": entry.get("snippet", ""),
                    })
    return pool, total_entries


def section_retrieval_pool(pool, total_entries):
    """RETRIEVAL POOL section."""
    lines = ["", "RETRIEVAL POOL", "=" * 60]
    lines.append(f"  Pool: {total_entries} entries, {len(pool)} unique URLs")
    domains = [e["domain"] for e in pool]
    unique = sorted(set(domains))
    lines.append(f"  Unique domains  : {len(unique)}")

    domain_counts = Counter(domains).most_common()
    lines.append(f"  Domain counts (top 15):")
    for d, c in domain_counts[:15]:
        lines.append(f"    {c:3d}  {d}")
    if len(domain_counts) > 15:
        lines.append(f"    +{len(domain_counts) - 15} more")
    return lines


def extract_cited_set(data):
    """Extract cited URLs from content_references and answer text."""
    cited = []
    seen = set()
    method = "none"

    for msg, meta in extract_messages(data):
        refs = meta.get("content_references", [])
        for ref in refs:
            ref_type = ref.get("type", "")
            # Sources footnotes contain explicit URL citations
            if ref_type == "sources_footnote":
                for source in ref.get("sources", []):
                    url = source.get("url", "")
                    if url and url not in seen:
                        seen.add(url)
                        cited.append({
                            "url": url,
                            "domain": domain_of(url),
                            "title": source.get("title", ""),
                            "method": "content_references.sources_footnote",
                        })
                        method = "content_references"
            # Grouped webpages with safe_urls
            elif ref_type in ("grouped_webpages", "webpage"):
                for url in ref.get("safe_urls", []):
                    if url and url not in seen and "openai.com" not in url:
                        seen.add(url)
                        cited.append({
                            "url": url,
                            "domain": domain_of(url),
                            "title": "",
                            "method": "content_references.grouped_webpages",
                        })
                        method = "content_references"

    # Fallback: URLs in answer text of assistant messages
    if not cited:
        method = "answer_text_urls"
        for msg, meta in extract_messages(data):
            author = msg.get("author", {}).get("role", "")
            if author != "assistant":
                continue
            content = msg.get("content", {})
            parts = content.get("parts", [])
            for part in parts:
                if isinstance(part, str):
                    urls = re.findall(r'https?://[^\s\)"\]]+', part)
                    for url in urls:
                        url = url.rstrip(".,;:")
                        if url not in seen and "openai.com" not in url:
                            seen.add(url)
                            cited.append({
                                "url": url,
                                "domain": domain_of(url),
                                "title": "",
                                "method": "answer_text_url",
                            })

    return cited, method


def section_cited_set(cited, method):
    """CITED SET section."""
    lines = ["", "CITED SET", "=" * 60]
    lines.append(f"  Derivation method: {method}")
    lines.append(f"  Total cited URLs : {len(cited)}")
    if cited:
        domains = Counter(c["domain"] for c in cited).most_common()
        lines.append(f"  Cited domains:")
        for d, c in domains:
            lines.append(f"    {c:3d}  {d}")
    return lines


def section_safe_urls(data, pool, cited, seeded_baseline):
    """SAFE_URLS BY LAYER section."""
    lines = ["", "SAFE_URLS BY LAYER", "=" * 60]

    safe_urls = data.get("safe_urls", [])
    lines.append(f"  Total safe_urls entries: {len(safe_urls)}")

    pool_urls = {e["url"] for e in pool}
    pool_domains = {e["domain"] for e in pool}
    cited_urls = {c["url"] for c in cited}
    cited_domains = {c["domain"] for c in cited}
    baseline_patterns = [b.lower().strip() for b in seeded_baseline]

    seeded = []
    answer_layer = []
    other = []

    for url in safe_urls:
        url_lower = url.lower()
        dom = domain_of(url)

        # Check seeded baseline
        is_seeded = False
        for pattern in baseline_patterns:
            if pattern in url_lower or pattern == dom:
                is_seeded = True
                break
        # Also match openai.com image URLs
        if "openai.com" in url_lower or "oaistatic.com" in url_lower:
            is_seeded = True

        if is_seeded:
            seeded.append(url)
        elif url in pool_urls or dom in pool_domains or url in cited_urls or dom in cited_domains:
            answer_layer.append(url)
        else:
            other.append(url)

    lines.append(f"  seeded-baseline : {len(seeded)}")
    lines.append(f"  answer-layer    : {len(answer_layer)}")
    lines.append(f"  other           : {len(other)}")

    if other:
        lines.append(f"")
        lines.append(f"  'other' entries (possible memory/account injection):")
        for url in other:
            lines.append(f"    {url}")

    return lines, {"seeded": seeded, "answer_layer": answer_layer, "other": other}


def section_owned_domains(data, pool, cited, safe_urls_raw, owned_domains):
    """OWNED DOMAINS section."""
    lines = ["", "OWNED DOMAINS", "=" * 60]

    if not owned_domains:
        lines.append("  (no owned domains configured in config/owned_domains.txt)")
        return lines

    pool_by_domain = {}
    for e in pool:
        pool_by_domain.setdefault(e["domain"], []).append(e["url"])

    cited_by_domain = {}
    for c in cited:
        cited_by_domain.setdefault(c["domain"], []).append(c["url"])

    safe_by_domain = {}
    for url in safe_urls_raw:
        dom = domain_of(url)
        safe_by_domain.setdefault(dom, []).append(url)

    lines.append(f"  {'Domain':<35} {'Pool?':<8} {'Safe_URLs?':<12} {'Cited?':<8}")
    lines.append(f"  {'-'*35} {'-'*8} {'-'*12} {'-'*8}")

    for od in owned_domains:
        od_clean = od.lower().strip().removeprefix("www.")
        in_pool = "YES" if od_clean in pool_by_domain else "no"
        in_safe = "YES" if od_clean in safe_by_domain else "no"
        in_cited = "YES" if od_clean in cited_by_domain else "no"
        lines.append(f"  {od_clean:<35} {in_pool:<8} {in_safe:<12} {in_cited:<8}")

        # Show matching paths
        paths = set()
        for url in pool_by_domain.get(od_clean, []):
            paths.add(url)
        for url in cited_by_domain.get(od_clean, []):
            paths.add(url)
        for url in safe_by_domain.get(od_clean, []):
            paths.add(url)
        for p in sorted(paths):
            source_tags = []
            if any(e["url"] == p for e in pool):
                source_tags.append("pool")
            if p in (safe_urls_raw or []):
                source_tags.append("safe_urls")
            if any(c["url"] == p for c in cited):
                source_tags.append("cited")
            lines.append(f"    {p}  [{', '.join(source_tags)}]")

    return lines


def section_injection_markers(data):
    """INJECTION / PERSONALISATION MARKERS section."""
    lines = ["", "INJECTION / PERSONALISATION MARKERS", "=" * 60]

    full_text = json.dumps(data)
    markers = []

    # skill_is_generated
    skill_count = full_text.count('"skill_is_generated"')
    if skill_count:
        markers.append(f"skill_is_generated: {skill_count} occurrences")

    # Skill names / IDs
    skill_ids = set()
    for msg, meta in extract_messages(data):
        sid = meta.get("skill_id")
        if sid:
            skill_ids.add(str(sid))
    if skill_ids:
        markers.append(f"skill_id values: {', '.join(sorted(skill_ids))}")

    # Hidden system messages
    hidden_count = 0
    for msg, meta in extract_messages(data):
        if meta.get("is_visually_hidden_from_conversation"):
            hidden_count += 1
    if hidden_count:
        markers.append(f"is_visually_hidden_from_conversation: {hidden_count} messages")

    # Memory references
    memory_count = full_text.count('"memory"')
    if memory_count > 2:  # memory_scope counts as one
        markers.append(f"'memory' token occurrences: {memory_count}")

    if markers:
        for m in markers:
            lines.append(f"  {m}")
    else:
        lines.append(f"  CLEAN")

    return lines


def section_location_signals(data, location_terms):
    """LOCATION SIGNALS section."""
    lines = ["", "LOCATION SIGNALS", "=" * 60]

    if not location_terms:
        lines.append("  (no location terms configured in config/location_terms.txt)")
        return lines

    full_text = json.dumps(data).lower()
    counts = {}
    for term in location_terms:
        c = full_text.count(term.lower())
        if c > 0:
            counts[term] = c

    total = sum(counts.values())
    if total == 0:
        lines.append(f"  LOCATION-CLEAN (0 matches)")
    else:
        lines.append(f"  LOCATION-PRESENT ({total} matches)")
        for term, c in sorted(counts.items(), key=lambda x: -x[1]):
            lines.append(f"    {c:3d}  {term}")

    return lines


def section_fanout_queries(data):
    """FAN-OUT QUERIES section."""
    lines = ["", "FAN-OUT QUERIES", "=" * 60]

    queries = []
    for msg, meta in extract_messages(data):
        # Check various known field names for rewritten queries
        for field in ["search_queries", "fan_out_queries", "rewritten_query",
                      "rewritten_queries", "search_query"]:
            val = meta.get(field)
            if val:
                if isinstance(val, list):
                    queries.extend(val)
                elif isinstance(val, str):
                    queries.append(val)

        # Also check inside search_result_groups for query fields
        for group in meta.get("search_result_groups", []):
            q = group.get("query") or group.get("search_query")
            if q:
                queries.append(q)

    if queries:
        for q in queries:
            if isinstance(q, dict):
                lines.append(f"  {json.dumps(q)}")
            else:
                lines.append(f"  {q}")
    else:
        lines.append(f"  Not exposed in this capture.")

    return lines


def generate_report(capture_path, config_dir=None):
    """Generate the full report. Returns (report_text, report_dict)."""
    if config_dir is None:
        config_dir = Path(__file__).parent.parent / "config"
    else:
        config_dir = Path(config_dir)

    owned_domains = load_config_list(config_dir / "owned_domains.txt")
    location_terms = load_config_list(config_dir / "location_terms.txt")
    seeded_baseline = load_config_list(config_dir / "seeded_baseline.txt")

    data = load_conversation(capture_path)
    conv_id = data.get("conversation_id", "unknown")
    title = data.get("title", "(untitled)")

    all_lines = []
    all_lines.append(f"SSE Capture Report")
    all_lines.append(f"Conversation: {conv_id}")
    all_lines.append(f"Title: {title}")
    all_lines.append(f"File: {Path(capture_path).name}")
    all_lines.append("")

    # Sections
    all_lines.extend(section_engine_metadata(data))

    all_lines.extend(section_debug_window(data))

    pool, total_pool_entries = extract_retrieval_pool(data)
    all_lines.extend(section_retrieval_pool(pool, total_pool_entries))

    cited, cite_method = extract_cited_set(data)
    all_lines.extend(section_cited_set(cited, cite_method))

    safe_urls_raw = data.get("safe_urls", [])
    safe_lines, safe_layers = section_safe_urls(data, pool, cited, seeded_baseline)
    all_lines.extend(safe_lines)

    all_lines.extend(section_owned_domains(data, pool, cited, safe_urls_raw, owned_domains))

    all_lines.extend(section_injection_markers(data))

    all_lines.extend(section_location_signals(data, location_terms))

    all_lines.extend(section_fanout_queries(data))

    # Footer
    all_lines.append("")
    all_lines.append("-" * 60)
    all_lines.append("Presence in the payload is not evidence of retrieval or recommendation.")
    all_lines.append("Compare pool vs cited vs safe_urls, and reconcile against server logs.")

    report_text = "\n".join(all_lines)

    # Build report.json
    report_dict = {
        "conversation_id": conv_id,
        "title": title,
        "file": Path(capture_path).name,
        "engine_metadata": {
            "default_model_slug": data.get("default_model_slug"),
            "model_slugs": list({m.get("metadata", {}).get("model_slug") for _, m_meta in [] } or set()),
            "conversation_origin": data.get("conversation_origin"),
            "memory_scope": data.get("memory_scope"),
            "is_do_not_remember": data.get("is_do_not_remember"),
            "is_temporary_chat": data.get("is_temporary_chat"),
        },
        "retrieval_pool": pool,
        "cited_set": cited,
        "cite_method": cite_method,
        "safe_urls": {
            "total": len(safe_urls_raw),
            "seeded_baseline": safe_layers["seeded"],
            "answer_layer": safe_layers["answer_layer"],
            "other": safe_layers["other"],
        },
        "owned_domain_status": {},
    }

    # Populate model_slugs properly
    model_slugs = set()
    for msg, meta in extract_messages(data):
        ms = meta.get("model_slug")
        if ms:
            model_slugs.add(ms)
    report_dict["engine_metadata"]["model_slugs"] = sorted(model_slugs)

    # Owned domain status
    for od in owned_domains:
        od_clean = od.lower().strip().removeprefix("www.")
        pool_urls = [e["url"] for e in pool if e["domain"] == od_clean]
        cited_urls = [c["url"] for c in cited if c["domain"] == od_clean]
        safe_urls_for_domain = [u for u in safe_urls_raw if domain_of(u) == od_clean]
        report_dict["owned_domain_status"][od_clean] = {
            "in_pool": bool(pool_urls),
            "pool_urls": pool_urls,
            "in_safe_urls": bool(safe_urls_for_domain),
            "safe_urls": safe_urls_for_domain,
            "cited": bool(cited_urls),
            "cited_urls": cited_urls,
        }

    return report_text, report_dict


def main():
    parser = argparse.ArgumentParser(description="Generate report from organised capture")
    parser.add_argument("capture", help="Path to organised conversation JSON file")
    parser.add_argument("-c", "--config", default=None,
                        help="Config directory (default: ../config relative to script)")
    parser.add_argument("-o", "--output", default=None,
                        help="Output directory for report files (default: same as capture)")
    args = parser.parse_args()

    capture_path = Path(args.capture)
    if not capture_path.exists():
        print(f"File not found: {capture_path}", file=sys.stderr)
        sys.exit(1)

    report_text, report_dict = generate_report(capture_path, args.config)

    # Determine output paths
    out_dir = Path(args.output) if args.output else capture_path.parent
    stem = capture_path.stem

    txt_path = out_dir / f"{stem}.report.txt"
    json_path = out_dir / f"{stem}.report.json"

    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(report_text)

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(report_dict, f, indent=2, ensure_ascii=False)

    print(report_text)
    print(f"\nWritten: {txt_path}")
    print(f"Written: {json_path}")


if __name__ == "__main__":
    main()
