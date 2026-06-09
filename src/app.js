import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

export const DEFAULT_ORIGIN = "https://macaron-model-previews.macaron.im";
export const DEFAULT_MODEL = "macaron-v1-preview-b200";

export const MACARON_MODELS = new Set([
  "macaron-v1-preview-sglang",
  "macaron-v1-preview-baseline",
  "macaron-v1-preview-b200",
  "macaron-v1-preview-tilert",
]);

export const MODEL_IDS = [
  ...MACARON_MODELS,
  "pa/gemini-3.5-flash",
  "pa/gemini-3.1-pro-preview",
  "pa/gpt-5.4",
  "pa/claude-sonnet-4-6",
  "zai-org/glm-5.1",
  "xiaomimimo/mimo-v2.5-pro",
  "qwen/qwen3.7-max",
  "minimax/minimax-m2.7",
  "deepseek/deepseek-v4-pro",
  "kimi-k2-thinking",
  "doubao-seed-2-0-pro-260215",
  "zai-glm-4.7",
  "gpt-oss-120b",
  "gpt-5.5",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
];

export const MODEL_ALIASES = {
  macaron: DEFAULT_MODEL,
  "macaron-v1-preview": DEFAULT_MODEL,
  "macaron-v1-preview-latest": DEFAULT_MODEL,
};

const REASONING_OPTIONS = {
  "pa/gemini-3.5-flash": ["minimal", "low", "medium", "high"],
  "pa/gemini-3.1-pro-preview": ["minimal", "low", "medium", "high"],
  "pa/gpt-5.4": ["low", "medium", "high", "xhigh"],
  "pa/claude-sonnet-4-6": ["enabled", "none"],
  "zai-org/glm-5.1": ["enabled", "none"],
  "xiaomimimo/mimo-v2.5-pro": ["enabled", "none"],
  "qwen/qwen3.7-max": ["enabled", "none"],
  "minimax/minimax-m2.7": ["enabled"],
  "kimi-k2-thinking": ["enabled"],
  "deepseek/deepseek-v4-pro": ["enabled", "none"],
  "doubao-seed-2-0-pro-260215": ["enabled", "none"],
  "zai-glm-4.7": ["enabled", "none"],
  "gpt-oss-120b": ["low", "medium", "high"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high", "xhigh"],
  "gpt-5.3-codex-spark": ["low", "medium", "high", "xhigh"],
  "macaron-v1-preview-tilert": ["enabled", "none"],
  "macaron-v1-preview-b200": ["enabled", "none"],
  "macaron-v1-preview-sglang": ["enabled", "none"],
  "macaron-v1-preview-baseline": ["enabled", "none"],
};

export function loadConfig(env = process.env) {
  return {
    upstreamOrigin: stripTrailingSlash(env.MACARON_ORIGIN || DEFAULT_ORIGIN),
    port: parsePositiveInteger(env.PORT, 8787),
    localApiKey: env.API_KEY || "",
    upstreamApiKey: env.MACARON_UPSTREAM_API_KEY || "",
    upstreamBaseUrl: env.MACARON_UPSTREAM_BASE_URL || "",
    requestTimeoutMs: parsePositiveInteger(env.MACARON_TIMEOUT_MS, 120000),
    maxBodyBytes: parsePositiveInteger(env.MACARON_MAX_BODY_BYTES, 20 * 1024 * 1024),
    corsAllowOrigin: env.CORS_ALLOW_ORIGIN || "*",
    allowUnknownModels: parseBoolean(env.MACARON_ALLOW_UNKNOWN_MODELS),
    defaultModel: env.MACARON_DEFAULT_MODEL || DEFAULT_MODEL,
    logRequests: env.LOG_REQUESTS !== "0",
    fetchImpl: globalThis.fetch,
  };
}

export function createApp(configInput = loadConfig()) {
  const config = normalizeConfig(configInput);

  return http.createServer(async (req, res) => {
    const requestId = getRequestId(req);
    const started = Date.now();
    res.setHeader("x-request-id", requestId);

    if (config.logRequests) {
      res.on("finish", () => {
        console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms ${requestId}`);
      });
    }

    try {
      await handleRequest(req, res, config);
    } catch (error) {
      sendThrownError(res, error);
    }
  });
}

async function handleRequest(req, res, config) {
  setCorsHeaders(res, config);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/" && req.method === "GET") {
    sendDocs(res, config);
    return;
  }

  if (url.pathname === "/health" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      upstream: config.upstreamOrigin,
      default_model: config.defaultModel,
    });
    return;
  }

  if (url.pathname === "/v1/models") {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    if (!isAuthorized(req, config)) return sendUnauthorized(res);
    sendJson(res, 200, {
      object: "list",
      data: MODEL_IDS.map((id) => modelObject(id)),
    });
    return;
  }

  if (url.pathname.startsWith("/v1/models/")) {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    if (!isAuthorized(req, config)) return sendUnauthorized(res);
    const modelId = decodeURIComponent(url.pathname.slice("/v1/models/".length));
    const model = resolveModel(modelId, config);
    sendJson(res, 200, modelObject(model));
    return;
  }

  if (url.pathname === "/v1/chat/completions") {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    if (!isAuthorized(req, config)) return sendUnauthorized(res);
    const body = await readJson(req, config);
    validateChatCompletionRequest(body);
    await handleChatCompletions(req, res, body, config);
    return;
  }

  if (url.pathname === "/api/chat") {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    if (!isAuthorized(req, config)) return sendUnauthorized(res);
    const body = await readJson(req, config);
    await handleRawChat(req, res, body, config);
    return;
  }

  sendJson(res, 404, {
    error: {
      message: "Route not found.",
      type: "not_found",
    },
  });
}

async function handleChatCompletions(req, res, body, config) {
  const model = resolveModel(body.model || config.defaultModel, config);
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${randomUUID()}`;
  const targetBody = toMacaronRequest(body, model, req, config);
  const requestContext = createUpstreamContext(res, config);

  try {
    const upstream = await callMacaron(model, targetBody, req, config, requestContext.signal);

    if (!upstream.ok) {
      await sendUpstreamError(res, upstream, model);
      return;
    }

    if (body.stream) {
      await streamOpenAiResponse(res, upstream, { id, created, model });
      return;
    }

    const aggregate = await collectMacaronEvents(upstream);
    sendJson(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: aggregate.content,
            ...(aggregate.reasoning ? { reasoning_content: aggregate.reasoning } : {}),
          },
          finish_reason: "stop",
        },
      ],
      usage: toOpenAiUsage(aggregate.usage),
    });
  } finally {
    requestContext.cleanup();
  }
}

async function handleRawChat(req, res, body, config) {
  const model = resolveModel(body.model || config.defaultModel, config);
  const targetBody = body.messages ? toMacaronRequest(body, model, req, config) : body;
  const requestContext = createUpstreamContext(res, config);

  try {
    const upstream = await callMacaron(model, targetBody, req, config, requestContext.signal);

    if (!upstream.ok) {
      await sendUpstreamError(res, upstream, model);
      return;
    }

    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache",
      "x-macaron-upstream": upstream.url,
    });

    await pipeReadableStream(upstream.body, res);
  } finally {
    requestContext.cleanup();
  }
}

function validateChatCompletionRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "Request body must be a JSON object.");
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw httpError(400, "`messages` must be a non-empty array.");
  }

  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw httpError(400, "`stream` must be a boolean when provided.");
  }
}

function toMacaronRequest(body, model, req, config) {
  const { systemPrompt, messages } = normalizeMessages(body.messages || []);
  const reasoningEffort = normalizeReasoningEffort(model, body.reasoning_effort || body.reasoningEffort);

  return {
    messages,
    model,
    reasoningEffort,
    apiKey:
      body.apiKey ||
      body.upstream_api_key ||
      headerValue(req, "x-macaron-upstream-api-key") ||
      config.upstreamApiKey,
    baseURL:
      body.baseURL ||
      body.base_url ||
      body.upstream_base_url ||
      headerValue(req, "x-macaron-upstream-base-url") ||
      config.upstreamBaseUrl,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(body.previews ? { previews: body.previews } : {}),
    ...(body.editPreviewId ? { editPreviewId: body.editPreviewId } : {}),
  };
}

export function normalizeMessages(messages) {
  const system = [];
  const normalized = [];

  for (const message of messages) {
    const role = String(message.role || "user");
    const content = normalizeContent(message.content);

    if (role === "system" || role === "developer") {
      if (content) system.push(content);
      continue;
    }

    if (role === "assistant" || role === "user") {
      normalized.push({ role, content });
      continue;
    }

    if (role === "tool") {
      normalized.push({ role: "user", content: content ? `Tool result:\n${content}` : "Tool result." });
      continue;
    }

    normalized.push({ role: "user", content });
  }

  return {
    systemPrompt: system.join("\n\n"),
    messages: normalized.length ? normalized : [{ role: "user", content: "" }],
  };
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (!Array.isArray(content)) return String(content);

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (part.type === "text") return part.text || "";
      if (part.type === "input_text") return part.text || "";
      if (part.type === "image_url") return `[image: ${part.image_url?.url || ""}]`;
      if (part.type === "input_image") return `[image: ${part.image_url || part.file_id || ""}]`;
      return part.text || "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeReasoningEffort(model, requested) {
  const options = REASONING_OPTIONS[model] || [];
  if (requested && (!options.length || options.includes(requested))) return requested;
  if (MACARON_MODELS.has(model)) return "none";
  if (options.includes("high")) return "high";
  return options[0] || "high";
}

