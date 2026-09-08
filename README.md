# geolab-sse-capture

Chrome extension + Python processing layer for research capture of your own ChatGPT sessions. Captures the full SSE stream and conversation JSON from chatgpt.com, then processes captures into structured reports for AI visibility research.

## TOKEN WARNING

Raw captures contain session tokens (conduit_token JWTs, session material). Before sharing any capture file, run the scrubber:

```
python scripts/scrub.py <file_or_folder>
```

This writes scrubbed copies to `/scrubbed`. Originals are never modified.

## What it does

- Captures raw response bodies from ChatGPT `/backend-api/*conversation` endpoints via the Chrome DevTools Protocol (`chrome.debugger`)
- Saves each capture as a `.txt` (raw body) and `.meta.json` (URL, headers, timing) to your Downloads folder
- Post-capture scripts organise, report on, diff, and export the captured data
- Everything runs locally. No external requests, no telemetry, no analytics, no phone-home

## What it does NOT do

- Does not modify, inject into, or interact with the ChatGPT page
- Does not send captured data anywhere
- Does not parse or alter raw capture content (processing works on copies)
- Does not require a build step or external dependencies (extension is plain JS; scripts are Python 3 stdlib)

## Credit and context

The debug-window observation that prompted this tool originated with Metehan Yesilyurt's 7 Sep 2026 LinkedIn post documenting exposed retrieval metadata in ChatGPT conversation payloads.

As of approximately 8 Sep 2026, the detailed debug fields (`should_fetch`, `page_contents`, `meta_tags`, `crawl_date`, score objects, rewritten/fan-out queries) appear to have been removed by OpenAI. The citation layer (retrieval pools via `search_result_groups`, cited sets via `content_references`, `safe_urls`) remains present in captures at the time of this release. Do not assume any particular field will persist across OpenAI updates.

## Install the extension

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `extension/` folder from this repo
4. Pin the extension icon in the toolbar

## Usage

### Capture workflow

1. Create `config/owned_domains.local.txt` with your domains and `config/location_terms.local.txt` with your place names (these `.local.txt` files are gitignored; the committed files contain example placeholders)
2. Open a ChatGPT tab at chatgpt.com
3. (Optional) Log a manifest row: `python scripts/manifest.py`
4. Click the extension icon and press **Start Capture**
5. Send your prompt in ChatGPT
6. Wait for the full response, then click **Stop Capture**
7. Chrome shows a yellow "started debugging this browser" banner while capture is active. This is expected and disappears when you stop

### Process captures

Run the full pipeline:

```
python scripts/run_all.py ~/Downloads/sse-capture
```

This runs: organise (deduplicate) -> report (per capture) -> diff (run pairs) -> export paths (for log reconciliation).

Or run steps individually:

```
python scripts/organise.py ~/Downloads/sse-capture
python scripts/report.py organised/UNLABELLED_6aa020fd.json
python scripts/diff.py organised/P07_run1_plus_6aa020fd.json organised/P07_run2_clean_6aa02a51.json
python scripts/export_paths.py organised/P07_run1_plus_6aa020fd.json
python scripts/scrub.py organised/  # before sharing anything
```

## Report sections

- **Engine Metadata** -- model slug, memory scope (flagged as self-reported/unreliable), temporary chat status
- **Debug Window Status** -- whether retrieval debug fields are present (OPEN) or stripped (CLOSED)
- **Retrieval Pool** -- all URLs from `search_result_groups`, with domain counts
- **Cited Set** -- URLs that made the answer, derived from `content_references` (sources footnotes) or answer text URLs as fallback
- **Safe URLs by Layer** -- classifies each `safe_urls` entry as seeded-baseline, answer-layer, or other (possible memory/account injection)
- **Owned Domains** -- per-domain status: in pool? in safe_urls? cited? with matching paths
- **Injection/Personalisation Markers** -- skill IDs, hidden messages, memory references
- **Location Signals** -- counts of configured location terms across the payload
- **Fan-out Queries** -- rewritten search queries if the debug window is open

## The n>=2 / diff discipline

A single capture is an observation, not a finding. The diff tool (`scripts/diff.py`) compares two runs of the same prompt and reports pool overlap (Jaccard), domain differences, owned-domain status per run, cited-set stability, and engine metadata mismatches. It prints STABLE or UNSTABLE as a verdict. Run each prompt at least twice before drawing conclusions.

## Server-log reconciliation

`scripts/export_paths.py` writes a list of owned-domain URLs from each capture, labelled by source (pool/safe_urls/cited). Cross-reference these against your Nginx/Apache access logs filtered to OpenAI crawler user agents.

OpenAI publishes its crawler IP ranges as JSON. Use these to verify that log hits are genuine (UA strings are spoofable; CIDR membership is not):

- OAI-SearchBot: https://openai.com/searchbot.json
- ChatGPT-User: https://openai.com/chatgpt-user.json
- GPTBot: https://openai.com/gptbot.json

OpenAI does not publish reverse DNS (PTR) records for its crawler IPs. CIDR membership against the published ranges above is the strongest verification method available.

## Scope and ethics

This tool captures YOUR OWN ChatGPT session data from YOUR OWN browser. It reads responses that your browser already received. It does not access other users' data, does not circumvent authentication, and does not exfiltrate anything.

Review OpenAI's Terms of Service before using captures in published research. The tool itself makes no external connections, but what you do with the output is your responsibility.

## License

Apache License 2.0. See LICENSE for the full text. Redistributions and derivative works must retain the NOTICE file, which carries the attribution required by the licence. You are free to use, modify, and distribute this software, including commercially, provided the licence terms and NOTICE are preserved.
