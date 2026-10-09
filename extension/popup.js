// Copyright 2026 Artur Ferreira (The GEO Lab)
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0
// See the NOTICE file distributed with this work for attribution.

const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const toggleBtn = document.getElementById("toggleBtn");
const captureCount = document.getElementById("captureCount");
const streamCount = document.getElementById("streamCount");
const lastStreamTime = document.getElementById("lastStreamTime");
const lastFile = document.getElementById("lastFile");
const labelInput = document.getElementById("labelInput");
const warn = document.getElementById("warn");

let currentTabId = null;

function formatTime(iso) {
  if (!iso) return "--";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString();
  } catch (_) {
    return iso;
  }
}

function updateUI(state) {
  if (state.attached) {
    dot.classList.add("recording");
    statusText.textContent = "Recording";
    toggleBtn.textContent = "Stop Capture";
    toggleBtn.classList.add("stop");
  } else {
    dot.classList.remove("recording");
    statusText.textContent = "Off";
    toggleBtn.textContent = "Start Capture";
    toggleBtn.classList.remove("stop");
  }
  captureCount.textContent = state.captures || 0;
  streamCount.textContent = state.streamCaptures || 0;
  lastStreamTime.textContent = formatTime(state.lastStreamTime);
  lastFile.textContent = state.lastFile || "--";
  labelInput.value = state.label || "";
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  currentTabId = tab.id;

  if (!tab.url || !tab.url.includes("chatgpt.com")) {
    toggleBtn.disabled = true;
    toggleBtn.textContent = "Not on chatgpt.com";
    warn.textContent = "Navigate to chatgpt.com to use capture.";
    return;
  }

  chrome.runtime.sendMessage(
    { type: "getState", tabId: currentTabId },
    (resp) => {
      if (resp) updateUI(resp);
    }
  );
}

toggleBtn.addEventListener("click", () => {
  if (!currentTabId) return;
  chrome.runtime.sendMessage(
    { type: "toggle", tabId: currentTabId },
    (resp) => {
      if (resp) updateUI(resp);
    }
  );
});

labelInput.addEventListener("input", () => {
  if (!currentTabId) return;
  chrome.runtime.sendMessage({
    type: "setLabel",
    tabId: currentTabId,
    label: labelInput.value,
  });
});

init();
