import { createApp, loadConfig } from "./app.js";

const config = loadConfig(process.env);
const server = createApp(config);

server.listen(config.port, () => {
  console.log(`Macaron model2api listening on http://localhost:${config.port}`);
  console.log(`Upstream: ${config.upstreamOrigin}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
