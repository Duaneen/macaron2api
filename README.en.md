# OpenAI-Compatible API Gateway

> [中文](README.md) | English

A self-hosted, OpenAI-compatible API proxy. It wraps an upstream model service behind the standard OpenAI Chat Completions interface, and also keeps a pass-through endpoint that streams the upstream's raw events for debugging.

## Endpoints

- `GET /health`
- `GET /v1/models`
- `GET /v1/models/{model}`
- `POST /v1/chat/completions`
- `POST /api/chat` — pass-through of the upstream raw NDJSON event stream, useful for debugging

Different models are routed to their corresponding upstream endpoints internally.

## Run

```powershell
npm start
```

Default address:

```text
http://localhost:8787
```

See `.env.example` for optional local configuration; it also runs without an `.env`.

## Docker

Create a local env file and set `API_KEY` as needed:

```powershell
Copy-Item .env.example .env
```

### Docker Compose

Recommended:

```powershell
docker compose up -d --build
```

The host port `8787` is mapped to the container by default. Change `HOST_PORT` in `.env` to use a different host port:

```text
HOST_PORT=18787
```

On first start a `browser-profile/` directory is created in the project root to persist the browser context (already ignored in `.gitignore`).

Status and logs:

```powershell
docker compose ps
docker compose logs -f
```

Rebuild and restart:

```powershell
docker compose up -d --build
```

Stop:

```powershell
docker compose down
```

### Docker CLI

```powershell
docker build -t app .
docker run -d --name app --restart unless-stopped `
  -p 8787:8787 `
  --env-file .env `
  app
```

Health check:

```powershell
Invoke-RestMethod http://localhost:8787/health
```

## Configuration

Key environment variables (see `.env.example` for the full list):

| Variable | Description |
| --- | --- |
| `PORT` | Listen port, defaults to `8787` |
| `API_KEY` | Client access key; auth is skipped when empty |
| `MACARON_ORIGIN` | Upstream service origin (defaults to the official upstream) |
| `MACARON_DEFAULT_MODEL` | Default model |
| `MACARON_UPSTREAM_TRANSPORT` | Upstream transport: `auto` / `browser` / `direct` |
| `MACARON_TIMEOUT_MS` | Upstream request timeout (ms) |
| `MACARON_BROWSER_EXECUTABLE` | Path to the browser executable |
| `MACARON_BROWSER_USER_AGENT` | User-Agent for the browser context (optional) |
| `CORS_ALLOW_ORIGIN` | Allowed CORS origin, defaults to `*` |

When `API_KEY` is set, requests must carry one of:

```text
Authorization: Bearer <your-key>
```

or:

```text
x-api-key: <your-key>
```

Some upstream models accept a per-request upstream key and base URL:

```json
{
  "upstream_api_key": "...",
  "upstream_base_url": "..."
}
```

The headers `x-macaron-upstream-api-key` and `x-macaron-upstream-base-url` work too.

## Upstream Transport & Browser Context

Some upstreams return rate-limit or security challenges to plain server-to-server requests, while requests originating from a real browser succeed. `MACARON_UPSTREAM_TRANSPORT` controls this:

- `auto` — try a direct server-side request first, and fall back to a real browser context only when the upstream returns a challenge.
- `browser` — always send upstream requests from a browser context.
- `direct` — server-side requests only; surfaces the challenge as an error.

The browser context issues requests with a realistic desktop-browser environment — a consistent User-Agent, Client Hints, and baseline environment traits — to improve success under strict protection. Override the UA via `MACARON_BROWSER_USER_AGENT`; the browser profile is persisted in `browser-profile/` and reused across restarts.

If a browser cannot be found locally, install Chrome or Edge, or set it explicitly:

```powershell
$env:MACARON_BROWSER_EXECUTABLE = "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

The Docker image bundles Chromium and defaults to `MACARON_BROWSER_EXECUTABLE=/usr/bin/chromium-browser`.

## Parameter Pass-Through

These OpenAI sampling parameters are forwarded as-is (whether they take effect depends on the upstream; unknown fields are expected to be ignored):

`temperature`, `top_p`, `max_tokens`, `stop`, `frequency_penalty`, `presence_penalty`, `seed`

`tools` and `tool_choice` are forwarded too, but end-to-end tool calling depends on upstream support; the proxy only forwards on the request side and does not yet parse upstream tool-call output.

## OpenAI-Compatible Usage

Set the client `base_url` to:

```text
http://localhost:8787/v1
```

Non-streaming example:

```powershell
Invoke-RestMethod http://localhost:8787/v1/chat/completions `
  -Method Post `
  -ContentType "application/json" `
  -Body '{
    "model": "<model-id>",
    "messages": [
      { "role": "user", "content": "Say hi in one short sentence." }
    ]
  }'
```

Streaming example:

```powershell
Invoke-WebRequest http://localhost:8787/v1/chat/completions `
  -Method Post `
  -ContentType "application/json" `
  -Body '{
    "model": "<model-id>",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Say hi." }
    ]
  }' | Select-Object -ExpandProperty Content
```

## Models

Use `GET /v1/models` to list the currently available models; the default model is set by `MACARON_DEFAULT_MODEL`, with a few aliases resolving to it.

## Development

```powershell
npm run check
npm test
```

The test suite uses a local mock upstream and never hits the real upstream service.

## Notes

This service depends on the current shape of the upstream interface. If the upstream changes its endpoints or event format, the proxy must be updated accordingly.

It implements an OpenAI Chat Completions compatibility layer, not the full Responses API. On upstream errors, streaming responses include an `error` field in the chunk and end with a valid `finish_reason` (`stop`) for strict OpenAI clients.
