import { createApp, loadConfig } from "./app.js";
import { formatListenError, isPortConfigured, listenWithPortFallback } from "./startup.js";

const config = loadConfig(process.env);
const server = createApp(config);
const explicitPort = isPortConfigured(process.env);

try {
  const port = await listenWithPortFallback(server, config.port, { explicitPort });
  console.log(`Macaron model2api listening on http://localhost:${port}`);
  console.log(`Upstream: ${config.upstreamOrigin}`);
} catch (error) {
  console.error(formatListenError(error, config.port, explicitPort));
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
