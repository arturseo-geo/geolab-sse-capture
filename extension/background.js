// Copyright 2026 Artur Ferreira (The GEO Lab)
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0
// See the NOTICE file distributed with this work for attribution.

/**
 * SSE Capture — background service worker.
 *
 * Uses chrome.debugger (Chrome DevTools Protocol) to intercept network
 * responses from chatgpt.com conversation endpoints. Captures raw SSE
 * stream bodies and saves them to disk via chrome.downloads.
 *
 * Debugger protocol docs:
 *   https://chromedevtools.github.io/devtools-protocol/tot/Network/
 *
 * Key events used:
 *   Network.responseReceived    — fires when headers arrive; we note the URL
 *   Network.loadingFinished     — fires when the body is complete; we fetch it
 *   Network.eventSourceMessageReceived — fires per SSE event; we concatenate
 */

// ── State ─────────────────────────────────────────────────────────────────

// Per-tab capture state: tabId -> { attached, captures, lastFile, label,
//   pendingRequests: { requestId -> { url, method, startTime, headers, sseChunks[] } } }
const tabs = new Map();

// URL pattern: matches /backend-api/…conversation… endpoints
const CONV_PATTERN = /\/backend-api\/.*conversation/;

// ── Badge helpers ─────────────────────────────────────────────────────────

function setBadge(tabId, recording) {
  chrome.action.setBadgeText({ text: recording ? "REC" : "", tabId });
  chrome.action.setBadgeBackgroundColor({
    color: recording ? "#e53935" : "#757575",
    tabId,
  });
}

// ── Tab state helpers ─────────────────────────────────────────────────────

function getTab(tabId) {
  if (!tabs.has(tabId)) {
    tabs.set(tabId, {
      attached: false,
      captures: 0,
      lastFile: null,
      label: "",
      pendingRequests: {},
    });
  }
  return tabs.get(tabId);
}

// ── Attach / detach debugger ──────────────────────────────────────────────

/**
 * Attach chrome.debugger to a tab and enable the Network domain.
 *
 * chrome.debugger.attach(target, protocolVersion) connects to the tab's
 * DevTools backend. Once attached, we send Network.enable to start
 * receiving network events. The user sees a yellow "started debugging"
 * banner — this is expected and cannot be suppressed.
 */
async function attachToTab(tabId) {
  const state = getTab(tabId);
  if (state.attached) return;

  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (err) {
    console.error("[sse-capture] attach failed for tab %d: %s", tabId, err.message);
    return;
  }

  // Enable the Network domain so we receive response/loading/SSE events.
  // maxTotalBufferSize ensures large SSE streams aren't truncated.
  try {
    await chrome.debugger.sendCommand({ tabId }, "Network.enable", {
      maxTotalBufferSize: 100 * 1024 * 1024, // 100 MB
    });
  } catch (err) {
    console.error("[sse-capture] Network.enable failed: %s", err.message);
    await chrome.debugger.detach({ tabId }).catch(() => {});
    return;
  }

  state.attached = true;
  setBadge(tabId, true);
  console.log("[sse-capture] attached to tab %d", tabId);
}

/**
 * Detach chrome.debugger from a tab. Cleans up state.
 */
async function detachFromTab(tabId) {
  const state = getTab(tabId);
  if (!state.attached) return;

  try {
    await chrome.debugger.detach({ tabId });
  } catch (err) {
    // Tab may already be closed; ignore
    console.warn("[sse-capture] detach warning for tab %d: %s", tabId, err.message);
  }

  state.attached = false;
  state.pendingRequests = {};
  setBadge(tabId, false);
  console.log("[sse-capture] detached from tab %d", tabId);
}

// ── Toggle (called from popup) ────────────────────────────────────────────

async function toggleCapture(tabId) {
  const state = getTab(tabId);
  if (state.attached) {
    await detachFromTab(tabId);
  } else {
    await attachToTab(tabId);
  }
  return getTab(tabId);
}

// ── Token scrubbing ──────────────────────────────────────────────────────
//
// All scrubbing runs in the write path BEFORE bytes reach disk.
// We scrub: JWTs, bearer tokens, conduit_token values, cookies,
// oai-* identifier headers, user/account IDs, emails, ad tokens.
// We preserve conversation_id and message IDs (needed for record joins).

