// Copyright 2026 Artur Ferreira (The GEO Lab)
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0
// See the NOTICE file distributed with this work for attribution.

/**
 * SSE Capture v1.2.0 — background service worker.
 *
 * Uses chrome.debugger (Chrome DevTools Protocol) to intercept network
 * responses from chatgpt.com conversation endpoints. Captures raw SSE
 * stream bodies and saves them to disk via chrome.downloads.
 *
 * v1.2.0: Stream capture via Network.streamResourceContent (experimental,
 * Chrome 126+). ChatGPT streams via fetch(), not EventSource. We call
 * streamResourceContent on responseReceived for stream requests, which
 * populates Network.dataReceived with actual data. At loadingFinished
 * we assemble bufferedData + live dataReceived chunks into the full body.
 *
 * Debugger protocol docs:
 *   https://chromedevtools.github.io/devtools-protocol/tot/Network/
 *
 * Key events used:
 *   Network.requestWillBeSent      — method, URL, POST body
 *   Network.responseReceived       — headers; triggers streamResourceContent
 *   Network.dataReceived           — streamed body chunks (after streaming enabled)
 *   Network.loadingFinished        — assemble and save
 *   Network.loadingFailed          — save partial stream if data exists
 *   Network.eventSourceMessageReceived — secondary path (legacy/EventSource)
 */

// ── State ─────────────────────────────────────────────────────────────────

const tabs = new Map();

// URL pattern: matches /backend-api/…conversation… endpoints
const CONV_PATTERN = /\/backend-api\/.*conversation/;

// Chrome version (populated at first attach)
let chromeVersion = null;

// ── Badge helpers ─────────────────────────────────────────────────────────

function setBadge(tabId, recording) {
  chrome.action.setBadgeText({ text: recording ? "REC" : "", tabId });
  chrome.action.setBadgeBackgroundColor({
    color: recording ? "#e53935" : "#757575",
    tabId,
  });
}

function setErrorBadge(tabId) {
  chrome.action.setBadgeText({ text: "ERR", tabId });
  chrome.action.setBadgeBackgroundColor({ color: "#ff6f00", tabId });
}

// ── Tab state helpers ─────────────────────────────────────────────────────

function getTab(tabId) {
  if (!tabs.has(tabId)) {
    tabs.set(tabId, {
      attached: false,
      captures: 0,
      streamCaptures: 0,
      lastFile: null,
      lastStreamTime: null,
      label: "",
      pendingRequests: {},
      recentStreamConvIds: [],
    });
  }
  return tabs.get(tabId);
}

// ── Attach / detach debugger ──────────────────────────────────────────────

async function attachToTab(tabId) {
  const state = getTab(tabId);
  if (state.attached) return;

  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (err) {
    console.error("[sse-capture] attach failed for tab %d: %s", tabId, err.message);
    return;
  }

  try {
    await chrome.debugger.sendCommand({ tabId }, "Network.enable", {
      maxTotalBufferSize: 100 * 1024 * 1024,
    });
  } catch (err) {
    console.error("[sse-capture] Network.enable failed: %s", err.message);
    await chrome.debugger.detach({ tabId }).catch(() => {});
    return;
  }

  // Detect Chrome version once
  if (!chromeVersion) {
    const ua = navigator.userAgent || "";
    const m = ua.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/);
    chromeVersion = m ? m[1] : "unknown";
    console.log("[sse-capture] Chrome version: %s", chromeVersion);
  }

  state.attached = true;
  setBadge(tabId, true);
  console.log("[sse-capture] attached to tab %d", tabId);
}

async function detachFromTab(tabId) {
  const state = getTab(tabId);
  if (!state.attached) return;

  try {
    await chrome.debugger.detach({ tabId });
  } catch (err) {
    console.warn("[sse-capture] detach warning for tab %d: %s", tabId, err.message);
  }

  state.attached = false;
  state.pendingRequests = {};
  setBadge(tabId, false);
  console.log("[sse-capture] detached from tab %d", tabId);
}

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

