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

// ── Save capture to disk ──────────────────────────────────────────────────

/**
 * Encode a string as a base64 data: URL.
 * Uses encodeURIComponent + unescape to handle UTF-8 correctly
 * before btoa (which only accepts Latin-1 / binary-safe input).
 */
function toDataUrl(str, mime) {
  const b64 = btoa(unescape(encodeURIComponent(str)));
  return `data:${mime};base64,${b64}`;
}

function saveCapture(tabId, requestId, info) {
  const state = getTab(tabId);
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const baseName = `${stamp}_${requestId}`;

  // Raw body — save as .txt via data: URL (no Blob/createObjectURL needed)
  chrome.downloads.download(
    {
      url: toDataUrl(info.body, "text/plain"),
      filename: `sse-capture/${baseName}.txt`,
      conflictAction: "uniquify",
      saveAs: false,
    },
    () => {
      if (chrome.runtime.lastError) {
        console.error("[sse-capture] body download failed: %s", chrome.runtime.lastError.message);
      }
    }
  );

  // Sidecar metadata
  const meta = {
    url: info.url,
    method: info.method,
    responseHeaders: info.headers,
    startTime: info.startTime,
    endTime: now.toISOString(),
    tabUrl: info.tabUrl,
    captureMethod: info.captureMethod, // "getResponseBody" or "eventSourceMessages"
    bodyBytes: info.body.length,
  };
  if (state.label) {
    meta.label = state.label;
  }

  chrome.downloads.download(
    {
      url: toDataUrl(JSON.stringify(meta, null, 2), "application/json"),
      filename: `sse-capture/${baseName}.meta.json`,
      conflictAction: "uniquify",
      saveAs: false,
    },
    () => {
      if (chrome.runtime.lastError) {
        console.error("[sse-capture] meta download failed: %s", chrome.runtime.lastError.message);
      }
    }
  );

  state.captures++;
  state.lastFile = `${baseName}.txt`;
  console.log("[sse-capture] saved capture #%d: %s (%d bytes)",
    state.captures, baseName, info.body.length);
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
