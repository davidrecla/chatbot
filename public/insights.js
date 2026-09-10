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
      <tr><th>Time</th><th>Provider</th><th>Model</th><th>Cost</th><th>Cached</th><th>Feedback</th></tr>
    </thead>
    <tbody>
      ${summary.recentLogs
        .map(
          (l) => `
        <tr>
          <td>${new Date(l.created_at).toLocaleTimeString()}</td>
          <td>${l.provider ?? "-"}</td>
          <td title="${l.model ?? ""}">${l.model ?? "-"}</td>
          <td>${l.cost != null ? formatMoney(l.cost) : "-"}</td>
          <td>${l.cached ? "\u2705" : ""}</td>
          <td>${l.feedback === 1 ? "\u{1F44D}" : l.feedback === -1 ? "\u{1F44E}" : ""}</td>
        </tr>`,
        )
        .join("")}
    </tbody>
  `;
  recentLogsEl.appendChild(table);
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