const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

function scrubText(text) {
  text = text.replace(JWT_RE, "[REDACTED:jwt]");
  text = text.replace(/Bearer\s+[A-Za-z0-9_.\-\/+=]{20,}/gi, "Bearer [REDACTED:bearer]");

  const sensitiveKeys = [
    "conduit_token", "authorization", "cookie", "set-cookie",
    "x-csrf-token", "x-conduit-token", "oai-device-id",
    "oai-dm-tgt-token", "oai-echo-session-id", "ad_data_token",
    "ads_spam_integrity_payload", "x-oai-is-update", "x-oai-is-receipt",
    "x-oai-is-pending-updates-ack",
  ];
  for (const key of sensitiveKeys) {
    const re = new RegExp(
      `("${key}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, "gi"
    );
    text = text.replace(re, `$1"[REDACTED:${key}]"`);
  }

  text = text.replace(
    /("oai-[a-z0-9_-]+"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    (match, prefix) => {
      if (match.includes("[REDACTED:") || /oai-request-id/i.test(match)) return match;
      const keyMatch = match.match(/"(oai-[a-z0-9_-]+)"/i);
      const keyName = keyMatch ? keyMatch[1] : "oai-header";
      return `${prefix}"[REDACTED:${keyName}]"`;
    }
  );

  text = text.replace(
    /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
    "[REDACTED:email]"
  );

  text = text.replace(
    /("(?:user_id|account_id|user_profile_id)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    '$1"[REDACTED:id]"'
  );

  return text;
}

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
      JWT_RE.lastIndex = 0;
      scrubbed[key] = value.replace(JWT_RE, "[REDACTED:jwt]");
    } else {
      scrubbed[key] = value;
    }
    JWT_RE.lastIndex = 0;
  }
  return scrubbed;
}

globalThis._sseCapture = { scrubText, scrubHeaders };

// ── Schema fingerprint ───────────────────────────────────────────────────

const FINGERPRINT_KEYS = [
  "should_fetch", "page_contents", "snippet::parts", "snippet::scores",
  "result_source", "fetched_pages", "search_result_groups",
  "web_search_queries",
];

function buildFingerprint(body, capturedAt, info) {
  const fp = {
    captured_at: capturedAt,
    conversation_id: null,
    method: info.method || null,
    has_stream: false,
    model_slugs: [],
    reasoning_setting: null,
    turn_use_case: [],
    thinking_effort: null,
    is_temporary_chat: null,
    keys_present: {},
    counts: {
      sse_events: 0,
      search_rounds: 0,
      total_bytes: body.length,
    },
  };

  const cidMatch = body.match(/"conversation_id"\s*:\s*"([^"]+)"/);
  if (cidMatch) fp.conversation_id = cidMatch[1];

  fp.has_stream = /^data: /m.test(body);

  // model_slug: ALL distinct values
  const slugs = new Set();
  for (const m of body.matchAll(/"model_slug"\s*:\s*"([^"]+)"/g)) slugs.add(m[1]);
  for (const m of body.matchAll(/"resolved_model_slug"\s*:\s*"([^"]+)"/g)) slugs.add(m[1]);
  fp.model_slugs = [...slugs].sort();

  const reasoningMatch = body.match(/"reasoning_setting"\s*:\s*"([^"]+)"/);
  if (reasoningMatch) fp.reasoning_setting = reasoningMatch[1];

  // turn_use_case: from server_ste_metadata events — all distinct values
  const tucs = new Set();
  for (const m of body.matchAll(/"turn_use_case"\s*:\s*"([^"]+)"/g)) tucs.add(m[1]);
  fp.turn_use_case = [...tucs].sort();

  const effortMatch = body.match(/"thinking_effort"\s*:\s*"([^"]+)"/);
  if (effortMatch) fp.thinking_effort = effortMatch[1];

  const tempMatch = body.match(/"is_temporary_chat"\s*:\s*(true|false)/);
  if (tempMatch) fp.is_temporary_chat = tempMatch[1] === "true";

  for (const key of FINGERPRINT_KEYS) {
    fp.keys_present[key] = body.includes(`"${key}"`);
  }

  // SSE event count: "data: " at start of line
  const eventMatches = body.match(/^data: /gm);
  fp.counts.sse_events = eventMatches ? eventMatches.length : 0;

  const searchRounds = body.match(/"recipient"\s*:\s*"web(?:\.run)?"/g);
  fp.counts.search_rounds = searchRounds ? searchRounds.length : 0;

  // Backward-compat
  fp.model = fp.model_slugs[0] || null;

  return fp;
}

// ── Chunked save helpers ─────────────────────────────────────────────────

const CHUNK_SIZE_LIMIT = 8 * 1024 * 1024;

function splitIntoRounds(body) {
  const frames = body.split(/\n\n/);
  if (frames.length < 2) {
    return [{ name: "part_00_complete.txt", content: body, type: "complete" }];
  }

  const parts = [];
  let currentFrames = [];
  let partIndex = 0;
  let inSearchRound = false;

  for (const frame of frames) {
    if (!frame.trim()) continue;
    const isSearchFrame = /"recipient"\s*:\s*"web(?:\.run)?"/.test(frame);
    const isAllFrame = /"recipient"\s*:\s*"all"/.test(frame);

    if (isSearchFrame && !inSearchRound) {
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
    } else if (isAllFrame && inSearchRound) {
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
    }

    currentFrames.push(frame);
  }

  if (currentFrames.length > 0) {
    const suffix = inSearchRound ? "search" : (parts.length === 0 ? "complete" : "answer");
    parts.push({
      name: `part_${String(partIndex).padStart(2, "0")}_${suffix}.txt`,
      content: currentFrames.join("\n\n") + "\n\n",
      type: suffix,
    });
  }

  if (parts.length <= 1 && body.length > CHUNK_SIZE_LIMIT) {
    return splitFixedSize(body);
  }
  return parts;
}

function splitFixedSize(body) {
  const parts = [];
  let offset = 0;
  let partIndex = 0;
  while (offset < body.length) {
    let end = Math.min(offset + CHUNK_SIZE_LIMIT, body.length);
    if (end < body.length) {
      const lastNewline = body.lastIndexOf("\n", end);
      if (lastNewline > offset) end = lastNewline + 1;
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

// ── Save helpers ─────────────────────────────────────────────────────────

function toDataUrl(str, mime) {
  const binary = unescape(encodeURIComponent(str));
  const CHUNK = 1024 * 768;
  let b64 = "";
  for (let i = 0; i < binary.length; i += CHUNK) {
    b64 += btoa(binary.slice(i, i + CHUNK));
  }
  return `data:${mime};base64,${b64}`;
}

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

// ── Error recording ──────────────────────────────────────────────────────

function saveError(tabId, errorObj) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `sse-capture/error_${stamp}.json`;
  errorObj.chrome_version = chromeVersion;
  downloadFile(JSON.stringify(errorObj, null, 2), filename, "application/json");
  setErrorBadge(tabId);
  console.error("[sse-capture] error recorded: %s", errorObj.error || errorObj.warning);
}

// ── Binary assembly ──────────────────────────────────────────────────────
//
// base64 chunks from streamResourceContent bufferedData and dataReceived
// must be decoded to bytes FIRST, concatenated as bytes, then decoded to
// UTF-8 ONCE at the end. Decoding per-chunk breaks multibyte characters.

function base64ToBytes(b64) {
  const binStr = atob(b64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) {
    bytes[i] = binStr.charCodeAt(i);
  }
  return bytes;
}

function concatUint8Arrays(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

function assembleStreamBody(bufferedData, dataChunks) {
  const byteArrays = [];
  // bufferedData first (data already present when streaming was enabled)
  if (bufferedData) {
    byteArrays.push(base64ToBytes(bufferedData));
  }
  // Then live chunks in arrival order
  for (const chunk of dataChunks) {
    byteArrays.push(base64ToBytes(chunk));
  }
  const allBytes = concatUint8Arrays(byteArrays);
  return new TextDecoder("utf-8").decode(allBytes);
}

// ── Save capture to disk ─────────────────────────────────────────────────

function saveCapture(tabId, requestId, info) {
  const state = getTab(tabId);
  const now = new Date();
  const capturedAt = now.toISOString();
  const stamp = capturedAt.replace(/[:.]/g, "-");

  const scrubbedBody = scrubText(info.body);
  const scrubbedHeaders = scrubHeaders(info.headers);
  const fingerprint = buildFingerprint(scrubbedBody, capturedAt, info);

  const convIdShort = fingerprint.conversation_id
    ? fingerprint.conversation_id.slice(0, 8)
    : requestId;
  const folderName = `${stamp}_${convIdShort}`;
  const folderPath = `sse-capture/${folderName}`;

  const isSSE = info.captureMethod === "eventSourceMessages" ||
                info.captureMethod === "streamResourceContent" ||
                scrubbedBody.trimStart().startsWith("event:") ||
                scrubbedBody.trimStart().startsWith("data:");
  const parts = isSSE ? splitIntoRounds(scrubbedBody) : [
    { name: "part_00_complete.json", content: scrubbedBody, type: "complete" }
  ];

  const manifest = {
    captured_at: capturedAt,
    conversation_id: fingerprint.conversation_id,
    url: info.url,
    method: info.method,
    captureMethod: info.captureMethod,
    tabUrl: info.tabUrl,
    total_bytes: scrubbedBody.length,
    original_bytes: info.body.length,
    has_stream: fingerprint.has_stream,
    truncated: info.truncated || false,
    chrome_version: chromeVersion,
    split_method: parts.some(p => p.type === "chunk") ? "fixed_8mb" : "round_boundary",
    parts: parts.map(p => ({
      name: p.name, type: p.type, bytes: p.content.length,
    })),
  };
  if (state.label) manifest.label = state.label;

  downloadFile(JSON.stringify(manifest, null, 2), `${folderPath}/manifest.json`, "application/json");

  for (const part of parts) {
    const mime = part.name.endsWith(".json") ? "application/json" : "text/plain";
    downloadFile(part.content, `${folderPath}/${part.name}`, mime);
  }

  const meta = {
    url: info.url,
    method: info.method,
    responseHeaders: scrubbedHeaders,
    startTime: info.startTime,
    endTime: capturedAt,
    tabUrl: info.tabUrl,
    captureMethod: info.captureMethod,
    bodyBytes: scrubbedBody.length,
    chrome_version: chromeVersion,
  };
  if (state.label) meta.label = state.label;
  downloadFile(JSON.stringify(meta, null, 2), `${folderPath}/meta.json`, "application/json");

  if (info.requestBody) {
    const scrubbedRequest = scrubText(info.requestBody);
    downloadFile(scrubbedRequest, `${folderPath}/request.json`, "application/json");
  }

  downloadFile(JSON.stringify(fingerprint, null, 2), `${folderPath}/fingerprint.json`, "application/json");
  downloadFile(JSON.stringify(fingerprint) + "\n", "sse-capture/fingerprints.jsonl", "text/plain");

  state.captures++;
  state.lastFile = folderName;
  if (fingerprint.has_stream) {
    state.streamCaptures++;
    state.lastStreamTime = capturedAt;
    if (fingerprint.conversation_id) {
      state.recentStreamConvIds.push({
        convId: fingerprint.conversation_id,
        time: Date.now(),
      });
      const cutoff = Date.now() - 5 * 60 * 1000;
      state.recentStreamConvIds = state.recentStreamConvIds.filter(e => e.time > cutoff);
    }
    setBadge(tabId, true);
  }

  console.log("[sse-capture] saved #%d: %s (%d bytes, %d parts, stream=%s, method=%s, via=%s)",
    state.captures, folderName, scrubbedBody.length, parts.length,
    fingerprint.has_stream, info.method, info.captureMethod);

  // Missing-stream guard
  if (!fingerprint.has_stream && fingerprint.keys_present.search_result_groups) {
    const convId = fingerprint.conversation_id;
    if (convId) {
      const hasRecentStream = state.recentStreamConvIds.some(e => e.convId === convId);
      if (!hasRecentStream) {
        saveError(tabId, {
          warning: "conversation_with_search_but_no_stream",
          conversation_id: convId,
          url: info.url,
          time: capturedAt,
          detail: "GET conversation contains search_result_groups but no stream capture was saved for this conversation_id in the last 5 minutes.",
        });
      }
    }
  }
}

// ── Debugger event handler ────────────────────────────────────────────────

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const tabId = source.tabId;
  const state = tabs.get(tabId);
  if (!state || !state.attached) return;

  // ── Network.requestWillBeSent ──────────────────────────────────────
  if (method === "Network.requestWillBeSent") {
    const url = params.request?.url || "";
    if (!CONV_PATTERN.test(url)) return;

    const reqMethod = params.request?.method || "GET";
    const requestId = params.requestId;

    if (!state.pendingRequests[requestId]) {
      state.pendingRequests[requestId] = {
        url,
        method: reqMethod,
        headers: {},
        startTime: new Date().toISOString(),
        sseChunks: [],
        dataChunks: [],       // base64 strings from dataReceived
        bufferedData: "",     // base64 from streamResourceContent
        streaming: false,
        streamPromise: null,
        streamError: null,
        requestBody: null,
        tabUrl: "",
        isStream: false,
        contentType: "",
      };
    } else {
      state.pendingRequests[requestId].url = url;
      state.pendingRequests[requestId].method = reqMethod;
    }

    // Capture POST body
    if (reqMethod === "POST" && params.request?.hasPostData) {
      try {
        const postData = params.request.postData;
        if (postData) {
          state.pendingRequests[requestId].requestBody = postData;
        } else {
          const result = await chrome.debugger.sendCommand(
            { tabId }, "Network.getRequestPostData", { requestId }
          );
          if (result?.postData) {
            state.pendingRequests[requestId].requestBody = result.postData;
          }
        }
      } catch (err) {
        console.warn("[sse-capture] getRequestPostData failed for %s: %s", requestId, err.message);
      }
    }

    try {
      const tab = await chrome.tabs.get(tabId);
      state.pendingRequests[requestId].tabUrl = tab.url || "";
    } catch (_) {}

    console.log("[sse-capture] request %s %s: %s", reqMethod, requestId, url);
  }

  // ── Network.responseReceived ───────────────────────────────────────
  if (method === "Network.responseReceived") {
    const url = params.response?.url || "";
    if (!CONV_PATTERN.test(url)) return;

    const requestId = params.requestId;

    if (!state.pendingRequests[requestId]) {
      state.pendingRequests[requestId] = {
        url,
        method: params.response?.requestHeaders?.[":method"] || "GET",
        headers: params.response?.headers || {},
        startTime: new Date().toISOString(),
        sseChunks: [],
        dataChunks: [],
        bufferedData: "",
        streaming: false,
        streamPromise: null,
        streamError: null,
        requestBody: null,
        tabUrl: "",
        isStream: false,
        contentType: "",
      };
    }

    const pending = state.pendingRequests[requestId];
    pending.headers = params.response?.headers || pending.headers;
    if (pending.method === "GET" && params.response?.requestHeaders?.[":method"]) {
      pending.method = params.response.requestHeaders[":method"];
    }

    const ct = (params.response?.headers?.["content-type"] || "").toLowerCase();
    pending.contentType = ct;

    // ── STREAM DETECTION: enable streamResourceContent IMMEDIATELY ──
    if (ct.includes("text/event-stream")) {
      pending.isStream = true;
      // Call streamResourceContent NOW, before any await.
      // This returns bufferedData and causes future dataReceived events
      // to include the actual data payload.
      pending.streamPromise = chrome.debugger.sendCommand(
        { tabId },
        "Network.streamResourceContent",
        { requestId }
      ).then(r => {
        pending.bufferedData = r?.bufferedData || "";
        pending.streaming = true;
        console.log("[sse-capture] streamResourceContent OK for %s (buffered=%d chars)",
          requestId, pending.bufferedData.length);
      }).catch(err => {
        pending.streamError = err.message;
        console.error("[sse-capture] streamResourceContent FAILED for %s: %s", requestId, err.message);
      });

      console.log("[sse-capture] stream detected, streamResourceContent called for %s: %s", requestId, url);
    }

    // Get tab URL (after stream command — this is non-critical)
    if (!pending.tabUrl) {
      try {
        const tab = await chrome.tabs.get(tabId);
        pending.tabUrl = tab.url || "";
      } catch (_) {}
    }

    console.log("[sse-capture] response %s: %s (ct=%s)", requestId, url, ct.slice(0, 40));
  }

  // ── Network.dataReceived ───────────────────────────────────────────
  // After streamResourceContent is called, params.data contains the
  // actual streamed bytes as base64. Push SYNCHRONOUSLY — no await.
  if (method === "Network.dataReceived") {
    const pending = state.pendingRequests[params.requestId];
    if (!pending) return;
    if (params.data) {
      pending.dataChunks.push(params.data);
    }
  }

  // ── Network.eventSourceMessageReceived (legacy/secondary) ──────────
  if (method === "Network.eventSourceMessageReceived") {
    const pending = state.pendingRequests[params.requestId];
    if (!pending) return;

    let frame = "";
    if (params.eventName) frame += `event: ${params.eventName}\n`;
    if (params.eventId) frame += `id: ${params.eventId}\n`;
    frame += `data: ${params.data}\n\n`;
    pending.sseChunks.push(frame);

    if (pending.sseChunks.length % 50 === 0) {
      try {
        await chrome.storage.session.set({
          [`pending_${tabId}_${params.requestId}`]: {
            url: pending.url,
            method: pending.method,
            sseChunks: pending.sseChunks,
          }
        });
      } catch (e) {
        console.warn("[sse-capture] session storage flush failed:", e.message);
      }
    }
  }

  // ── Network.loadingFinished ────────────────────────────────────────
  if (method === "Network.loadingFinished") {
    const pending = state.pendingRequests[params.requestId];
    if (!pending) return;

    let body = "";
    let captureMethod = "";

    // Priority 1: streamResourceContent data (bufferedData + dataChunks)
    if (pending.streamPromise) {
      await pending.streamPromise; // wait for bufferedData to arrive
    }

    if (pending.bufferedData || pending.dataChunks.length > 0) {
      // Decode all base64 to bytes, concatenate, then decode UTF-8 once
      body = assembleStreamBody(pending.bufferedData, pending.dataChunks);
      captureMethod = "streamResourceContent";
    }
    // Priority 2: eventSourceMessage chunks
    else if (pending.sseChunks.length > 0) {
      body = pending.sseChunks.join("");
      captureMethod = "eventSourceMessages";
    }
    // Priority 3: getResponseBody (works for non-stream responses)
    else {
      try {
        const result = await chrome.debugger.sendCommand(
          { tabId }, "Network.getResponseBody",
          { requestId: params.requestId }
        );
        if (result.base64Encoded) {
          body = new TextDecoder("utf-8").decode(base64ToBytes(result.body));
        } else {
          body = result.body;
        }
        captureMethod = "getResponseBody";
      } catch (err) {
        if (pending.isStream) {
          console.error("[sse-capture] ALL capture methods failed for stream %s: %s",
            params.requestId, err.message);
          saveError(tabId, {
            error: "stream_capture_failed",
            url: pending.url,
            method: pending.method,
            requestId: params.requestId,
            contentType: pending.contentType,
            streamError: pending.streamError,
            time: new Date().toISOString(),
            detail: "streamResourceContent: " + (pending.streamError || "not called") +
                    "; getResponseBody: " + err.message,
          });
          delete state.pendingRequests[params.requestId];
          return;
        }

        console.error("[sse-capture] getResponseBody failed for %s: %s",
          params.requestId, err.message);
        saveError(tabId, {
          error: "getResponseBody_failed",
          url: pending.url,
          method: pending.method,
          requestId: params.requestId,
          time: new Date().toISOString(),
          detail: err.message,
        });
        delete state.pendingRequests[params.requestId];
        return;
      }
    }

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
        requestBody: pending.requestBody,
      });
    } else if (pending.isStream) {
      saveError(tabId, {
        error: "stream_empty_body",
        url: pending.url,
        method: pending.method,
        requestId: params.requestId,
        streamError: pending.streamError,
        time: new Date().toISOString(),
        detail: "Stream body empty after all capture methods.",
      });
    }

    delete state.pendingRequests[params.requestId];
  }

  // ── Network.loadingFailed ──────────────────────────────────────────
  // If a tracked stream request fails (e.g. network error, abort),
  // save whatever data we have as a partial/truncated capture.
  if (method === "Network.loadingFailed") {
    const pending = state.pendingRequests[params.requestId];
    if (!pending) return;

    if (pending.streamPromise) {
      await pending.streamPromise;
    }

    const hasData = pending.bufferedData || pending.dataChunks.length > 0 || pending.sseChunks.length > 0;

    if (hasData) {
      let body = "";
      let captureMethod = "";

      if (pending.bufferedData || pending.dataChunks.length > 0) {
        body = assembleStreamBody(pending.bufferedData, pending.dataChunks);
        captureMethod = "streamResourceContent";
      } else if (pending.sseChunks.length > 0) {
        body = pending.sseChunks.join("");
        captureMethod = "eventSourceMessages";
      }

      if (body.length > 0) {
        saveCapture(tabId, params.requestId, {
          url: pending.url,
          method: pending.method,
          headers: pending.headers,
          startTime: pending.startTime,
          tabUrl: pending.tabUrl,
          body,
          captureMethod,
          requestBody: pending.requestBody,
          truncated: true,
        });
        console.warn("[sse-capture] loadingFailed for %s — saved %d bytes (truncated)",
          params.requestId, body.length);
      }
    }

    // Always record the failure
    saveError(tabId, {
      error: "loading_failed",
      url: pending.url,
      method: pending.method,
      requestId: params.requestId,
      errorText: params.errorText || "unknown",
      canceled: params.canceled || false,
      time: new Date().toISOString(),
      bytesReceived: pending.dataChunks.length,
      detail: hasData ? "partial data saved as truncated capture" : "no data received",
    });

    delete state.pendingRequests[params.requestId];
  }
});

// ── Debugger detach handler ───────────────────────────────────────────────

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
    tabs.delete(tabId);
    console.log("[sse-capture] tab %d closed, state cleaned up", tabId);
  }
});

// ── Message handler (popup) ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "getState") {
      const state = getTab(msg.tabId);
      sendResponse({
        attached: state.attached,
        captures: state.captures,
        streamCaptures: state.streamCaptures,
        lastFile: state.lastFile,
        lastStreamTime: state.lastStreamTime,
        label: state.label,
      });
    } else if (msg.type === "toggle") {
      const state = await toggleCapture(msg.tabId);
      sendResponse({
        attached: state.attached,
        captures: state.captures,
        streamCaptures: state.streamCaptures,
        lastFile: state.lastFile,
        lastStreamTime: state.lastStreamTime,
        label: state.label,
      });
    } else if (msg.type === "setLabel") {
      const state = getTab(msg.tabId);
      state.label = msg.label || "";
      sendResponse({ ok: true });
    }
  })();
  return true;
});