/** JWT pattern: three base64url segments separated by dots, first starts eyJ */
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

/**
 * Scrub sensitive tokens from a text string (SSE stream or serialised JSON).
 * Returns the scrubbed string.  Exported for testing via globalThis._sseCapture.
 */
function scrubText(text) {
  // 1. JWTs (covers conduit_token values, x-conduit-token, bearer payloads,
  //    oai-is-update/receipt opaque tokens, ad_data_token base64 payloads)
  text = text.replace(JWT_RE, "[REDACTED:jwt]");

  // 2. Bearer tokens (in case the token isn't JWT-shaped)
  text = text.replace(/Bearer\s+[A-Za-z0-9_.\-\/+=]{20,}/gi, "Bearer [REDACTED:bearer]");

  // 3. JSON string values for known sensitive keys.
  //    Pattern: "key":"<value>" or "key": "<value>"  (handles optional space)
  const sensitiveKeys = [
    "conduit_token",
    "authorization",
    "cookie",
    "set-cookie",
    "x-csrf-token",
    "x-conduit-token",
    "oai-device-id",
    "oai-dm-tgt-token",
    "oai-echo-session-id",
    "ad_data_token",
    "ads_spam_integrity_payload",
    "x-oai-is-update",
    "x-oai-is-receipt",
    "x-oai-is-pending-updates-ack",
  ];
  for (const key of sensitiveKeys) {
    // Match "key":"value" or "key": "value" — value is everything up to
    // the next unescaped double-quote
    const re = new RegExp(
      `("${key}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`,
      "gi"
    );
    text = text.replace(re, `$1"[REDACTED:${key}]"`);
  }

  // 4. oai-* headers we might not have listed above (catch-all for response
  //    headers that carry session identifiers)
  text = text.replace(
    /("oai-[a-z0-9_-]+"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    (match, prefix) => {
      // Don't re-scrub if already redacted, and preserve oai-request-id
      if (match.includes("[REDACTED:") || /oai-request-id/i.test(match)) {
        return match;
      }
      const keyMatch = match.match(/"(oai-[a-z0-9_-]+)"/i);
      const keyName = keyMatch ? keyMatch[1] : "oai-header";
      return `${prefix}"[REDACTED:${keyName}]"`;
    }
  );

  // 5. Email addresses (user@domain.tld pattern)
  text = text.replace(
    /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
    "[REDACTED:email]"
  );

  // 6. user_id / account_id string values
  text = text.replace(
    /("(?:user_id|account_id|user_profile_id)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    '$1"[REDACTED:id]"'
  );

  return text;
}

/**
 * Scrub a headers object (from Network.responseReceived).
 * Returns a new object with sensitive header values replaced.
 */
function scrubHeaders(headers) {
  if (!headers || typeof headers !== "object") return headers;
  const scrubbed = {};
  const sensitiveHeaderPrefixes = [
    "cookie", "set-cookie", "authorization",
    "x-conduit-token", "x-csrf-token",
    "x-oai-is-update", "x-oai-is-receipt", "x-oai-is-pending",
    "oai-device-id", "oai-dm-tgt", "oai-echo-session",
  ];
  for (const [key, value] of Object.entries(headers)) {
    const keyLower = key.toLowerCase();
    if (sensitiveHeaderPrefixes.some(p => keyLower.startsWith(p))) {
      scrubbed[key] = `[REDACTED:${keyLower}]`;
    } else if (typeof value === "string" && JWT_RE.test(value)) {
      // Reset regex lastIndex since it has the global flag
      JWT_RE.lastIndex = 0;
      scrubbed[key] = value.replace(JWT_RE, "[REDACTED:jwt]");
    } else {
      scrubbed[key] = value;
    }
    // Reset global regex state
    JWT_RE.lastIndex = 0;
  }
  return scrubbed;
}

// Expose scrub functions for testing
globalThis._sseCapture = { scrubText, scrubHeaders };

// ── Schema fingerprint ───────────────────────────────────────────────────
//
// Per-capture sidecar (.fingerprint.json) recording field presence, model,
// event counts. Also appends to a running fingerprints.jsonl for time-series.

/** Keys whose presence/absence we track in every capture */
const FINGERPRINT_KEYS = [
  "should_fetch",
  "page_contents",
  "snippet::parts",
  "snippet::scores",
  "result_source",
  "fetched_pages",
  "search_result_groups",
  "web_search_queries",
];

/**
 * Build a fingerprint object from the (already-scrubbed) body text.
 */
function buildFingerprint(body, capturedAt) {
  const fp = {
    captured_at: capturedAt,
    conversation_id: null,
    model: null,
    reasoning_setting: null,
    keys_present: {},
    counts: {
      sse_events: 0,
      search_rounds: 0,
      total_bytes: body.length,
    },
  };

  // conversation_id: first occurrence in the stream
  const cidMatch = body.match(/"conversation_id"\s*:\s*"([^"]+)"/);
  if (cidMatch) fp.conversation_id = cidMatch[1];

  // model_slug: from resolved_model_slug or model_slug
  const modelMatch = body.match(/"(?:resolved_)?model_slug"\s*:\s*"([^"]+)"/);
  if (modelMatch) fp.model = modelMatch[1];

  // reasoning_setting: only if explicitly present, never guess
  const reasoningMatch = body.match(/"reasoning_setting"\s*:\s*"([^"]+)"/);
  if (reasoningMatch) fp.reasoning_setting = reasoningMatch[1];

  // keys_present: string search for each fingerprint key
  for (const key of FINGERPRINT_KEYS) {
    // Use a literal string search (some keys contain :: which isn't a JSON
    // path, it's the actual key name in OpenAI's schema)
    fp.keys_present[key] = body.includes(`"${key}"`);
  }

  // SSE event count: each "data: " line at the start of a line
  const eventMatches = body.match(/^data: /gm);
  fp.counts.sse_events = eventMatches ? eventMatches.length : 0;

  // Search/tool rounds: count messages with recipient "web" or "web.run"
  // Each "recipient":"web" or "recipient":"web.run" indicates a search round
  const searchRounds = body.match(/"recipient"\s*:\s*"web(?:\.run)?"/g);
  fp.counts.search_rounds = searchRounds ? searchRounds.length : 0;

  return fp;
}

