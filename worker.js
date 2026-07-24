// worker.js — Buffer Publishing Agent
// Runs on Cloudflare Workers. Handles: static UI (via /public), WebSocket chat,
// the Gemini function-calling loop, and the real calls to Buffer's GraphQL API.

import AGENTS_MD from "./AGENTS.md";

const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const BUFFER_URL = "https://api.buffer.com";
const MAX_AGENT_STEPS = 6; // safety limit on function-calling loop iterations

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- WebSocket chat endpoint ---
    if (url.pathname === "/ws") {
      return handleWebSocket(request, env);
    }

    // --- Buffer API key management (stored in KV, never exposed to the client) ---
    if (url.pathname === "/api/key") {
      return handleKeyRoute(request, env);
    }

    // --- Everything else: serve the static frontend from /public ---
    return env.ASSETS.fetch(request);
  },
};

// ---------------------------------------------------------------------------
// Buffer API key endpoint
// ---------------------------------------------------------------------------

// Read-only status check. Adding/changing the Buffer key itself is done manually
// from the Cloudflare Dashboard → KV → AGENT_KV → add an entry with key
// "buffer_api_key" and the token as the value. There is no write route on
// purpose — this is a single-key personal deployment.
async function handleKeyRoute(request, env) {
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, error: "method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }
  const key = await env.AGENT_KV.get("buffer_api_key");
  return new Response(JSON.stringify({ hasKey: Boolean(key) }), {
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// WebSocket handling
// ---------------------------------------------------------------------------

function handleWebSocket(request, env) {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected a WebSocket upgrade request", { status: 426 });
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  // Conversation history lives for the lifetime of this single connection.
  const contents = [];

  server.addEventListener("message", async (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return sendJSON(server, { type: "error", message: "رسالة غير مفهومة." });
    }

    if (payload.type !== "user_message" || !payload.text) return;

    contents.push({ role: "user", parts: [{ text: String(payload.text) }] });
    sendJSON(server, { type: "typing" });

    try {
      const replyText = await runAgentLoop(contents, env);
      sendJSON(server, { type: "agent_message", text: replyText });
    } catch (err) {
      sendJSON(server, {
        type: "error",
        message: `حصل خطأ: ${err.message || "غير معروف"}`,
      });
    }
  });

  server.addEventListener("close", () => {});

  return new Response(null, { status: 101, webSocket: client });
}

function sendJSON(ws, obj) {
  ws.send(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Agent loop — uses a hand-rolled JSON protocol instead of any provider's
// native "tools" API. This avoids provider-specific requirements (like
// Gemini's thought_signature) and means the same loop works unchanged with
// any plain text-in/text-out model — only callModel() needs to change if you
// swap providers.
//
// Protocol (defined in AGENTS.md, enforced here): the model must reply with
// exactly one JSON object per turn:
//   {"action":"call_function","name":"...","args":{...}}
//   {"action":"final_answer","text":"..."}
// ---------------------------------------------------------------------------

async function runAgentLoop(contents, env) {
  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const data = await callModel(contents, env);
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const rawText = parts.map((p) => p.text || "").join("").trim();

    // Keep the raw model turn in history so it has full context next loop.
    contents.push({ role: "model", parts: [{ text: rawText }] });

    const parsed = parseAgentResponse(rawText);

    if (parsed?.action === "call_function" && typeof parsed.name === "string") {
      let result;
      try {
        result = await executeTool(parsed.name, parsed.args || {}, env);
      } catch (err) {
        result = { error: err.message || "unknown error" };
      }

      // Function results go back in as a plain "user" turn (no special role
      // needed) wrapped in a clear marker so the model can recognize it.
      contents.push({
        role: "user",
        parts: [
          {
            text: `[FUNCTION_RESULT name="${parsed.name}"]\n${JSON.stringify(
              result
            )}\n[/FUNCTION_RESULT]`,
          },
        ],
      });
      continue;
    }

    if (parsed?.action === "final_answer" && typeof parsed.text === "string") {
      return parsed.text;
    }

    // Model didn't follow the protocol (e.g. plain prose). Fall back to
    // showing it as-is rather than failing the whole turn.
    return rawText || "معلش، مش قادر أرد دلوقتي. جرب تاني.";
  }

  return "الطلب محتاج خطوات كتير قوي، ممكن تبسطه أو تقسمه؟";
}

// Extracts a JSON object from the model's raw text, tolerating ```json fences.
function parseAgentResponse(text) {
  if (!text) return null;
  let cleaned = text.trim();
  const fenced = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) cleaned = fenced[1].trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// Plain generateContent call — no `tools`/`functionDeclarations` field at all.
// Swap this function alone to point at a different model/provider later.
async function callModel(contents, env) {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY مش متظبط في إعدادات الـ Worker (Secrets).");
  }

  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: AGENTS_MD }] },
      contents,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `Gemini API error (HTTP ${res.status})`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Tool execution — real calls to Buffer's GraphQL API
