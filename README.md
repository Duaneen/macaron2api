# OpenAI 兼容 API 网关

> 中文 | [English](README.en.md)

一个自托管的、OpenAI 兼容的 API 代理服务。它把上游模型服务封装为标准的 OpenAI Chat Completions 接口，并额外保留一个透传上游原始事件流的调试接口。

## 功能

- `GET /health`
- `GET /v1/models`
- `GET /v1/models/{model}`
- `POST /v1/chat/completions`
- `POST /api/chat`：透传上游原始 NDJSON 事件流，便于调试

不同模型会按内部规则路由到对应的上游接口。

## 启动

```powershell
npm start
```

默认服务地址：

```text
http://localhost:8787
```

如需固定本地配置，可参考 `.env.example`；不配置 `.env` 也能直接运行。

## Docker 部署

先生成本地环境配置，并按需修改 `API_KEY`：

```powershell
Copy-Item .env.example .env
```

### Docker Compose

推荐使用 Compose 部署：

```powershell
docker compose up -d --build
```

默认会把宿主机 `8787` 端口映射到容器内服务。需要改宿主机端口时，修改 `.env` 中的 `HOST_PORT`：

```text
HOST_PORT=18787
```

首次启动会在项目目录下创建 `browser-profile/`，用于持久化浏览器上下文（已在 `.gitignore` 中忽略）。

查看运行状态与日志：

```powershell
docker compose ps
docker compose logs -f
```

更新并重启：

```powershell
docker compose up -d --build
```

停止服务：

```powershell
docker compose down
```

### Docker CLI

也可以直接构建并运行镜像：

```powershell
docker build -t app .
docker run -d --name app --restart unless-stopped `
  -p 8787:8787 `
  --env-file .env `
  app
```

健康检查：

```powershell
Invoke-RestMethod http://localhost:8787/health
```

## 配置

主要环境变量（完整项见 `.env.example`）：

| 变量 | 说明 |
| --- | --- |
| `PORT` | 服务监听端口，默认 `8787` |
| `API_KEY` | 客户端访问密钥，留空则不校验 |
| `MACARON_ORIGIN` | 上游服务 Origin（默认指向官方上游） |
| `MACARON_DEFAULT_MODEL` | 默认模型 |
| `MACARON_UPSTREAM_TRANSPORT` | 上游传输方式：`auto` / `browser` / `direct` |
| `MACARON_TIMEOUT_MS` | 上游请求超时（毫秒） |
| `MACARON_BROWSER_EXECUTABLE` | 浏览器可执行文件路径 |
| `MACARON_BROWSER_USER_AGENT` | 浏览器上下文使用的 User-Agent（可选） |
| `CORS_ALLOW_ORIGIN` | CORS 允许来源，默认 `*` |

如果设置了 `API_KEY`，客户端请求需携带任意一种认证：

```text
Authorization: Bearer <your-key>
```

或：

```text
x-api-key: <your-key>
```

部分上游模型支持按请求传入独立的上游密钥与 base URL：

```json
{
  "upstream_api_key": "...",
  "upstream_base_url": "..."
}
```

也可使用请求头 `x-macaron-upstream-api-key` 与 `x-macaron-upstream-base-url`。

## 上游传输与浏览器上下文

部分上游对纯服务端发起的请求会返回限流或安全质询，而来自真实浏览器的请求可以正常完成。`MACARON_UPSTREAM_TRANSPORT` 用于控制这一行为：

- `auto`：先尝试直接的服务端请求，仅当上游返回质询时，自动回退到真实浏览器上下文。
- `browser`：始终通过浏览器上下文发送上游请求。
- `direct`：只用服务端请求，遇到质询会直接以错误返回。

浏览器上下文会以接近真实桌面浏览器的环境发起请求——统一的 User-Agent、客户端提示（Client Hints）与基础环境特征——以提升在严格风控下的成功率。可通过 `MACARON_BROWSER_USER_AGENT` 覆盖默认 UA；浏览器配置持久化在 `browser-profile/`，可跨重启复用。

本地运行若提示找不到浏览器，请安装 Chrome 或 Edge，或显式指定：

```powershell
$env:MACARON_BROWSER_EXECUTABLE = "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

Docker 镜像内置 Chromium，默认 `MACARON_BROWSER_EXECUTABLE=/usr/bin/chromium-browser`。

## 参数透传

以下 OpenAI 采样参数会原样转发给上游（是否生效取决于上游，未知字段预期会被忽略）：

`temperature`、`top_p`、`max_tokens`、`stop`、`frequency_penalty`、`presence_penalty`、`seed`

`tools` 与 `tool_choice` 也会一并转发，但工具调用能否端到端工作取决于上游是否支持；当前代理只做请求侧透传，尚未解析上游的工具调用返回。

## OpenAI 兼容用法

客户端 `base_url` 配置为：

```text
http://localhost:8787/v1
```

非流式请求示例：

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

流式请求示例：

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

## 模型

通过 `GET /v1/models` 获取当前可用模型列表；默认模型由 `MACARON_DEFAULT_MODEL` 指定，并提供若干别名解析到默认模型。

## 开发

```powershell
npm run check
npm test
```

测试套件使用本地 mock 上游，不会请求真实的上游服务。

## 注意事项

本服务依赖上游接口的当前形态。若上游调整接口或事件格式，本代理需同步更新。

当前实现的是 OpenAI Chat Completions 兼容层，而非完整的 Responses API。流式响应在上游报错时会在 chunk 中附带 `error` 字段，并以合法的 `finish_reason`（`stop`）结束，以兼容严格校验的客户端。
