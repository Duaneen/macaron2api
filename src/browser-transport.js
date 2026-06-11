import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_BROWSER_STARTUP_TIMEOUT_MS = 30000;
const DEFAULT_BROWSER_FETCH_TIMEOUT_MS = 120000;
const DESKTOP_USER_AGENT =
  process.env.MACARON_BROWSER_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const DESKTOP_UA_METADATA = {
  brands: [
    { brand: "Chromium", version: "149" },
    { brand: "Google Chrome", version: "149" },
    { brand: "Not_A Brand", version: "99" },
  ],
  fullVersionList: [
    { brand: "Chromium", version: "149.0.0.0" },
    { brand: "Google Chrome", version: "149.0.0.0" },
    { brand: "Not_A Brand", version: "99.0.0.0" },
  ],
  platform: "Windows",
  platformVersion: "15.0.0",
  architecture: "x86",
  model: "",
  mobile: false,
  bitness: "64",
  wow64: false,
};
const STEALTH_SCRIPT = `
try {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  Object.defineProperty(navigator, "platform", { get: () => "Win32" });
  Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
  window.chrome = window.chrome || { runtime: {} };
} catch {}
`;
const transports = new Map();

export async function browserFetch(url, init = {}, config = {}) {
  const upstreamOrigin = config.upstreamOrigin || new URL(url).origin;
  const key = JSON.stringify({
    origin: upstreamOrigin,
    executablePath: config.browserExecutable || "",
    userDataDir: config.browserUserDataDir || "",
    headless: config.browserHeadless !== false,
  });

  let transport = transports.get(key);
  if (!transport) {
    transport = new BrowserTransport({
      origin: upstreamOrigin,
      executablePath: config.browserExecutable,
      userDataDir: config.browserUserDataDir,
      headless: config.browserHeadless !== false,
      startupTimeoutMs: config.browserStartupTimeoutMs || DEFAULT_BROWSER_STARTUP_TIMEOUT_MS,
    });
    transports.set(key, transport);
  }

  return transport.fetch(url, init);
}

export async function closeBrowserTransports() {
  const active = [...transports.values()];
  transports.clear();
  await Promise.all(active.map((transport) => transport.close()));
}

class BrowserTransport {
  constructor(options) {
    this.options = options;
    this.sessionPromise = null;
    this.session = null;
  }

  async fetch(url, init = {}) {
    const session = await this.ensureSession();
    const timeoutMs = init.timeoutMs || DEFAULT_BROWSER_FETCH_TIMEOUT_MS;
    const body = typeof init.body === "string" ? init.body : JSON.stringify(init.body ?? {});
    const expression = `(${browserFetchInPage})(${JSON.stringify(url)}, ${JSON.stringify(body)}, ${timeoutMs})`;
    const result = await session.cdp.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      timeoutMs + 5000,
    );

    if (result.exceptionDetails) {
      throw new Error(formatRuntimeException(result.exceptionDetails));
    }

    const value = result.result?.value;
    if (!value || typeof value !== "object") {
      throw new Error("Browser transport returned an empty response.");
    }

    return responseFromBrowser(value, url);
  }

  ensureSession() {
    if (!this.sessionPromise) {
      this.sessionPromise = this.startSession()
        .then((session) => {
          this.session = session;
          return session;
        })
        .catch((error) => {
          this.sessionPromise = null;
          throw error;
        });
    }
    return this.sessionPromise;
  }

  async close() {
    const session = this.session || (await this.sessionPromise?.catch(() => null));
    this.session = null;
    this.sessionPromise = null;
    session?.cdp?.close();
    if (session?.child && session.child.exitCode == null) {
      session.child.kill();
    }
  }

  async startSession() {
    const executable = this.options.executablePath || findChromeExecutable();
    if (!executable) {
      throw new Error(
        "Browser upstream transport requires Chrome or Edge. Set MACARON_BROWSER_EXECUTABLE to the browser executable path.",
      );
    }

    const userDataDir = this.options.userDataDir || (await mkdtemp(path.join(tmpdir(), "macaron-browser-")));
    await mkdir(userDataDir, { recursive: true });

    const args = [
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-background-networking",
      "--disable-component-extensions-with-background-pages",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--lang=en-US,en",
      `--user-agent=${DESKTOP_USER_AGENT}`,
      "--window-size=1280,900",
    ];

    if (this.options.headless !== false) args.push("--headless=new");
    args.push("about:blank");

    const child = spawn(executable, args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    const port = await waitForDevToolsPort(userDataDir, child, this.options.startupTimeoutMs, () => stderr);
    const target = await createPageTarget(port, "about:blank");
    const cdp = await CdpConnection.connect(target.webSocketDebuggerUrl, this.options.startupTimeoutMs);

    await preparePageForCheckpoint(cdp);
    await cdp.send("Runtime.enable", {}, 5000);
    await cdp.send("Page.enable", {}, 5000).catch(() => {});
    await cdp.send("Page.navigate", { url: this.options.origin }, 5000).catch(() => {});
    await waitForUsablePage(cdp, this.options.origin, this.options.startupTimeoutMs);

    return { cdp, child, userDataDir };
  }
}