// ── Chunked save helpers ─────────────────────────────────────────────────
//
// Split SSE streams into per-round files within a capture folder.
// Round boundaries: a "recipient":"web" message starts a search round,
// and a subsequent "recipient":"all" or "recipient":"assistant" message
// after the tool response ends it. If no rounds detected, fall back to
// 8 MB fixed-size chunks.

const CHUNK_SIZE_LIMIT = 8 * 1024 * 1024; // 8 MB fallback

/**
 * Split an SSE body into logical parts at search/tool round boundaries.
 * Returns an array of { name, content, type } objects.
 *
 * Heuristic: each SSE frame starts with "data: " on its own line.
 * We accumulate frames. When we see a frame whose JSON contains
 * "recipient":"web" (a tool call to the search system), we mark a
 * boundary. The preceding frames form one part, and the search frames
 * form another. The final assistant continuation forms the last part.
 */
function splitIntoRounds(body) {
  // Split into individual SSE frames (separated by blank lines)
  const frames = body.split(/\n\n/);
  if (frames.length < 2) {
    return [{ name: "part_00_complete.txt", content: body, type: "complete" }];
  }

  const parts = [];
  let currentFrames = [];
  let currentType = "preamble";
  let partIndex = 0;
  let inSearchRound = false;

  for (const frame of frames) {
    if (!frame.trim()) continue;

    // Detect search/tool round start: recipient is "web" or "web.run"
    const isSearchFrame = /"recipient"\s*:\s*"web(?:\.run)?"/.test(frame);
    // Detect return to main assistant: recipient is "all" after a search round
    const isAllFrame = /"recipient"\s*:\s*"all"/.test(frame);

    if (isSearchFrame && !inSearchRound) {
      // Flush accumulated frames as previous part
      if (currentFrames.length > 0) {
        const suffix = partIndex === 0 ? "preamble" : "answer";
        parts.push({
          name: `part_${String(partIndex).padStart(2, "0")}_${suffix}.txt`,
          content: currentFrames.join("\n\n") + "\n\n",
          type: suffix,
        });
        partIndex++;
        currentFrames = [];
      }
      inSearchRound = true;
      currentType = "search";
    } else if (isAllFrame && inSearchRound) {
      // Flush search round frames
      if (currentFrames.length > 0) {
        parts.push({
          name: `part_${String(partIndex).padStart(2, "0")}_search.txt`,
          content: currentFrames.join("\n\n") + "\n\n",
          type: "search",
        });
        partIndex++;
        currentFrames = [];
      }
      inSearchRound = false;
      currentType = "answer";
    }

    currentFrames.push(frame);
  }

  // Flush remaining frames
  if (currentFrames.length > 0) {
    const suffix = inSearchRound ? "search" : (parts.length === 0 ? "complete" : "answer");
    parts.push({
      name: `part_${String(partIndex).padStart(2, "0")}_${suffix}.txt`,
      content: currentFrames.join("\n\n") + "\n\n",
      type: suffix,
    });
  }

  // If we only found one part with no search rounds, check if it needs
  // fixed-size chunking (body > 8 MB)
  if (parts.length <= 1 && body.length > CHUNK_SIZE_LIMIT) {
    return splitFixedSize(body);
  }

  return parts;
}

