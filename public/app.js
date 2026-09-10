const messagesEl = document.getElementById("messages");
const formEl = document.getElementById("composer");
const inputEl = document.getElementById("input");
const sendButtonEl = document.getElementById("send-button");
const modelIndicatorEl = document.getElementById("model-indicator");

// Real chat pacing: a pause where nothing shows (like reading the message),
// then a "typing..." pause scaled to how long the reply is, then the whole
// message lands at once, the way people actually message each other rather
// than a token-by-token drip.
const SEEN_DELAY_MIN_MS = 1200;
const SEEN_DELAY_MAX_MS = 2200;
const TYPING_BASE_MS = 800;
const TYPING_PER_CHAR_MS = 8;
const TYPING_MIN_MS = 1200;
const TYPING_MAX_MS = 4000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function typingDurationFor(text) {
  const raw = TYPING_BASE_MS + text.length * TYPING_PER_CHAR_MS;
  return Math.min(Math.max(raw, TYPING_MIN_MS), TYPING_MAX_MS);
}

// --- Minimal, safe markdown -> HTML for chat bubbles: **bold** and links. ---

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function renderMarkdownLite(text) {
  const placeholders = [];
  const stash = (html) => {
    const token = `\u0000${placeholders.length}\u0000`;
    placeholders.push(html);
    return token;
  };

  let html = escapeHtml(text);

  // [label](url) markdown links first, then any remaining bare URLs.
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label, url) => stash(`<a href="${url}" target="_blank" rel="noopener">${label}</a>`),
  );
  html = html.replace(/https?:\/\/[^\s<]+/g, (url) => stash(`<a href="${url}" target="_blank" rel="noopener">${url}</a>`));

  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => placeholders[Number(i)]);
}

function appendMessage(role, text) {
  const row = document.createElement("div");
  row.className = `msg-row msg-row--${role}`;

  if (role === "assistant") {
    const avatar = document.createElement("img");
    avatar.className = "msg-avatar";
    avatar.src = "/assets/logo.png";
    avatar.alt = "";
    row.appendChild(avatar);
  }

  const col = document.createElement("div");
  col.className = "msg-col";

  const bubble = document.createElement("div");
  bubble.className = `msg msg--${role}`;
  bubble.textContent = text;
  col.appendChild(bubble);
  row.appendChild(col);

  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return bubble;
}

/** Creates an empty assistant bubble (inside a column, for feedback controls later) showing an animated "typing..." indicator. */
function appendTypingBubble() {
  const row = document.createElement("div");
  row.className = "msg-row msg-row--assistant";

  const avatar = document.createElement("img");
  avatar.className = "msg-avatar";
  avatar.src = "/assets/logo.png";
  avatar.alt = "";
  row.appendChild(avatar);

  const col = document.createElement("div");
  col.className = "msg-col";

  const bubble = document.createElement("div");
  bubble.className = "msg msg--assistant msg--pending";
  bubble.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
  col.appendChild(bubble);
  row.appendChild(col);

  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return bubble;
}

/** Adds 👍/👎 controls below a reply, wired to POST /api/feedback (AI Gateway patchLog). */
function addFeedbackControls(bubble, logId) {
  const col = bubble.parentElement;
  if (!col) return;

  const wrap = document.createElement("div");
  wrap.className = "msg-feedback";

  const makeButton = (label, rating) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "msg-feedback__btn";
    btn.textContent = label;
    btn.setAttribute("aria-label", rating === 1 ? "Good response" : "Not helpful");
    btn.addEventListener("click", async () => {
      for (const el of wrap.querySelectorAll("button")) el.disabled = true;
      btn.classList.add("msg-feedback__btn--selected");
      try {
        await fetch("/api/feedback", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ logId, rating }),
        });
      } catch {
        // Feedback is a nice-to-have -- silently ignore network failures here.
      }
    });
    return btn;
  };

  wrap.appendChild(makeButton("\u{1F44D}", 1));
  wrap.appendChild(makeButton("\u{1F44E}", -1));
  col.appendChild(wrap);
}

/** Shows/updates the footer's "currently answering with: <model>" indicator (demo visibility into the model-tier routing). */
function updateModelIndicator(model) {
  if (!model) return;
  modelIndicatorEl.textContent = `Currently answering with: ${model}`;
  modelIndicatorEl.hidden = false;
}

/** A small "via <model>" caption under a reply, so escalation across a conversation is visible turn by turn. */
function addModelTag(bubble, model) {
  if (!model) return;
  const col = bubble.parentElement;
  if (!col) return;
  const tag = document.createElement("p");
  tag.className = "msg-model-tag";
  tag.textContent = `via ${model}`;
  col.appendChild(tag);
}

function autoGrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`;
}
inputEl.addEventListener("input", autoGrow);

/** Reads the full SSE stream from `res`, returning the reply text, the Gateway log id, and which model answered. */
async function collectFullText(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let full = "";
  let logId = null;
  let model = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });

    const events = sseBuffer.split("\n\n");
    sseBuffer = events.pop() ?? "";
    for (const raw of events) {
      const eventLine = raw.split("\n").find((line) => line.startsWith("event:"));
      const eventName = eventLine?.slice("event:".length).trim();
      const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      const json = dataLine.slice("data:".length).trim();
      if (!json) continue;

      if (eventName === "meta") {
        const meta = JSON.parse(json);
        logId = meta.logId ?? null;
        model = meta.model ?? null;
      } else if (eventName !== "done") {
        full += JSON.parse(json);
      }
    }
  }
  return { full, logId, model };
}

async function sendMessage(message) {
  sendButtonEl.disabled = true;

  // Fire the request immediately so network latency overlaps with the
  // "seen" delay below, instead of adding on top of it.
  const fetchPromise = fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });

  // Brief pause with no indicator at all, like someone reading your message
  // before they start typing back.
  await sleep(randomBetween(SEEN_DELAY_MIN_MS, SEEN_DELAY_MAX_MS));
  const bubble = appendTypingBubble();
  const typingStartedAt = Date.now();

  try {
    const res = await fetchPromise;
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status})`);
    }

    const { full, logId, model } = await collectFullText(res);

    // Keep the typing indicator up for a duration scaled to the reply's
    // length, even if the network already finished faster than that.
    const remaining = typingDurationFor(full) - (Date.now() - typingStartedAt);
    if (remaining > 0) await sleep(remaining);

    bubble.classList.remove("msg--pending");
    if (!full.trim()) {
      bubble.classList.add("msg--error");
      bubble.textContent = "Sorry, I didn't get a response. Please try again.";
    } else {
      bubble.innerHTML = renderMarkdownLite(full);
      if (logId) addFeedbackControls(bubble, logId);
      addModelTag(bubble, model);
      updateModelIndicator(model);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } catch (err) {
    bubble.classList.remove("msg--pending");
    bubble.classList.add("msg--error");
    bubble.textContent = `Sorry, something went wrong: ${err.message}`;
  } finally {
    sendButtonEl.disabled = false;
  }
}

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = inputEl.value.trim();
  if (!message) return;

  appendMessage("user", message);
  inputEl.value = "";
  autoGrow();
  sendMessage(message);
});

inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    formEl.requestSubmit();
  }
});
