const cardsEl = document.getElementById("cards");
const modelBreakdownEl = document.getElementById("model-breakdown");
const recentLogsEl = document.getElementById("recent-logs");
const windowSizeEl = document.getElementById("window-size");
const refreshBtn = document.getElementById("refresh-btn");
const btnOutage = document.getElementById("btn-outage");
const btnAbTest = document.getElementById("btn-abtest");
const resultEl = document.getElementById("resilience-result");

function formatMoney(n) {
  return `$${n.toFixed(4)}`;
}

// Always show Philippine time (Asia/Manila, UTC+8) regardless of the
// viewer's own device/browser timezone, since that's where the business
// (and whoever's checking this panel) operates.
function formatPhTime(isoString) {
  return new Date(isoString).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatPct(n) {
  return `${(n * 100).toFixed(0)}%`;
}

function card(label, value) {
  const el = document.createElement("div");
  el.className = "insights-card";
  el.innerHTML = `<p class="insights-card__label">${label}</p><p class="insights-card__value">${value}</p>`;
  return el;
}

async function loadSummary() {
  cardsEl.innerHTML = '<div class="insights-card insights-card--loading">Loading&hellip;</div>';
  try {
    const res = await fetch("/api/insights/summary");
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    const summary = await res.json();
    renderSummary(summary);
  } catch (err) {
    cardsEl.innerHTML = `<div class="insights-card insights-card--loading">Couldn't load insights: ${err.message}</div>`;
  }
}

function renderSummary(summary) {
  windowSizeEl.textContent = summary.windowSize;

  cardsEl.innerHTML = "";
  cardsEl.appendChild(card("Requests", summary.totalRequests));
  cardsEl.appendChild(card("Cache hit rate", formatPct(summary.cacheHitRate)));
  cardsEl.appendChild(card("Total spend", formatMoney(summary.totalCost)));
  cardsEl.appendChild(card("Avg latency", `${Math.round(summary.avgDurationMs)} ms`));
  cardsEl.appendChild(card("Errors", summary.errorCount));
  cardsEl.appendChild(card("Feedback", `\u{1F44D} ${summary.feedback.up} / \u{1F44E} ${summary.feedback.down}`));

  modelBreakdownEl.innerHTML = "";
  const maxCount = Math.max(1, ...summary.modelBreakdown.map((m) => m.count));
  for (const { model, count } of summary.modelBreakdown) {
    const row = document.createElement("div");
    row.className = "model-breakdown__row";
    row.innerHTML = `
      <span class="model-breakdown__label" title="${model}">${model}</span>
      <span class="model-breakdown__bar-track"><span class="model-breakdown__bar" style="width:${(count / maxCount) * 100}%"></span></span>
      <span class="model-breakdown__count">${count}</span>
    `;
    modelBreakdownEl.appendChild(row);
  }
  if (summary.modelBreakdown.length === 0) {
    modelBreakdownEl.innerHTML = '<p class="insights__panel-desc">No requests yet in this window.</p>';
  }

  recentLogsEl.innerHTML = "";
  if (summary.recentLogs.length === 0) {
    recentLogsEl.innerHTML = '<p class="insights__panel-desc">No recent activity.</p>';
    return;
  }
  const table = document.createElement("table");
  table.innerHTML = `
    <thead>
      <tr><th>Time (PH)</th><th>Provider</th><th>Model</th><th>Cost</th><th>Cached</th><th>Feedback</th><th></th></tr>
    </thead>
    <tbody>
      ${summary.recentLogs
        .map(
          (l) => `
        <tr>
          <td>${formatPhTime(l.created_at)}</td>
          <td>${l.provider ?? "-"}</td>
          <td title="${l.model ?? ""}">${l.model ?? "-"}</td>
          <td>${l.cost != null ? formatMoney(l.cost) : "-"}</td>
          <td>${l.cached ? "\u2705" : ""}</td>
          <td>${l.feedback === 1 ? "\u{1F44D}" : l.feedback === -1 ? "\u{1F44E}" : ""}</td>
          <td><button type="button" class="recent-logs__view-btn" data-log-id="${l.id}">View</button></td>
        </tr>`,
        )
        .join("")}
    </tbody>
  `;
  recentLogsEl.appendChild(table);
  for (const btn of table.querySelectorAll("[data-log-id]")) {
    btn.addEventListener("click", () => openConversation(btn.dataset.logId));
  }
}

// --- Conversation transcript modal ---

const modalEl = document.getElementById("conversation-modal");
const conversationBodyEl = document.getElementById("conversation-body");

function escapeHtml(str) {
  const escapes = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return str.replace(/[&<>"']/g, (ch) => escapes[ch]);
}

function closeModal() {
  modalEl.hidden = true;
}
modalEl.addEventListener("click", (event) => {
  if (event.target.hasAttribute("data-close")) closeModal();
});

async function openConversation(logId) {
  if (!modalEl || !conversationBodyEl) {
    console.error("Conversation modal elements not found in the DOM -- the deployed insights.html may be out of date.");
    return;
  }
  try {
    modalEl.hidden = false;
    conversationBodyEl.innerHTML = "<p class=\"insights__panel-desc\">Loading&hellip;</p>";
    if (!logId) throw new Error("Missing log id");

    const res = await fetch(`/api/insights/log?id=${encodeURIComponent(logId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    renderConversation(data);
  } catch (err) {
    console.error("openConversation failed:", err);
    conversationBodyEl.innerHTML = `<p class="insights__panel-desc">Couldn't load this conversation: ${escapeHtml(err.message ?? String(err))}</p>`;
  }
}

function renderConversation(data) {
  const turns = data.messages ?? [];
  let html = `<p class="transcript-meta">${turns.length} prior message(s) of context &middot; ${data.success === false ? "blocked/errored" : "succeeded"}${data.cost != null ? ` &middot; ${formatMoney(data.cost)}` : ""}</p>`;
  for (const turn of turns) {
    html += `<div class="transcript-turn transcript-turn--${turn.role === "user" ? "user" : "assistant"}">${escapeHtml(turn.content)}</div>`;
  }
  if (data.finalReply) {
    html += `<div class="transcript-turn transcript-turn--assistant transcript-turn--current">${escapeHtml(data.finalReply)}</div>`;
  } else if (data.success === false) {
    html += `<div class="transcript-turn transcript-turn--assistant transcript-turn--current">(this request was blocked or errored -- no reply was generated)</div>`;
  }
  conversationBodyEl.innerHTML = html;
}

async function runDemo(mode, button) {
  const otherButton = mode === "outage" ? btnAbTest : btnOutage;
  button.disabled = true;
  otherButton.disabled = true;
  resultEl.hidden = false;
  resultEl.innerHTML = "Calling the Gateway&hellip;";

  try {
    const res = await fetch("/api/demo/resilience", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

    resultEl.innerHTML = `
      <div class="resilience-result__meta">${data.label} &rarr; served by <strong>${data.provider ?? "?"}</strong> / ${data.model ?? "?"}${data.cached ? " (cached)" : ""}</div>
      <div>${data.text}</div>
    `;
  } catch (err) {
    resultEl.innerHTML = `<div class="resilience-result__meta">Error</div><div>${err.message}</div>`;
  } finally {
    button.disabled = false;
    otherButton.disabled = false;
    loadSummary();
  }
}

refreshBtn.addEventListener("click", loadSummary);
btnOutage.addEventListener("click", () => runDemo("outage", btnOutage));
btnAbTest.addEventListener("click", () => runDemo("ab-test", btnAbTest));

loadSummary();