/**
 * Fallback: split body into fixed-size 8 MB chunks.
 * Splits at newline boundaries to avoid cutting mid-frame.
 */
function splitFixedSize(body) {
  const parts = [];
  let offset = 0;
  let partIndex = 0;

  while (offset < body.length) {
    let end = Math.min(offset + CHUNK_SIZE_LIMIT, body.length);
    // Find the last newline before the limit
    if (end < body.length) {
      const lastNewline = body.lastIndexOf("\n", end);
      if (lastNewline > offset) {
        end = lastNewline + 1;
      }
    }
    parts.push({
      name: `part_${String(partIndex).padStart(2, "0")}_chunk.txt`,
      content: body.slice(offset, end),
      type: "chunk",
    });
    offset = end;
    partIndex++;
  }

  return parts;
}


// ── Save capture to disk ──────────────────────────────────────────────────

/**
 * Encode a string as a base64 data: URL.
 * Uses encodeURIComponent + unescape to handle UTF-8 correctly
 * before btoa (which only accepts Latin-1 / binary-safe input).
 *
 * For strings exceeding ~1.5 MB, we chunk the btoa encoding to avoid
 * call-stack limits in the service worker.
 */
function toDataUrl(str, mime) {
  // Convert UTF-8 string to binary-safe Latin-1 for btoa
  const binary = unescape(encodeURIComponent(str));

  // Chunk btoa to avoid stack overflow on large strings
  const CHUNK = 1024 * 768; // ~768 KB chunks
  let b64 = "";
  for (let i = 0; i < binary.length; i += CHUNK) {
    b64 += btoa(binary.slice(i, i + CHUNK));
  }
  return `data:${mime};base64,${b64}`;
}

/**
 * Download a string as a file via chrome.downloads.
 * Returns a promise that resolves with the download ID.
 */
function downloadFile(content, filename, mime) {
  return new Promise((resolve) => {
    chrome.downloads.download(
      {
        url: toDataUrl(content, mime),
        filename,
        conflictAction: "uniquify",
        saveAs: false,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error("[sse-capture] download failed for %s: %s",
            filename, chrome.runtime.lastError.message);
        }
        resolve(downloadId);
      }
    );
  });
}

