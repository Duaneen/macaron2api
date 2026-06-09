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

async function startMockUpstream() {
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
    res.end(
      [
        { type: "step-start" },
        { type: "text-delta", text: "Hello " },
        { type: "text-delta", text: "from Macaron." },
        { type: "step-finish", usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } },
        { type: "done" },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );
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