async function callMacaron(model, body, req, config, signal) {
  const endpoint = MACARON_MODELS.has(model) ? "/api/inline-chat" : "/api/plain-chat";
  const url = `${config.upstreamOrigin}${endpoint}`;

  try {
    const upstream = await config.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/x-ndjson, application/json, */*",
        "user-agent": req.headers["user-agent"] || "macaron-model2api/0.2",
      },
      body: JSON.stringify(body),
      signal,
    });

    Object.defineProperty(upstream, "url", { value: url });
    return upstream;
  } catch (error) {
    if (signal?.aborted) {
      const reason = signal.reason;
      throw httpError(reason?.status || 504, reason?.message || "Macaron upstream request aborted.");
    }
    throw error;
  }
}

async function streamOpenAiResponse(res, upstream, meta) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();

  writeSse(res, makeChunk(meta, { role: "assistant" }, null));

  let usage = null;
  let finishReason = "stop";

  try {
    for await (const event of parseNdjson(upstream.body)) {
      if (event.type === "text-delta" && event.text) {
        writeSse(res, makeChunk(meta, { content: event.text }, null));
      } else if (event.type === "reasoning-delta" && event.text) {
        writeSse(res, makeChunk(meta, { reasoning_content: event.text }, null));
      } else if (event.type === "step-finish") {
        usage = toOpenAiUsage(event.usage);
      } else if (event.type === "error") {
        finishReason = "error";
        writeSse(res, {
          id: meta.id,
          object: "chat.completion.chunk",
          created: meta.created,
          model: meta.model,
          choices: [{ index: 0, delta: {}, finish_reason: "error" }],
          error: {
            message: event.error || event.message || "Macaron upstream error.",
            type: "upstream_error",
          },
        });
        break;
      } else if (event.type === "done") {
        break;
      }
    }
  } catch (error) {
    finishReason = "error";
    writeSse(res, {
      id: meta.id,
      object: "chat.completion.chunk",
      created: meta.created,
      model: meta.model,
      choices: [{ index: 0, delta: {}, finish_reason: "error" }],
      error: {
        message: error instanceof Error ? error.message : String(error),
        type: "stream_error",
      },
    });
  }

  writeSse(res, {
    ...makeChunk(meta, {}, finishReason),
    ...(usage ? { usage } : {}),
  });

  if (!res.destroyed && !res.writableEnded) {
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

async function collectMacaronEvents(upstream) {
  let content = "";
  let reasoning = "";
  let usage = null;

  for await (const event of parseNdjson(upstream.body)) {
    if (event.type === "text-delta" && event.text) {
      content += event.text;
    } else if (event.type === "reasoning-delta" && event.text) {
      reasoning += event.text;
    } else if (event.type === "step-finish") {
      usage = event.usage || usage;
    } else if (event.type === "error") {
      throw httpError(502, event.error || event.message || "Macaron upstream error.");
    }
  }

  return { content, reasoning, usage };
}

export async function* parseNdjson(stream) {
  if (!stream) throw httpError(502, "Upstream response did not include a body.");

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });

    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield parseNdjsonLine(line);
      newline = buffer.indexOf("\n");
    }

    if (done) break;
  }

  const tail = buffer.trim();
  if (tail) yield parseNdjsonLine(tail);
}

function parseNdjsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    throw httpError(502, `Invalid NDJSON from upstream: ${line.slice(0, 160)}`);
  }
}

function makeChunk(meta, delta, finishReason) {
  return {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
}

function writeSse(res, payload) {
  if (res.destroyed || res.writableEnded) return false;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  return true;
}

async function sendUpstreamError(res, upstream, model) {
  const text = await upstream.text().catch(() => "");
  sendJson(res, upstream.status || 502, {
    error: {
      message: text || upstream.statusText || "Macaron upstream request failed.",
      type: "upstream_error",
      code: upstream.status,
      model,
    },
  });
}

export function toOpenAiUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const promptTokens = usage.prompt_tokens ?? usage.inputTokens ?? 0;
  const completionTokens = usage.completion_tokens ?? usage.outputTokens ?? 0;
  const totalTokens = usage.total_tokens ?? usage.totalTokens ?? promptTokens + completionTokens;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

async function pipeReadableStream(stream, res) {
  if (!stream) {
    res.end();
    return;
  }

  const reader = stream.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value && !(await writeResponseBuffer(res, Buffer.from(value)))) break;
  }

  if (!res.destroyed && !res.writableEnded) res.end();
}

async function writeResponseBuffer(res, buffer) {
  if (res.destroyed || res.writableEnded) return false;
  if (res.write(buffer)) return true;
  await Promise.race([once(res, "drain"), once(res, "close")]);
  return !res.destroyed && !res.writableEnded;
}

async function readJson(req, config) {
  const raw = await readText(req, config.maxBodyBytes);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "Invalid JSON request body.");
  }
}

function readText(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;

    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (!settled && body.length > maxBodyBytes) {
        settled = true;
        reject(httpError(413, `Request body is too large. Limit is ${maxBodyBytes} bytes.`));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!settled) resolve(body);
    });
    req.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

function createUpstreamContext(res, config) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort(httpError(504, `Macaron upstream timed out after ${config.requestTimeoutMs}ms.`));
  }, config.requestTimeoutMs);

  const onClose = () => {
    if (!res.writableEnded) {
      controller.abort(httpError(499, "Client connection closed before upstream finished."));
    }
  };

  res.on("close", onClose);

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      res.off("close", onClose);
    },
  };
}

function resolveModel(modelId, config) {
  const raw = String(modelId || config.defaultModel);
  const model = MODEL_ALIASES[raw] || raw;

  if (!config.allowUnknownModels && !MODEL_IDS.includes(model)) {
    throw httpError(404, `Unknown model: ${raw}`);
  }

  return model;
}

function modelObject(id) {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: MACARON_MODELS.has(id) ? "macaron" : "macaron-preview",
  };
}

function isAuthorized(req, config) {
  if (!config.localApiKey) return true;
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token === config.localApiKey || req.headers["x-api-key"] === config.localApiKey;
}

function sendUnauthorized(res) {
  sendJson(res, 401, {
    error: {
      message: "Unauthorized.",
      type: "authentication_error",
    },
  });
}

function sendMethodNotAllowed(res, methods) {
  res.setHeader("allow", methods.join(", "));
  sendJson(res, 405, {
    error: {
      message: `Method not allowed. Use ${methods.join(" or ")}.`,
      type: "invalid_request_error",
    },
  });
}

function sendThrownError(res, error) {
  if (res.headersSent || res.destroyed) {
    if (!res.writableEnded) res.end();
    return;
  }

  const status = normalizeHttpStatus(error?.status);
  sendJson(res, status, {
    error: {
      message: error instanceof Error ? error.message : String(error),
      type: status >= 500 ? "server_error" : "invalid_request_error",
    },
  });
}

function sendJson(res, status, payload) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function sendDocs(res, config) {
  sendJson(res, 200, {
    name: "macaron-model2api",
    upstream: config.upstreamOrigin,
    default_model: config.defaultModel,
    endpoints: [
      "GET /health",
      "GET /v1/models",
      "GET /v1/models/{model}",
      "POST /v1/chat/completions",
      "POST /api/chat",
    ],
  });
}

function setCorsHeaders(res, config) {
  res.setHeader("access-control-allow-origin", config.corsAllowOrigin);
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    "authorization,content-type,x-api-key,x-macaron-upstream-api-key,x-macaron-upstream-base-url",
  );
}

function normalizeConfig(configInput) {
  const defaults = loadConfig({});
  const config = {
    ...defaults,
    ...configInput,
  };

  config.upstreamOrigin = stripTrailingSlash(config.upstreamOrigin || DEFAULT_ORIGIN);
  config.defaultModel = MODEL_ALIASES[config.defaultModel] || config.defaultModel || DEFAULT_MODEL;
  config.requestTimeoutMs = parsePositiveInteger(config.requestTimeoutMs, defaults.requestTimeoutMs);
  config.maxBodyBytes = parsePositiveInteger(config.maxBodyBytes, defaults.maxBodyBytes);
  config.fetchImpl = config.fetchImpl || globalThis.fetch;

  if (!config.fetchImpl) {
    throw new Error("A fetch implementation is required.");
  }

  return config;
}

function getRequestId(req) {
  return headerValue(req, "x-request-id") || randomUUID();
}

function headerValue(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value || "";
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeHttpStatus(status) {
  const value = Number(status);
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : 500;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value) {
  if (value == null || value === "") return false;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}