function saveCapture(tabId, requestId, info) {
  const state = getTab(tabId);
  const now = new Date();
  const capturedAt = now.toISOString();
  const stamp = capturedAt.replace(/[:.]/g, "-");

  // ── Step 1: Scrub the body and headers before any bytes reach disk ──
  const scrubbedBody = scrubText(info.body);
  const scrubbedHeaders = scrubHeaders(info.headers);

  // ── Step 2: Build fingerprint from the scrubbed body ──
  const fingerprint = buildFingerprint(scrubbedBody, capturedAt);

  // ── Step 3: Determine folder name and split into parts ──
  const convIdShort = fingerprint.conversation_id
    ? fingerprint.conversation_id.slice(0, 8)
    : requestId;
  const folderName = `${stamp}_${convIdShort}`;
  const folderPath = `sse-capture/${folderName}`;

  // Split SSE streams into per-round parts; buffered JSON stays as one file
  const isSSE = info.captureMethod === "eventSourceMessages" ||
                scrubbedBody.trimStart().startsWith("event:") ||
                scrubbedBody.trimStart().startsWith("data:");
  const parts = isSSE ? splitIntoRounds(scrubbedBody) : [
    { name: "part_00_complete.json", content: scrubbedBody, type: "complete" }
  ];

  // ── Step 4: Build capture manifest ──
  const manifest = {
    captured_at: capturedAt,
    conversation_id: fingerprint.conversation_id,
    url: info.url,
    method: info.method,
    captureMethod: info.captureMethod,
    tabUrl: info.tabUrl,
    total_bytes: scrubbedBody.length,
    original_bytes: info.body.length,
    split_method: parts.some(p => p.type === "chunk") ? "fixed_8mb" : "round_boundary",
    parts: parts.map(p => ({
      name: p.name,
      type: p.type,
      bytes: p.content.length,
    })),
  };
  if (state.label) {
    manifest.label = state.label;
  }

  // ── Step 5: Write all files ──

  // 5a. Capture manifest
  downloadFile(
    JSON.stringify(manifest, null, 2),
    `${folderPath}/manifest.json`,
    "application/json"
  );

  // 5b. Each part file
  for (const part of parts) {
    const mime = part.name.endsWith(".json") ? "application/json" : "text/plain";
    downloadFile(part.content, `${folderPath}/${part.name}`, mime);
  }

  // 5c. Response headers (scrubbed)
  const meta = {
    url: info.url,
    method: info.method,
    responseHeaders: scrubbedHeaders,
    startTime: info.startTime,
    endTime: capturedAt,
    tabUrl: info.tabUrl,
    captureMethod: info.captureMethod,
    bodyBytes: scrubbedBody.length,
  };
  if (state.label) {
    meta.label = state.label;
  }
  downloadFile(
    JSON.stringify(meta, null, 2),
    `${folderPath}/meta.json`,
    "application/json"
  );

  // 5d. Fingerprint sidecar
  downloadFile(
    JSON.stringify(fingerprint, null, 2),
    `${folderPath}/fingerprint.json`,
    "application/json"
  );

  // 5e. Append to running fingerprints.jsonl
  downloadFile(
    JSON.stringify(fingerprint) + "\n",
    "sse-capture/fingerprints.jsonl",
    "text/plain"
  );

  state.captures++;
  state.lastFile = folderName;
  console.log("[sse-capture] saved capture #%d: %s (%d bytes, %d parts)",
    state.captures, folderName, scrubbedBody.length, parts.length);
}

// ── Debugger event handler ────────────────────────────────────────────────

