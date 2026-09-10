const messagesEl = document.getElementById("messages");
const formEl = document.getElementById("composer");
const inputEl = document.getElementById("input");
const sendButtonEl = document.getElementById("send-button");

/** Renders a new message bubble and returns its content element (for streaming updates). */
function appendMessage(role, text, { pending = false, error = false } = {}) {
  const bubble = document.createElement("div");
  bubble.className = `msg msg--${role}${pending ? " msg--pending" : ""}${error ? " msg--error" : ""}`;
  bubble.textContent = text;
  messagesEl.appendChild(bubble);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return bubble;
}

function autoGrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`;
}
inputEl.addEventListener("input", autoGrow);

async function sendMessage(message) {
  sendButtonEl.disabled = true;
  const assistantBubble = appendMessage("assistant", "", { pending: true });

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });

    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    assistantBubble.classList.remove("msg--pending");

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const raw of events) {
        const isDone = raw.startsWith("event: done");
        const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
        if (!dataLine) continue;
        const json = dataLine.slice("data:".length).trim();
        if (!json || isDone) continue;
        full += JSON.parse(json);
        assistantBubble.textContent = full;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }

    if (!full) {
      assistantBubble.textContent = "Sorry, I didn't get a response. Please try again.";
      assistantBubble.classList.add("msg--error");
    }
  } catch (err) {
    assistantBubble.classList.remove("msg--pending");
    assistantBubble.classList.add("msg--error");
    assistantBubble.textContent = `Sorry, something went wrong: ${err.message}`;
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
