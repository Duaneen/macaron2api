import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

const AUTH = { authorization: "Bearer test-secret" };

test("requires auth when API_KEY is configured", async () => {
  const upstream = await startMockUpstream();
  const app = await startApp(upstream.origin, { localApiKey: "test-secret" });

  try {
    const res = await fetch(`${app.origin}/v1/models`);
    const body = await res.json();

    assert.equal(res.status, 401);
    assert.equal(body.error.type, "authentication_error");
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("accepts x-api-key auth and returns request diagnostic headers", async () => {
  const upstream = await startMockUpstream();
  const app = await startApp(upstream.origin, { localApiKey: "test-secret" });

  try {
    const res = await fetch(`${app.origin}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-secret",
        "x-request-id": "req-123",
      },
      body: JSON.stringify({
        model: "macaron-v1-preview-b200",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    await res.json();

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-request-id"), "req-123");
    assert.equal(res.headers.get("x-macaron-upstream"), `${upstream.origin}/api/inline-chat`);
    assert.match(res.headers.get("access-control-expose-headers"), /x-request-id/);
    assert.match(res.headers.get("access-control-expose-headers"), /x-macaron-upstream/);
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("allows x-request-id on CORS preflight", async () => {
  const app = await startApp("http://127.0.0.1:9");

  try {
    const res = await fetch(`${app.origin}/v1/chat/completions`, {
      method: "OPTIONS",
      headers: {
        origin: "http://example.test",
        "access-control-request-headers": "x-request-id",
      },
    });

    assert.equal(res.status, 204);
    assert.match(res.headers.get("access-control-allow-headers"), /x-request-id/);
  } finally {
    await app.close();
  }
});

test("lists models and returns model details", async () => {
  const upstream = await startMockUpstream();
  const app = await startApp(upstream.origin, { localApiKey: "test-secret" });

  try {
    const listRes = await fetch(`${app.origin}/v1/models`, { headers: AUTH });
    const list = await listRes.json();

    assert.equal(listRes.status, 200);
    assert.equal(list.object, "list");
    assert.ok(list.data.some((model) => model.id === "macaron-v1-preview-b200"));

    const detailRes = await fetch(`${app.origin}/v1/models/macaron-v1-preview`, { headers: AUTH });
    const detail = await detailRes.json();

    assert.equal(detailRes.status, 200);
    assert.equal(detail.id, "macaron-v1-preview-b200");
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("aggregates Macaron NDJSON into OpenAI chat completion", async () => {
  const upstream = await startMockUpstream();
  const app = await startApp(upstream.origin, { localApiKey: "test-secret" });

  try {
    const res = await fetch(`${app.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        model: "macaron-v1-preview-b200",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.content, "Hello from Macaron.");
    assert.deepEqual(body.usage, {
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
    });
    assert.equal(upstream.requests.at(-1).path, "/api/inline-chat");
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("streams OpenAI SSE chunks", async () => {
  const upstream = await startMockUpstream();
  const app = await startApp(upstream.origin, { localApiKey: "test-secret" });

  try {
    const res = await fetch(`${app.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        model: "macaron-v1-preview-b200",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const text = await res.text();

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    assert.match(text, /"role":"assistant"/);
    assert.match(text, /"content":"Hello "/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("proxies raw Macaron NDJSON and routes non-Macaron models to plain chat", async () => {
  const upstream = await startMockUpstream();
  const app = await startApp(upstream.origin, { localApiKey: "test-secret" });

  try {
    const res = await fetch(`${app.origin}/api/chat`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        model: "doubao-seed-2-0-pro-260215",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const text = await res.text();

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/x-ndjson/);
    assert.match(text, /"type":"text-delta"/);
    assert.equal(upstream.requests.at(-1).path, "/api/plain-chat");
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("forwards sampling params and tools to the upstream", async () => {
  const upstream = await startMockUpstream();
  const app = await startApp(upstream.origin, { localApiKey: "test-secret" });

  try {
    const res = await fetch(`${app.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        model: "macaron-v1-preview-b200",
        temperature: 0.5,
        max_tokens: 64,
        tools: [{ type: "function", function: { name: "ping" } }],
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    await res.json();

    assert.equal(res.status, 200);
    const forwarded = upstream.requests.at(-1).body;
    assert.equal(forwarded.temperature, 0.5);
    assert.equal(forwarded.max_tokens, 64);
    assert.deepEqual(forwarded.tools, [{ type: "function", function: { name: "ping" } }]);
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("streams a valid finish_reason and an error field on upstream error", async () => {
  const upstream = await startMockUpstream({
    events: [
      { type: "text-delta", text: "partial" },
      { type: "error", error: "upstream blew up" },
    ],
  });
  const app = await startApp(upstream.origin, { localApiKey: "test-secret" });

  try {
    const res = await fetch(`${app.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        model: "macaron-v1-preview-b200",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const text = await res.text();

    assert.equal(res.status, 200);
    assert.match(text, /"message":"upstream blew up"/);
    // finish_reason must never be the non-standard "error" value.
    assert.doesNotMatch(text, /"finish_reason":"error"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("rejects invalid chat completion payloads", async () => {
  const upstream = await startMockUpstream();
  const app = await startApp(upstream.origin, { localApiKey: "test-secret" });

  try {
    const res = await fetch(`${app.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ model: "macaron-v1-preview-b200" }),
    });
    const body = await res.json();

    assert.equal(res.status, 400);
    assert.match(body.error.message, /messages/);
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("rejects malformed message entries as client errors", async () => {
  const upstream = await startMockUpstream();
  const app = await startApp(upstream.origin, { localApiKey: "test-secret" });

  try {
    const res = await fetch(`${app.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        model: "macaron-v1-preview-b200",
        messages: [null],
      }),
    });
    const body = await res.json();

    assert.equal(res.status, 400);
    assert.equal(body.error.type, "invalid_request_error");
    assert.match(body.error.message, /messages\[0\]/);
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("reports upstream fetch failures as upstream errors", async () => {
  const app = await startApp("http://upstream.test", {
    localApiKey: "test-secret",
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });

  try {
    const res = await fetch(`${app.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        model: "macaron-v1-preview-b200",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const body = await res.json();

    assert.equal(res.status, 502);
    assert.equal(body.error.type, "upstream_error");
    assert.match(body.error.message, /network down/);
  } finally {
    await app.close();
  }
});

test("falls back to browser transport for Vercel security checkpoint responses", async () => {
  let directCalls = 0;
  let browserCalls = 0;
  let browserInit = null;
  const app = await startApp("https://macaron-model-previews.macaron.im", {
    localApiKey: "test-secret",
    upstreamTransport: "auto",
    fetchImpl: async () => {
      directCalls += 1;
      return new Response("<html>Vercel Security Checkpoint</html>", {
        status: 429,
        statusText: "Too Many Requests",
        headers: {
          "content-type": "text/html; charset=utf-8",
          server: "Vercel",
          "x-vercel-mitigated": "challenge",
        },
      });
    },
    browserTransport: {
      fetch: async (url, init) => {
        browserCalls += 1;
        browserInit = { url, ...init };
        return new Response(
          [
            JSON.stringify({ type: "text-delta", text: "Hello through browser." }),
            JSON.stringify({ type: "step-finish", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } }),
            JSON.stringify({ type: "done" }),
            "",
          ].join("\n"),
          {
            status: 200,
            headers: { "content-type": "application/x-ndjson; charset=utf-8" },
          },
        );
      },
    },
  });

  try {
    const res = await fetch(`${app.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        model: "macaron-v1-preview-b200",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.choices[0].message.content, "Hello through browser.");
    assert.deepEqual(body.usage, {
      prompt_tokens: 2,
      completion_tokens: 3,
      total_tokens: 5,
    });
    assert.equal(directCalls, 1);
    assert.equal(browserCalls, 1);
    assert.equal(browserInit.url, "https://macaron-model-previews.macaron.im/api/inline-chat");
    assert.match(browserInit.body, /macaron-v1-preview-b200/);
  } finally {
    await app.close();
  }
});

test("reports Vercel security checkpoint when browser fallback is disabled", async () => {
  const app = await startApp("https://macaron-model-previews.macaron.im", {
    localApiKey: "test-secret",
    upstreamTransport: "direct",
    fetchImpl: async () =>
      new Response("<html>Vercel Security Checkpoint</html>", {
        status: 429,
        statusText: "Too Many Requests",
        headers: {
          "retry-after": "60",
          "x-vercel-mitigated": "challenge",
        },
      }),
  });

  try {
    const res = await fetch(`${app.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        model: "macaron-v1-preview-b200",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const body = await res.json();

    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "60");
    assert.equal(body.error.type, "rate_limit_error");
    assert.equal(body.error.vercel_mitigated, "challenge");
    assert.match(body.error.message, /Vercel Security Checkpoint/);
  } finally {
    await app.close();
  }
});

test("reports malformed upstream NDJSON as upstream errors", async () => {
  const upstream = await startMockUpstream({ rawResponse: "not-json\n" });
  const app = await startApp(upstream.origin, { localApiKey: "test-secret" });

  try {
    const res = await fetch(`${app.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        model: "macaron-v1-preview-b200",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const body = await res.json();

    assert.equal(res.status, 502);
    assert.equal(body.error.type, "upstream_error");
    assert.match(body.error.message, /Invalid NDJSON/);
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("enforces request body limit by utf8 byte length", async () => {
  const raw = JSON.stringify({
    model: "macaron-v1-preview-b200",
    messages: [{ role: "user", content: "你好你好你好" }],
  });
  const maxBodyBytes = raw.length + 1;
  const app = await startApp("http://127.0.0.1:9", {
    localApiKey: "test-secret",
    maxBodyBytes,
  });

  assert.ok(Buffer.byteLength(raw, "utf8") > maxBodyBytes);

  try {
    const res = await fetch(`${app.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: raw,
    });
    const body = await res.json();

    assert.equal(res.status, 413);
    assert.match(body.error.message, new RegExp(`Limit is ${maxBodyBytes} bytes`));
  } finally {
    await app.close();
  }
});

async function startMockUpstream(options = {}) {
  const events = options.events ?? [
    { type: "step-start" },
    { type: "text-delta", text: "Hello " },
    { type: "text-delta", text: "from Macaron." },
    { type: "step-finish", usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } },
    { type: "done" },
  ];
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const raw = await readRequestBody(req);
    requests.push({
      path: req.url,
      body: raw ? JSON.parse(raw) : null,
    });

    if (req.url !== "/api/inline-chat" && req.url !== "/api/plain-chat") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }

    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
    if (options.rawResponse !== undefined) {
      res.end(options.rawResponse);
      return;
    }

    res.end(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  });

  const origin = await listen(server);
  return {
    origin,
    requests,
    close: () => close(server),
  };
}

async function startApp(upstreamOrigin, overrides = {}) {
  const server = createApp({
    upstreamOrigin,
    localApiKey: "",
    logRequests: false,
    requestTimeoutMs: 5000,
    ...overrides,
  });

  const origin = await listen(server);
  return {
    origin,
    close: () => close(server),
  };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
