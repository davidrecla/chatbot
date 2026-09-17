const cardsEl = document.getElementById("cards");
const modelBreakdownEl = document.getElementById("model-breakdown");
const customerSessionsEl = document.getElementById("customer-sessions");
const sessionsLoadMoreEl = document.getElementById("sessions-load-more");
const recentLogsEl = document.getElementById("recent-logs");
const windowSizeEl = document.getElementById("window-size");
const refreshBtn = document.getElementById("refresh-btn");
const btnAbTest = document.getElementById("btn-abtest");
const resultEl = document.getElementById("resilience-result");
const modalEl = document.getElementById("conversation-modal");
const conversationBodyEl = document.getElementById("conversation-body");
const SESSION_PAGE_SIZE = 25;
let sessionOffset = 0;
let loadedSessions = [];

const GUARDRAIL_REASONS = {
  P1: "Prompt Injection",
  S1: "Violent Crimes",
  S2: "Non-Violent Crimes",
  S3: "Sex-Related Crimes",
  S4: "Child Sexual Exploitation",
  S5: "Defamation",
  S6: "Specialized Advice",
  S7: "Privacy",
  S8: "Intellectual Property",
  S9: "Indiscriminate Weapons",
  S10: "Hate",
  S11: "Suicide and Self-Harm",
  S12: "Sexual Content",
  S13: "Elections",
};

const DLP_REASONS = {
  "0e1a3432-c838-4b28-b13e-2958047fad7c": "Source Code",
  "c23afc26-96f1-443b-8278-c96aa3200983": "C",
  "ebc203b6-01bf-49c3-96de-1407c34bf220": "C#",
  "4be29f9a-478c-4e13-b2bc-e23881ca339b": "C++",
  "2a868cb4-9f04-4b8c-b00e-a774a8fbf227": "Go",
  "de0115f3-b449-4123-8aff-712e78c8446a": "Haskell",
  "9fc25535-fcf8-4aa1-83b1-c814ee982b5b": "Java",
  "8a61bb3f-f29d-4881-9802-94034b19c471": "JavaScript",
  "3a7fdbfd-05d4-462b-a375-d191b10c8db5": "Lua",
  "7a3eae49-a13f-4053-a59d-7525278ed193": "Python",
  "124398db-41cc-4a6a-a980-83b699f45187": "R",
  "fd773453-c868-47e2-96f8-5f947c1a2c9d": "Rust",
  "77824044-8591-4845-99e3-687db70ab836": "Swift",
};

function formatMoney(n) {
  return `$${n.toFixed(4)}`;
}

