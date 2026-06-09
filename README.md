# Macaron Model2API

这是一个面向 `https://macaron-model-previews.macaron.im/` 的 OpenAI 兼容 API 代理。

它会把 Macaron 预览站点里的聊天后端封装成本地 OpenAI 风格接口，同时保留一个原始 Macaron NDJSON 代理接口，方便调试上游事件流。

## 功能

- `GET /health`
- `GET /v1/models`
- `GET /v1/models/{model}`
- `POST /v1/chat/completions`
- `POST /api/chat` 原始 Macaron NDJSON 代理

Macaron 预览模型会路由到上游 `/api/inline-chat`。其它从预览站点提取出来的模型会路由到上游 `/api/plain-chat`。

## 启动

```powershell
npm start
```

默认服务地址：

```text
http://localhost:8787
```

如果需要固定本地配置，可以参考 `.env.example`。不配置 `.env` 也可以直接运行。

## 配置

```powershell
$env:PORT = "8787"
$env:API_KEY = "local-secret"
$env:MACARON_ORIGIN = "https://macaron-model-previews.macaron.im"
$env:MACARON_DEFAULT_MODEL = "macaron-v1-preview-b200"
$env:MACARON_TIMEOUT_MS = "120000"
$env:MACARON_ALLOW_UNKNOWN_MODELS = "0"
$env:CORS_ALLOW_ORIGIN = "*"
npm start
```

如果设置了 `API_KEY`，客户端请求必须携带以下任意一种认证方式：

```text
Authorization: Bearer local-secret
```

或：

```text
x-api-key: local-secret
```

对于上游普通模型，可以通过环境变量或每次请求传入上游密钥和上游 base URL：

```json
{
  "upstream_api_key": "...",
  "upstream_base_url": "..."
}
```

也可以使用请求头：

```text
x-macaron-upstream-api-key
x-macaron-upstream-base-url
```

## OpenAI 兼容用法

客户端的 `base_url` 配置为：

```text
http://localhost:8787/v1
```

非流式请求示例：

```powershell
Invoke-RestMethod http://localhost:8787/v1/chat/completions `
  -Method Post `
  -ContentType "application/json" `
  -Body '{
    "model": "macaron-v1-preview-b200",
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
    "model": "macaron-v1-preview-b200",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Say hi." }
    ]
  }' | Select-Object -ExpandProperty Content
```

原始上游 NDJSON 代理示例：

```powershell
Invoke-WebRequest http://localhost:8787/api/chat `
  -Method Post `
  -ContentType "application/json" `
  -Body '{
    "model": "macaron-v1-preview-b200",
    "messages": [
      { "role": "user", "content": "Say hi." }
    ]
  }' | Select-Object -ExpandProperty Content
```

## 模型列表

已提取的模型 ID：

- `macaron-v1-preview-sglang`
- `macaron-v1-preview-baseline`
- `macaron-v1-preview-b200`
- `macaron-v1-preview-tilert`
- `pa/gemini-3.5-flash`
- `pa/gemini-3.1-pro-preview`
- `pa/gpt-5.4`
- `pa/claude-sonnet-4-6`
- `zai-org/glm-5.1`
- `xiaomimimo/mimo-v2.5-pro`
- `qwen/qwen3.7-max`
- `minimax/minimax-m2.7`
- `deepseek/deepseek-v4-pro`
- `kimi-k2-thinking`
- `doubao-seed-2-0-pro-260215`
- `zai-glm-4.7`
- `gpt-oss-120b`
- `gpt-5.5`
- `gpt-5.4-mini`
- `gpt-5.3-codex-spark`

支持的模型别名：

- `macaron`
- `macaron-v1-preview`
- `macaron-v1-preview-latest`

这些别名都会解析为 `macaron-v1-preview-b200`。

## 开发

```powershell
npm run check
npm test
```

测试套件使用本地 mock 上游，不会请求真实的 Macaron 预览服务。

## 注意事项

目标站点的接口属于页面内部接口。如果 Macaron 预览站未来调整 bundle、端点或事件格式，这个代理也需要同步更新。

当前项目实现的是 OpenAI Chat Completions 兼容层，不是完整的 Responses API。
