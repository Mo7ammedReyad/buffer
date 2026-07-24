// app.js — client-side logic for the Buffer Publishing Agent UI
// Handles: WebSocket chat connection, rendering messages, and Buffer API key management.

const messagesEl = document.getElementById("messages");
const composerEl = document.getElementById("composer");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send-btn");
const connDot = document.getElementById("conn-dot");
const connLabel = document.getElementById("conn-label");
const connText = document.getElementById("conn-text");
const sidebarEl = document.getElementById("sidebar");
const toggleSidebarBtn = document.getElementById("toggle-sidebar-btn");

const keyInput = document.getElementById("buffer-key-input");
const saveKeyBtn = document.getElementById("save-key-btn");
const keyStatusEl = document.getElementById("key-status");

let ws = null;
let reconnectDelay = 1000;
let typingBubble = null;

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.addEventListener("open", () => {
    setConnected(true);
    reconnectDelay = 1000;
  });

  ws.addEventListener("close", () => {
    setConnected(false);
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    ws.close();
  });

  ws.addEventListener("message", (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServerMessage(data);
  });
}

function scheduleReconnect() {
  setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.6, 15000);
}

function setConnected(isConnected) {
  connDot.classList.toggle("connected", isConnected);
  connLabel.textContent = isConnected ? "متصل" : "مقطوع، بيحاول تاني...";
  connText.textContent = isConnected ? "Buffer Agent" : "غير متصل";
  sendBtn.disabled = !isConnected;
}

function handleServerMessage(data) {
  if (data.type === "typing") {
    showTyping();
    return;
  }
  hideTyping();

  if (data.type === "agent_message") {
    addMessage(data.text, "agent");
  } else if (data.type === "error") {
    addMessage(data.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Sending messages
// ---------------------------------------------------------------------------

composerEl.addEventListener("submit", (e) => {
  e.preventDefault();
  sendCurrentInput();
});

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendCurrentInput();
  }
});

inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + "px";
});

function sendCurrentInput() {
  const text = inputEl.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

  addMessage(text, "user");
  ws.send(JSON.stringify({ type: "user_message", text }));

  inputEl.value = "";
  inputEl.style.height = "auto";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function addMessage(text, kind) {
  const div = document.createElement("div");
  div.className = `msg ${kind}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollToBottom();
}

function showTyping() {
  if (typingBubble) return;
  typingBubble = document.createElement("div");
  typingBubble.className = "typing";
  typingBubble.innerHTML = "<span></span><span></span><span></span>";
  messagesEl.appendChild(typingBubble);
  scrollToBottom();
}

function hideTyping() {
  if (typingBubble) {
    typingBubble.remove();
    typingBubble = null;
  }
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// Buffer API key management
// ---------------------------------------------------------------------------

async function loadKeyStatus() {
  try {
    const res = await fetch("/api/key");
    const data = await res.json();
    setKeyStatus(data.hasKey);
  } catch {
    keyStatusEl.textContent = "معرفناش نتأكد من الحالة";
    keyStatusEl.className = "key-status";
  }
}

function setKeyStatus(hasKey) {
  if (hasKey) {
    keyStatusEl.textContent = "✓ مفتاح محفوظ";
    keyStatusEl.className = "key-status ok";
  } else {
    keyStatusEl.textContent = "✕ لسه مفيش مفتاح متضاف";
    keyStatusEl.className = "key-status missing";
  }
}

saveKeyBtn.addEventListener("click", async () => {
  const apiKey = keyInput.value.trim();
  if (!apiKey) return;

  saveKeyBtn.disabled = true;
  saveKeyBtn.textContent = "بيحفظ...";

  try {
    const res = await fetch("/api/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });
    const data = await res.json();
    if (data.ok) {
      keyInput.value = "";
      setKeyStatus(true);
    } else {
      keyStatusEl.textContent = "✕ فشل الحفظ";
      keyStatusEl.className = "key-status missing";
    }
  } catch {
    keyStatusEl.textContent = "✕ فشل الاتصال بالسيرفر";
    keyStatusEl.className = "key-status missing";
  } finally {
    saveKeyBtn.disabled = false;
    saveKeyBtn.textContent = "حفظ";
  }
});

toggleSidebarBtn.addEventListener("click", () => {
  sidebarEl.classList.toggle("open");
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadKeyStatus();
connect();