async function preparePageForCheckpoint(cdp) {
  await cdp.send("Network.enable", {}, 5000).catch(() => {});
  await cdp
    .send(
      "Network.setUserAgentOverride",
      {
        userAgent: DESKTOP_USER_AGENT,
        acceptLanguage: "en-US,en;q=0.9",
        platform: "Windows",
        userAgentMetadata: DESKTOP_UA_METADATA,
      },
      5000,
    )
    .catch(() => {});
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: STEALTH_SCRIPT }, 5000).catch(() => {});
}

async function browserFetchInPage(url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body,
      signal: controller.signal,
    });
    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      status: response.status,
      statusText: response.statusText,
      headers,
      body: await response.text(),
      url: response.url,
    };
  } finally {
    clearTimeout(timer);
  }
}

function responseFromBrowser(value, fallbackUrl) {
  const response = new Response(value.body || "", {
    status: value.status || 502,
    statusText: value.statusText || "",
    headers: value.headers || {},
  });
  Object.defineProperty(response, "url", { value: value.url || fallbackUrl, configurable: true });
  return response;
}

async function waitForDevToolsPort(userDataDir, child, timeoutMs, getStderr) {
  const activePortFile = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`Browser exited before DevTools started. ${getStderr()}`.trim());
    }

    try {
      const text = await readFile(activePortFile, "utf8");
      const port = Number.parseInt(text.split(/\r?\n/)[0], 10);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // Chrome creates DevToolsActivePort after startup; keep polling.
    }

    await delay(100);
  }

  child.kill();
  throw new Error(`Timed out waiting for browser DevTools port. ${getStderr()}`.trim());
}

async function createPageTarget(port, origin) {
  const url = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(origin)}`;
  const response = await fetch(url, { method: "PUT" });
  if (!response.ok) {
    throw new Error(`Unable to create browser target: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function waitForUsablePage(cdp, origin, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await cdp
      .send(
        "Runtime.evaluate",
        {
          expression:
            "({ href: location.href, readyState: document.readyState, title: document.title, text: document.body?.innerText?.slice(0, 160) || '' })",
          returnByValue: true,
        },
        5000,
      )
      .catch(() => null);
    const value = result?.result?.value;

    if (
      value?.href?.startsWith(origin) &&
      value?.readyState === "complete" &&
      !isCheckpointText(`${value.title}\n${value.text}`)
    ) {
      return;
    }

    await delay(500);
  }
}

function isCheckpointText(text) {
  return /Vercel Security Checkpoint|verifying your browser/i.test(text || "");
}

function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_BIN,
    process.env.MACARON_BROWSER_EXECUTABLE,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
      : "",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe")
      : "",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || "";
}

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;

    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (error) => this.rejectAll(error));
    socket.on("close", () => this.rejectAll(new Error("CDP websocket closed.")));
  }

  static async connect(wsUrl, timeoutMs) {
    const target = new URL(wsUrl);
    const socket = net.createConnection({
      host: target.hostname,
      port: Number(target.port || 80),
    });

    await Promise.race([
      once(socket, "connect"),
      once(socket, "error").then(([error]) => {
        throw error;
      }),
      delay(timeoutMs).then(() => {
        throw new Error("Timed out connecting to browser DevTools websocket.");
      }),
    ]);

    const key = randomBytes(16).toString("base64");
    const requestPath = `${target.pathname}${target.search}`;
    socket.write(
      [
        `GET ${requestPath} HTTP/1.1`,
        `Host: ${target.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );

    const remainder = await readHandshake(socket, key, timeoutMs);
    const connection = new CdpConnection(socket);
    if (remainder.length) connection.onData(remainder);
    return connection;
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.write(encodeClientFrame(payload));
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2) {
      const frame = decodeFrame(this.buffer);
      if (!frame) return;
      this.buffer = this.buffer.slice(frame.nextOffset);

      if (frame.opcode === 1) this.onMessage(frame.payload.toString("utf8"));
      if (frame.opcode === 8) this.socket.end();
      if (frame.opcode === 9) this.socket.write(encodeClientFrame(frame.payload, 10));
    }
  }

  onMessage(text) {
    const message = JSON.parse(text);
    if (!message.id) return;

    const pending = this.pending.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(`${pending.method} failed: ${message.error.message}`));
      return;
    }

    pending.resolve(message.result || {});
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.socket.end();
  }
}

async function readHandshake(socket, key, timeoutMs) {
  const expectedAccept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  let buffer = Buffer.alloc(0);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for DevTools websocket handshake."));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;

      const head = buffer.slice(0, headerEnd).toString("latin1");
      if (!/^HTTP\/1\.[01] 101\b/.test(head) || !head.includes(expectedAccept)) {
        cleanup();
        reject(new Error(`DevTools websocket handshake failed: ${head.split("\r\n")[0]}`));
        return;
      }

      cleanup();
      resolve(buffer.slice(headerEnd + 4));
    };

    socket.on("data", onData);
    socket.on("error", onError);
  });
}

function encodeClientFrame(data, opcode = 1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x80 | opcode;
  const mask = randomBytes(4);
  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }

  return Buffer.concat([header, mask, masked]);
}

function decodeFrame(buffer) {
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }

  let mask;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.slice(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) return null;

  const payload = Buffer.from(buffer.slice(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }

  return {
    opcode,
    payload,
    nextOffset: offset + length,
  };
}

function formatRuntimeException(exceptionDetails) {
  return (
    exceptionDetails.exception?.description ||
    exceptionDetails.text ||
    "Browser transport fetch failed inside the page context."
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