/**
 * All chrome.debugger events arrive here. We handle three:
 *
 * 1. Network.responseReceived
 *    Fires when response headers arrive. We check if the URL matches our
 *    conversation pattern. If so, we register the request in pendingRequests
 *    and record the URL, method, and response headers.
 *
 * 2. Network.eventSourceMessageReceived
 *    Fires for each SSE event in a streaming response. We concatenate the
 *    raw event data. This is the primary capture path for ChatGPT streams.
 *
 * 3. Network.loadingFinished
 *    Fires when the response body is complete. For SSE streams, we may
 *    already have the body from eventSourceMessage events. If not, we call
 *    Network.getResponseBody to fetch the buffered body from DevTools.
 */
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const tabId = source.tabId;
  const state = tabs.get(tabId);
  if (!state || !state.attached) return;

  if (method === "Network.responseReceived") {
    const url = params.response?.url || "";
    if (!CONV_PATTERN.test(url)) return;

    // Register this request for body capture
    state.pendingRequests[params.requestId] = {
      url,
      method: params.response?.requestHeaders?.[":method"] || "GET",
      headers: params.response?.headers || {},
      startTime: new Date().toISOString(),
      sseChunks: [],
      tabUrl: "",
    };

    // Get the tab URL for the sidecar
    try {
      const tab = await chrome.tabs.get(tabId);
      state.pendingRequests[params.requestId].tabUrl = tab.url || "";
    } catch (_) {}

    console.log("[sse-capture] tracking request %s: %s", params.requestId, url);
  }

  if (method === "Network.eventSourceMessageReceived") {
    // SSE event: concatenate raw event text.
    // params: { requestId, timestamp, eventName, eventId, data }
    const pending = state.pendingRequests[params.requestId];
    if (!pending) return;

    // Reconstruct the raw SSE frame: "event: ...\ndata: ...\n\n"
    let frame = "";
    if (params.eventName) frame += `event: ${params.eventName}\n`;
    if (params.eventId) frame += `id: ${params.eventId}\n`;
    frame += `data: ${params.data}\n\n`;
    pending.sseChunks.push(frame);

    // Periodically flush to chrome.storage.session to survive worker suspension.
    // We flush every 50 chunks to balance write frequency vs data loss risk.
    if (pending.sseChunks.length % 50 === 0) {
      try {
        await chrome.storage.session.set({
          [`pending_${tabId}_${params.requestId}`]: {
            url: pending.url,
            method: pending.method,
            headers: pending.headers,
            startTime: pending.startTime,
            tabUrl: pending.tabUrl,
            sseChunks: pending.sseChunks,
          }
        });
      } catch (e) {
        // storage.session has a 10 MB quota; if exceeded, log but continue
        console.warn("[sse-capture] session storage flush failed:", e.message);
      }
    }
  }

  if (method === "Network.loadingFinished") {
    const pending = state.pendingRequests[params.requestId];
    if (!pending) return;

    let body = "";
    let captureMethod = "";

    if (pending.sseChunks.length > 0) {
      // We captured via eventSourceMessage events — use those
      body = pending.sseChunks.join("");
      captureMethod = "eventSourceMessages";
    } else {
      // No SSE events received — try getResponseBody for buffered responses.
      // Network.getResponseBody returns { body, base64Encoded }.
      try {
        const result = await chrome.debugger.sendCommand(
          { tabId },
          "Network.getResponseBody",
          { requestId: params.requestId }
        );
        if (result.base64Encoded) {
          body = atob(result.body);
        } else {
          body = result.body;
        }
        captureMethod = "getResponseBody";
      } catch (err) {
        console.error(
          "[sse-capture] getResponseBody failed for %s: %s",
          params.requestId,
          err.message
        );
        delete state.pendingRequests[params.requestId];
        return;
      }
    }

    // Clean up session storage for this request
    try {
      await chrome.storage.session.remove(`pending_${tabId}_${params.requestId}`);
    } catch (_) {}

    if (body.length > 0) {
      saveCapture(tabId, params.requestId, {
        url: pending.url,
        method: pending.method,
        headers: pending.headers,
        startTime: pending.startTime,
        tabUrl: pending.tabUrl,
        body,
        captureMethod,
      });
    }

    delete state.pendingRequests[params.requestId];
  }
});

// ── Debugger detach handler ───────────────────────────────────────────────

/**
 * Fires when the debugger is detached externally (user closed DevTools,
 * tab navigated away, or the banner's "cancel" was clicked).
 */
chrome.debugger.onDetach.addListener((source, reason) => {
  const state = tabs.get(source.tabId);
  if (state) {
    state.attached = false;
    state.pendingRequests = {};
    setBadge(source.tabId, false);
    console.log("[sse-capture] debugger detached from tab %d: %s", source.tabId, reason);
  }
});

// ── Tab close cleanup ─────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabs.has(tabId)) {
    // Debugger auto-detaches on tab close; just clean up state
    tabs.delete(tabId);
    console.log("[sse-capture] tab %d closed, state cleaned up", tabId);
  }
});

// ── Message handler (popup communication) ─────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "getState") {
      const state = getTab(msg.tabId);
      sendResponse({
        attached: state.attached,
        captures: state.captures,
        lastFile: state.lastFile,
        label: state.label,
      });
    } else if (msg.type === "toggle") {
      const state = await toggleCapture(msg.tabId);
      sendResponse({
        attached: state.attached,
        captures: state.captures,
        lastFile: state.lastFile,
        label: state.label,
      });
    } else if (msg.type === "setLabel") {
      const state = getTab(msg.tabId);
      state.label = msg.label || "";
      sendResponse({ ok: true });
    }
  })();
  return true; // async sendResponse
});
