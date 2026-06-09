import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { formatListenError, isPortConfigured, listenWithPortFallback } from "../src/startup.js";

test("falls back to another port when the default port is in use", async () => {
  const occupied = http.createServer();
  const server = http.createServer((req, res) => res.end("ok"));
  const warnings = [];

  await listen(occupied, 0);
  const occupiedPort = occupied.address().port;

  try {
    const port = await listenWithPortFallback(server, occupiedPort, {
      explicitPort: false,
      logger: { warn: (message) => warnings.push(message) },
      nextPort: () => 0,
    });

    assert.notEqual(port, occupiedPort);
    assert.ok(port > 0);
    assert.match(warnings[0], new RegExp(`Port ${occupiedPort} is in use`));
  } finally {
    await closeIfListening(server);
    await closeIfListening(occupied);
  }
});

test("does not fall back when PORT was configured explicitly", async () => {
  const occupied = http.createServer();
  const server = http.createServer();

  await listen(occupied, 0);
  const occupiedPort = occupied.address().port;

  try {
    await assert.rejects(
      () =>
        listenWithPortFallback(server, occupiedPort, {
          explicitPort: true,
          logger: { warn: () => {} },
        }),
      { code: "EADDRINUSE" },
    );
  } finally {
    await closeIfListening(server);
    await closeIfListening(occupied);
  }
});

test("detects whether PORT was configured", () => {
  assert.equal(isPortConfigured({}), false);
  assert.equal(isPortConfigured({ PORT: "" }), false);
  assert.equal(isPortConfigured({ PORT: "8787" }), true);
});

test("formats address-in-use errors with the attempted port", () => {
  const error = new Error("listen EADDRINUSE");
  error.code = "EADDRINUSE";
  error.attemptedPort = 8787;

  assert.equal(
    formatListenError(error, 8787, true),
    "Port 8787 is already in use. Set PORT to another value or stop the process using port 8787.",
  );
});

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, resolve);
  });
}

function closeIfListening(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