// ---------------------------------------------------------------------------

async function executeTool(name, args, env) {
  switch (name) {
    case "get_organizations": {
      const data = await bufferRequest(
        env,
        `query { account { id email organizations { id name } } }`
      );
      return data.account;
    }

    case "get_channels": {
      const data = await bufferRequest(
        env,
        `query($organizationId: OrganizationId!) {
          channels(input: { organizationId: $organizationId }) {
            id name service avatar isQueuePaused
          }
        }`,
        { organizationId: args.organizationId }
      );
      return data.channels;
    }

    case "create_post": {
      const input = {
        text: args.text,
        channelId: args.channelId,
        schedulingType: "automatic",
        mode: args.mode,
      };
      if (args.mode === "customScheduled" && args.dueAt) input.dueAt = args.dueAt;

      const data = await bufferRequest(
        env,
        `mutation($input: CreatePostInput!) {
          createPost(input: $input) {
            ... on PostActionSuccess { post { id text dueAt status } }
            ... on MutationError { message }
          }
        }`,
        { input }
      );
      return data.createPost;
    }

    case "create_idea": {
      const content = { text: args.text };
      if (args.title) content.title = args.title;

      const data = await bufferRequest(
        env,
        `mutation($input: CreateIdeaInput!) {
          createIdea(input: $input) {
            ... on Idea { id content { title text } }
            ... on MutationError { message }
          }
        }`,
        { input: { organizationId: args.organizationId, content } }
      );
      return data.createIdea;
    }

    case "get_posts": {
      const filter = {};
      if (args.status) filter.status = [args.status];
      if (args.channelIds) filter.channelIds = args.channelIds;

      const data = await bufferRequest(
        env,
        `query($input: PostsInput!, $first: Int!, $after: String) {
          posts(first: $first, after: $after, input: $input) {
            edges { node { id text dueAt status channelId } }
            pageInfo { hasNextPage endCursor }
            totalCount
          }
        }`,
        {
          input: { organizationId: args.organizationId, filter },
          first: args.first || 20,
          after: args.after || null,
        }
      );
      return data.posts;
    }

    case "get_post_metrics": {
      const data = await bufferRequest(
        env,
        `query($id: PostId!) {
          post(input: { id: $id }) {
            id text metrics { type name value unit } metricsUpdatedAt
          }
        }`,
        { id: args.postId }
      );
      return data.post;
    }

    case "get_aggregated_metrics": {
      const input = {
        organizationId: args.organizationId,
        startDateTime: args.startDateTime,
        endDateTime: args.endDateTime,
      };
      if (args.channelIds) input.channelIds = args.channelIds;

      const data = await bufferRequest(
        env,
        `query($input: AggregatedPostMetricsInput!) {
          aggregatedPostMetrics(input: $input) {
            metrics { type value unit }
            metricsUpdatedAt
          }
        }`,
        { input }
      );
      return data.aggregatedPostMetrics;
    }

    default:
      throw new Error(`أداة غير معروفة: ${name}`);
  }
}

async function bufferRequest(env, query, variables = {}) {
  const apiKey = await env.AGENT_KV.get("buffer_api_key");
  if (!apiKey) {
    throw new Error("مفيش مفتاح Buffer API متظبط في الـ KV. لازم يتضاف يدويًا (buffer_api_key) من Cloudflare Dashboard.");
  }

  const res = await fetch(BUFFER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await res.json();

  if (result.errors && result.errors.length > 0) {
    const code = result.errors[0].extensions?.code || "UNKNOWN";
    const message = result.errors[0].message || "Buffer API error";
    if (code === "RATE_LIMIT_EXCEEDED") {
      throw new Error("وصلت لحد الطلبات المسموح بيه على Buffer دلوقتي، جرب كمان شوية.");
    }
    if (code === "UNAUTHORIZED") {
      throw new Error("مفتاح Buffer API غلط أو منتهي. راجع القيمة المخزنة في KV تحت buffer_api_key.");
    }
    throw new Error(`Buffer (${code}): ${message}`);
  }

  return result.data;
}
