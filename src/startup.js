export const DEFAULT_PORT_ATTEMPTS = 10;

export async function listenWithPortFallback(server, initialPort, options = {}) {
  const explicitPort = options.explicitPort ?? false;
  const logger = options.logger ?? console;
  const maxPortAttempts = options.maxPortAttempts ?? DEFAULT_PORT_ATTEMPTS;
  const nextPort = options.nextPort ?? ((port) => port + 1);
  let port = initialPort;

  for (let attempt = 0; attempt < maxPortAttempts; attempt += 1) {
    try {
      await listenOnce(server, port);
      return getListeningPort(server, port);
    } catch (error) {
      error.attemptedPort = port;

      if (error?.code !== "EADDRINUSE" || explicitPort || attempt + 1 >= maxPortAttempts) {
        throw error;
      }

      const candidate = nextPort(port, attempt + 1);
      logger.warn(`Port ${port} is in use; trying ${candidate}.`);
      port = candidate;
    }
  }

  throw new Error(`Unable to listen on port ${initialPort}.`);
}

export function isPortConfigured(env = process.env) {
  return env.PORT != null && env.PORT !== "";
}

export function formatListenError(error, configuredPort, explicitPort = false) {
  if (error?.code === "EADDRINUSE") {
    const attemptedPort = error.attemptedPort ?? configuredPort;
    const hint = explicitPort
      ? `Set PORT to another value or stop the process using port ${attemptedPort}.`
      : `Set PORT to an available port, or stop the process using port ${attemptedPort}.`;
    return `Port ${attemptedPort} is already in use. ${hint}`;
  }

  return error instanceof Error ? error.stack || error.message : String(error);
}

function listenOnce(server, port) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port);
  });
}

function getListeningPort(server, fallbackPort) {
  const address = server.address();
  return typeof address === "object" && address ? address.port : fallbackPort;
}
