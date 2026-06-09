const DEFAULT_URL = "https://macaron-model-previews.macaron.im/";

const appUrl = process.argv[2] || DEFAULT_URL;

const html = await fetchText(appUrl);
const bundleUrl = findVersusBundleUrl(html, appUrl);
const bundle = await fetchText(bundleUrl);

const result = {
  appUrl,
  bundleUrl,
  bundleBytes: Buffer.byteLength(bundle, "utf8"),
  endpoints: uniqueMatches(bundle, /[`'"]((?:\/api\/)[A-Za-z0-9_./-]+)[`'"]/g),
  eventTypes: uniqueMatches(bundle, /\?\.type===`([^`]+)`/g).filter(isChatEventType),
  modelIds: extractModelIds(bundle),
};

console.log(JSON.stringify(result, null, 2));

async function fetchText(url) {
  const response = await fetch(url, { headers: { accept: "text/html,application/javascript,*/*" } });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function findVersusBundleUrl(html, baseUrl) {
  const match = html.match(/component-url="([^"]*VersusApp[^"]*\.js[^"]*)"/);
  if (!match) throw new Error("Unable to find VersusApp bundle URL in upstream HTML.");
  return new URL(match[1].replaceAll("&amp;", "&"), baseUrl).href;
}

function uniqueMatches(text, regex) {
  return [...new Set([...text.matchAll(regex)].map((match) => match[1]))].sort();
}

function isChatEventType(type) {
  return type === "done" || type === "error" || type.includes("-");
}

function extractModelIds(bundle) {
  const patterns = [
    /macaron-v1-preview-[a-z0-9-]+/g,
    /pa\/[a-z0-9._-]+/g,
    /zai-org\/[a-z0-9._-]+/g,
    /xiaomimimo\/[a-z0-9._-]+/g,
    /qwen\/[a-z0-9._-]*[0-9][a-z0-9._-]*/g,
    /minimax\/[a-z0-9._-]*[0-9][a-z0-9._-]*/g,
    /deepseek\/[a-z0-9._-]*[0-9][a-z0-9._-]*/g,
    /kimi-[a-z0-9._-]+/g,
    /doubao-[a-z0-9._-]+/g,
    /zai-glm-[a-z0-9._-]+/g,
    /gpt-(?:oss-[a-z0-9._-]+|[0-9][a-z0-9._-]*)/g,
  ];

  return [...new Set(patterns.flatMap((pattern) => [...bundle.matchAll(pattern)].map((match) => match[0])))]
    .filter((model) => !model.endsWith(".js"))
    .sort();
}
