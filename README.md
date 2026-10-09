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
- Scrubs tokens and secrets at write time (no unscrubbed bytes reach disk)
- Saves each capture as a folder with per-round part files, a manifest, metadata, and a schema fingerprint
- Appends a fingerprint line to `fingerprints.jsonl` for field-presence time-series
- Post-capture scripts organise, report on, diff, and export the captured data
- Everything runs locally. No external requests, no telemetry, no analytics, no phone-home

## What it does NOT do

- Does not modify, inject into, or interact with the ChatGPT page
- Does not send captured data anywhere
- Does not require a build step or external dependencies (extension is plain JS; scripts are Python 3 stdlib)

## Credit and context

The debug-window observation that prompted this tool originated with Metehan Yesilyurt's 7 Sep 2026 LinkedIn post documenting exposed retrieval metadata in ChatGPT conversation payloads.

As of approximately 8 Sep 2026, the detailed debug fields (`should_fetch`, `page_contents`, `meta_tags`, `crawl_date`, score objects, rewritten/fan-out queries) appear to have been removed by OpenAI. The citation layer (retrieval pools via `search_result_groups`, cited sets via `content_references`, `safe_urls`) remains present in captures at the time of this release. Do not assume any particular field will persist across OpenAI updates.

## Changelog

### v1.2.0 (2026-10-09) — Stream capture fix

**What broke:** Between Sep 8 and Oct 9 2026, Chrome stopped returning streamed fetch() response bodies via `Network.getResponseBody`. ChatGPT streams answers via `POST /backend-api/f/conversation` returning `text/event-stream` over a standard `fetch()` call (not the EventSource API). The extension's `eventSourceMessageReceived` handler never fired (wrong transport), and the `getResponseBody` fallback silently failed, dropping the answer stream entirely. All Oct 9 captures had 0 SSE events.

**What changed:**
- Request capture via `Network.requestWillBeSent`: correct HTTP method (was always "GET"), request URL, and POST body (scrubbed). Saved as `request.json` in capture folder.
- Error reporting: capture failures write `error.json` and set badge to "ERR" instead of failing silently.
- Missing-stream guard: if a GET conversation capture contains search results but no stream was captured for that conversation_id recently, a warning is written.
- Fingerprint additions: `method`, `has_stream`, `turn_use_case` (all values), `thinking_effort`, `is_temporary_chat`, `model_slugs` (all distinct values).
- Popup: shows stream capture count and last stream time separately.
- Version bump: manifest.json now says 1.2.0 (was 1.0.0 while commit said v1.1.0).

**Known limitation:** `Network.getResponseBody` still fails on streamed fetch responses in current Chrome. If this persists, the stream must be captured via the companion fetch-hook script (Irina's capture_snippet). The extension reliably captures all non-stream conversation requests, request bodies, and metadata. When `getResponseBody` does work (e.g., future Chrome versions or non-streamed responses), the stream is captured normally.

### v1.1.0 (2026-09-09) — Write-time scrubbing, schema fingerprints

- Token scrubbing at write time (JWTs, Bearer, cookies, emails, user IDs)
- Schema fingerprints per capture
- SSE stream splitting at search/tool round boundaries

### v1.0.0 (2026-09-08) — Initial release

- Chrome DevTools Protocol capture of conversation endpoints
- Download to local disk via chrome.downloads

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

## Capture folder layout

Each capture produces a folder in `Downloads/sse-capture/`:

```
2026-10-09T08-52-06-000Z_6ac8aaf2/
  manifest.json          # Part list, byte counts, split method, has_stream
  part_00_preamble.txt   # System messages, user prompt
  part_01_search.txt     # Search/tool round (web.run)
  part_02_answer.txt     # Assistant answer continuation
  meta.json              # Response headers (scrubbed), timing
  request.json           # POST body (scrubbed) — model, effort, prompt (v1.2.0)
  fingerprint.json       # Schema fingerprint (see below)
```

SSE streams are split at search/tool round boundaries (detected by `"recipient":"web"` transitions). If no round boundaries are found and the body exceeds 8 MB, it falls back to fixed-size 8 MB chunks (noted as `"split_method":"fixed_8mb"` in the manifest). Buffered (non-SSE) conversation JSON is saved as a single `part_00_complete.json`.

## Schema fingerprint

Each capture folder contains a `fingerprint.json` with:

- `captured_at`: ISO 8601 UTC timestamp
- `conversation_id`: extracted from the stream (null if not present)
- `model`: from `model_slug` or `resolved_model_slug` (null if not recoverable)
- `reasoning_setting`: from the stream if present (null if not; never guessed)
- `keys_present`: boolean for each of: `should_fetch`, `page_contents`, `snippet::parts`, `snippet::scores`, `result_source`, `fetched_pages`, `search_result_groups`, `web_search_queries`
- `counts`: SSE event count, search/tool round count, total bytes

A running `fingerprints.jsonl` in the output folder collects one line per capture so field-presence changes can be plotted over time without opening individual dumps.

## Write-time scrub list

All scrubbing happens in the extension's write path. No unscrubbed bytes reach disk. Scrubbed fields are replaced with `[REDACTED:<field>]` markers. The following are scrubbed:

- JWT tokens (three-segment `eyJ...` pattern)
- Bearer tokens in Authorization headers
- `conduit_token`, `x-conduit-token` values
- Cookies and Set-Cookie headers
- `oai-device-id` and all `oai-*` identifier headers (except `oai-request-id`, which is preserved for record matching)
- `x-oai-is-update`, `x-oai-is-receipt` opaque tokens
- `ad_data_token`, `ads_spam_integrity_payload`
- Email addresses
- `user_id`, `account_id`, `user_profile_id` values

**Not scrubbed** (needed for record joins): `conversation_id`, message IDs, `x-oai-request-id`.

Unit tests in `extension/tests/test_scrub.html` verify that a synthetic stream with fake secrets produces zero surviving tokens after scrubbing.

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
