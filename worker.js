// worker.js — Buffer Publishing Agent
// Runs on Cloudflare Workers. Handles: static UI (via /public), WebSocket chat,
// the Gemini function-calling loop, and the real calls to Buffer's GraphQL API.

import AGENTS_MD from "./AGENTS.md";

const GEMINI_MODEL = "gemini-3.5-flash";
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

async function handleKeyRoute(request, env) {
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  if (request.method === "GET") {
    const key = await env.AGENT_KV.get("buffer_api_key");
    return json({ hasKey: Boolean(key) });
  }

  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid JSON" }, 400);
    }
    if (!body.apiKey || typeof body.apiKey !== "string") {
      return json({ ok: false, error: "apiKey is required" }, 400);
    }
    await env.AGENT_KV.put("buffer_api_key", body.apiKey.trim());
    return json({ ok: true });
  }

  if (request.method === "DELETE") {
    await env.AGENT_KV.delete("buffer_api_key");
    return json({ ok: true });
  }

  return json({ ok: false, error: "method not allowed" }, 405);
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
// Gemini function-calling loop
// ---------------------------------------------------------------------------

async function runAgentLoop(contents, env) {
  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const data = await callGemini(contents, env);
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    const functionCallPart = parts.find((p) => p.functionCall);

    if (functionCallPart) {
      const { name, args } = functionCallPart.functionCall;

      // Record the model's function call in history
      contents.push({ role: "model", parts: [{ functionCall: { name, args } }] });

      let result;
      try {
        result = await executeTool(name, args || {}, env);
      } catch (err) {
        result = { error: err.message || "unknown error" };
      }

      // Feed the function result back so the model can respond to the user
      contents.push({
        role: "function",
        parts: [{ functionResponse: { name, response: result } }],
      });

      continue; // let the model see the result and produce its next step
    }

    const textPart = parts.find((p) => typeof p.text === "string");
    const finalText = textPart ? textPart.text : "معلش، مش قادر أرد دلوقتي. جرب تاني.";
    contents.push({ role: "model", parts: [{ text: finalText }] });
    return finalText;
  }

  return "الطلب محتاج خطوات كتير قوي، ممكن تبسطه أو تقسمه؟";
}

async function callGemini(contents, env) {
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
      tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `Gemini API error (HTTP ${res.status})`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Tool declarations (schema exposed to Gemini)
// ---------------------------------------------------------------------------

const TOOL_DECLARATIONS = [
  {
    name: "get_organizations",
    description: "List the organizations (workspaces) on the authenticated Buffer account.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_channels",
    description: "List connected social channels (profiles) for a given organization.",
    parameters: {
      type: "object",
      properties: { organizationId: { type: "string" } },
      required: ["organizationId"],
    },
  },
  {
    name: "create_post",
    description: "Create/schedule a post on a single channel.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The post content." },
        channelId: { type: "string" },
        mode: {
          type: "string",
          enum: ["addToQueue", "customScheduled", "shareNow"],
        },
        dueAt: {
          type: "string",
          description: "ISO 8601 UTC datetime. Required only when mode is customScheduled.",
        },
      },
      required: ["text", "channelId", "mode"],
    },
  },
  {
    name: "create_idea",
    description: "Save a draft idea at the organization level (not tied to a channel or schedule).",
    parameters: {
      type: "object",
      properties: {
        organizationId: { type: "string" },
        text: { type: "string" },
        title: { type: "string" },
      },
      required: ["organizationId", "text"],
    },
  },
  {
    name: "get_posts",
    description: "List posts for an organization, optionally filtered by status/channels, paginated.",
    parameters: {
      type: "object",
      properties: {
        organizationId: { type: "string" },
        status: { type: "string", description: "e.g. scheduled, sent" },
        channelIds: { type: "array", items: { type: "string" } },
        first: { type: "number" },
        after: { type: "string" },
      },
      required: ["organizationId"],
    },
  },
  {
    name: "get_post_metrics",
    description: "Get performance metrics for a single sent post.",
    parameters: {
      type: "object",
      properties: { postId: { type: "string" } },
      required: ["postId"],
    },
  },
  {
    name: "get_aggregated_metrics",
    description: "Get rolled-up metrics across a date range (max 365 days), optionally filtered by channel.",
    parameters: {
      type: "object",
      properties: {
        organizationId: { type: "string" },
        startDateTime: { type: "string", description: "ISO 8601 UTC" },
        endDateTime: { type: "string", description: "ISO 8601 UTC" },
        channelIds: { type: "array", items: { type: "string" } },
      },
      required: ["organizationId", "startDateTime", "endDateTime"],
    },
  },
];

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
    throw new Error("مفيش مفتاح Buffer API متظبط. ضيفه من شاشة الإعدادات الأول.");
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
      throw new Error("مفتاح Buffer API غلط أو منتهي. راجعه من الإعدادات.");
    }
    throw new Error(`Buffer (${code}): ${message}`);
  }

  return result.data;
}