function formatPhTime(value, includeDate = false) {
  const options = { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", second: "2-digit" };
  if (includeDate) Object.assign(options, { year: "numeric", month: "short", day: "numeric" });
  return new Date(value).toLocaleString("en-PH", options);
}

function formatPct(n) {
  return `${(n * 100).toFixed(0)}%`;
}

function escapeHtml(str) {
  const escapes = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(str).replace(/[&<>"']/g, (ch) => escapes[ch]);
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
    renderSummary(await res.json());
  } catch (err) {
    cardsEl.innerHTML = `<div class="insights-card insights-card--loading">Couldn't load insights: ${escapeHtml(err.message)}</div>`;
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
  cardsEl.appendChild(card("Feedback", `Up ${summary.feedback.up} / Down ${summary.feedback.down}`));

  modelBreakdownEl.innerHTML = "";
  const maxCount = Math.max(1, ...summary.modelBreakdown.map((model) => model.count));
  for (const { model, count } of summary.modelBreakdown) {
    const row = document.createElement("div");
    row.className = "model-breakdown__row";
    row.innerHTML = `
      <span class="model-breakdown__label" title="${escapeHtml(model)}">${escapeHtml(model)}</span>
      <span class="model-breakdown__bar-track"><span class="model-breakdown__bar" style="width:${(count / maxCount) * 100}%"></span></span>
      <span class="model-breakdown__count">${count}</span>`;
    modelBreakdownEl.appendChild(row);
  }
  if (!summary.modelBreakdown.length) modelBreakdownEl.innerHTML = '<p class="insights__panel-desc">No requests yet in this window.</p>';

  recentLogsEl.innerHTML = "";
  if (!summary.recentLogs.length) {
    recentLogsEl.innerHTML = '<p class="insights__panel-desc">No recent activity.</p>';
    return;
  }
  const table = document.createElement("table");
  table.innerHTML = `
    <thead><tr><th>Time (PH)</th><th>Provider</th><th>Model</th><th>Cost</th><th>Cached</th><th>Feedback</th><th></th></tr></thead>
    <tbody>${summary.recentLogs
      .map(
        (log) => `<tr>
          <td>${formatPhTime(log.created_at)}</td>
          <td>${escapeHtml(log.provider ?? "-")}</td>
          <td title="${escapeHtml(log.model ?? "")}">${escapeHtml(log.model ?? "-")}</td>
          <td>${log.cost != null ? formatMoney(log.cost) : "-"}</td>
          <td>${log.cached ? "Yes" : ""}</td>
          <td>${log.feedback === 1 ? "Up" : log.feedback === -1 ? "Down" : ""}</td>
          <td><button type="button" class="recent-logs__view-btn" data-log-id="${log.id}">View log</button></td>
        </tr>`,
      )
      .join("")}</tbody>`;
  recentLogsEl.appendChild(table);
  for (const button of table.querySelectorAll("[data-log-id]")) {
    button.addEventListener("click", () => openGatewayLog(button.dataset.logId));
  }
}

async function loadConversations(reset = false) {
  if (reset) {
    sessionOffset = 0;
    loadedSessions = [];
    customerSessionsEl.innerHTML = '<p class="insights__panel-desc">Loading&hellip;</p>';
  }
  try {
    const res = await fetch(`/api/insights/conversations?limit=${SESSION_PAGE_SIZE}&offset=${sessionOffset}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    loadedSessions.push(...data.conversations);
    sessionOffset = loadedSessions.length;
    renderConversations(loadedSessions);
    sessionsLoadMoreEl.hidden = sessionOffset >= data.total;
  } catch (err) {
    customerSessionsEl.innerHTML = `<p class="insights__panel-desc">Couldn't load customer sessions: ${escapeHtml(err.message)}</p>`;
    sessionsLoadMoreEl.hidden = true;
  }
}

function renderConversations(conversations) {
  if (!conversations.length) {
    customerSessionsEl.innerHTML = '<p class="insights__panel-desc">No customer sessions have been recorded yet.</p>';
    return;
  }
  const table = document.createElement("table");
  table.innerHTML = `
    <thead><tr><th>Last activity (PH)</th><th>Session ID</th><th>Messages</th><th>Flagged</th><th>Blocked</th><th>Guarded</th><th></th></tr></thead>
    <tbody>${conversations
      .map(
        (session) => `<tr>
          <td>${formatPhTime(session.lastActivityAt, true)}</td>
          <td title="${session.id}">${escapeHtml(session.id.slice(0, 8))}&hellip;</td>
          <td>${session.messageCount}</td>
          <td>${session.flaggedCount}</td>
          <td>${session.blockedCount}</td>
          <td>${session.guardedCount}</td>
          <td><button type="button" class="recent-logs__view-btn" data-conversation-id="${session.id}">View session</button></td>
        </tr>`,
      )
      .join("")}</tbody>`;
  customerSessionsEl.innerHTML = "";
  customerSessionsEl.appendChild(table);
  for (const button of table.querySelectorAll("[data-conversation-id]")) {
    button.addEventListener("click", () => openSession(button.dataset.conversationId));
  }
}

function closeModal() {
  modalEl.hidden = true;
}

modalEl.addEventListener("click", (event) => {
  if (event.target.hasAttribute("data-close")) closeModal();
});

async function openSession(conversationId) {
  modalEl.hidden = false;
  conversationBodyEl.innerHTML = '<p class="insights__panel-desc">Loading&hellip;</p>';
  try {
    const res = await fetch(`/api/insights/conversations/${encodeURIComponent(conversationId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    renderSession(data);
  } catch (err) {
    conversationBodyEl.innerHTML = `<p class="insights__panel-desc">Couldn't load this session: ${escapeHtml(err.message)}</p>`;
  }
}

async function openGatewayLog(logId) {
  modalEl.hidden = false;
  conversationBodyEl.innerHTML = '<p class="insights__panel-desc">Loading&hellip;</p>';
  try {
    const res = await fetch(`/api/insights/log?id=${encodeURIComponent(logId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    renderGatewayLog(data);
  } catch (err) {
    conversationBodyEl.innerHTML = `<p class="insights__panel-desc">Couldn't load this Gateway log: ${escapeHtml(err.message)}</p>`;
  }
}

function guardrailReason(categories) {
  return categories.map((code) => `${GUARDRAIL_REASONS[code] ?? "Unknown category"} (${code})`).join(", ");
}

function dlpReason(matches) {
  const serialized = matches.join(" ");
  const reasons = Object.entries(DLP_REASONS)
    .filter(([id]) => serialized.includes(id))
    .map(([, name]) => name);
  return [...new Set(reasons)].join(" · ") || "Matched DLP profile";
}

function securityBadges(message) {
  const badges = [];
  const warning = "AI Gateway evaluated the complete request context; this classification may include prior context.";
  if (message.outcome === "guarded") badges.push(["guarded", "Application injection defense · Prompt Injection", ""]);
  const guardrailResults = message.guardrailResults?.length
    ? message.guardrailResults
    : (message.guardrailCategories ?? []).map((code) => ({ code, action: message.guardrailAction }));
  for (const action of ["BLOCK", "FLAG"]) {
    const categories = guardrailResults.filter((result) => result.action === action).map((result) => result.code);
    if (!categories.length) continue;
    const reason = guardrailReason(categories);
    const target = message.role === "user" ? "request" : "response";
    badges.push([
      action === "BLOCK" ? "blocked" : "flagged",
      action === "BLOCK"
        ? `Blocked by Guardrails · ${reason}`
        : `Gateway ${target} flagged by Guardrails · ${reason} · Full-context scan`,
      warning,
    ]);
  }
  if (!guardrailResults.length && message.outcome === "blocked" && message.enforcement === "guardrails") {
    badges.push(["blocked", "Blocked by Guardrails", warning]);
  }
  if (message.dlpAction) {
    const target = message.role === "user" ? "request" : "response";
    badges.push([
      message.dlpAction === "BLOCK" ? "blocked" : "flagged",
      message.dlpAction === "BLOCK"
        ? `Blocked by DLP · ${dlpReason(message.dlpMatches ?? [])}`
        : `Gateway ${target} flagged by DLP · ${dlpReason(message.dlpMatches ?? [])}`,
      "",
    ]);
  } else if (message.outcome === "blocked" && message.enforcement === "dlp") {
    badges.push(["blocked", "Blocked by DLP", ""]);
  }
  if (message.outcome === "failed") badges.push(["failed", "Provider/Gateway failure", ""]);
  if (!badges.length) {
    if (message.enrichmentStatus === "pending") badges.push(["pending", "Security result pending", ""]);
    else if (message.enrichmentStatus === "unavailable") badges.push(["unavailable", "Gateway result unavailable", ""]);
    else badges.push(["clean", "No Gateway flags", ""]);
  }
  return badges
    .map(
      ([kind, label, title]) =>
        `<span class="transcript-outcome transcript-outcome--${kind}"${title ? ` title="${escapeHtml(title)}"` : ""}>${escapeHtml(label)}</span>`,
    )
    .join("");
}

function renderSession(data) {
  const session = data.conversation;
  let html = `<p class="transcript-meta">Session ${escapeHtml(session.id)} &middot; ${data.messages.length} customer-visible message(s) &middot; retained for 30 days</p>`;
  for (const message of data.messages) {
    html += `<div class="transcript-turn transcript-turn--${message.role} transcript-turn--${message.outcome}">${securityBadges(message)}${escapeHtml(message.content)}</div>`;
  }
  conversationBodyEl.innerHTML = html;
}

function renderGatewayLog(data) {
  const turns = data.messages ?? [];
  let html = `<p class="transcript-meta">${turns.length} message(s) from one technical Gateway request</p>`;
  for (const turn of turns) {
    html += `<div class="transcript-turn transcript-turn--${turn.role === "user" ? "user" : "assistant"}">${escapeHtml(turn.content)}</div>`;
  }
  if (data.finalReply) html += `<div class="transcript-turn transcript-turn--assistant transcript-turn--current">${escapeHtml(data.finalReply)}</div>`;
  else if (data.success === false) html += '<div class="transcript-turn transcript-turn--assistant transcript-turn--current">(request blocked or errored)</div>';
  conversationBodyEl.innerHTML = html;
}

async function runDemo(button) {
  button.disabled = true;
  resultEl.hidden = false;
  resultEl.innerHTML = "Calling the Gateway&hellip;";
  try {
    const res = await fetch("/api/demo/resilience", { method: "POST", headers: { "content-type": "application/json" } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    resultEl.innerHTML = `<div class="resilience-result__meta">${escapeHtml(data.label)} &rarr; served by <strong>${escapeHtml(data.provider ?? "?")}</strong> / ${escapeHtml(data.model ?? "?")}${data.cached ? " (cached)" : ""}</div><div>${escapeHtml(data.text)}</div>`;
  } catch (err) {
    resultEl.innerHTML = `<div class="resilience-result__meta">Error</div><div>${escapeHtml(err.message)}</div>`;
  } finally {
    button.disabled = false;
    loadSummary();
  }
}

refreshBtn.addEventListener("click", () => {
  loadSummary();
  loadConversations(true);
});
sessionsLoadMoreEl.addEventListener("click", () => loadConversations(false));
btnAbTest.addEventListener("click", () => runDemo(btnAbTest));

loadSummary();
loadConversations(true);
