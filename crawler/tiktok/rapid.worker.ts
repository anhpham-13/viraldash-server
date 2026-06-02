import "dotenv/config";
import fs from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { env } from "./config/env.js";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const OUTPUT_FILE = resolve(process.cwd(), "output_json", "tiktok_rapid_raw.jsonl");

function buildRapidEndpointCandidates(region: string, host?: string): Array<{ path: string; params: Record<string, string> }> {
  if (host?.includes("scraper7")) {
    return [
      { path: "/feed/search", params: { keywords: "fyp", region: region.toLowerCase(), count: "10", cursor: "0", publish_time: "1", sort_type: "1" } },
      { path: "/feed/search", params: { keywords: "trending", region: region.toLowerCase(), count: "10", cursor: "0", publish_time: "1", sort_type: "1" } },
      { path: "/feed", params: { keywords: "fyp", region: region.toLowerCase(), count: "10" } },
      { path: "/trending", params: { region: region.toLowerCase(), count: "10" } },
    ];
  }

  return [
    { path: `/trending/${encodeURIComponent(region)}`, params: {} },
    { path: "/trending", params: { region } },
    { path: "/trending", params: { country: region } },
    { path: "/feed/trending", params: { region } },
    { path: "/feed", params: { region } },
    { path: "/videos/trending", params: { region } },
    { path: "/search", params: { keyword: "trending", region } },
    { path: "/search", params: { q: "trending", region } },
  ];
}

async function tryRapidEndpoint(host: string, apiKey: string, path: string, params: Record<string, string>): Promise<unknown | null> {
  try {
    const url = new URL(`https://${host}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url, {
      headers: {
        "X-RapidAPI-Key": apiKey,
        "X-RapidAPI-Host": host,
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
    });

    if (!response.ok) {
      console.warn(`[rapid] API call failed: ${response.status} ${response.statusText} for ${path}`);
      return null;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return response.json();
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch (error) {
    console.error(`[rapid] Network error for path ${path}:`, error);
    return null;
  }
}

export async function runRapidWorker() {
  const fetchedAt = new Date().toISOString();
  
  // Ensure output directory exists
  fs.mkdirSync(resolve(process.cwd(), "output_json"), { recursive: true });

  const stream = fs.createWriteStream(OUTPUT_FILE, { flags: "w" }); // Overwrite or append? I'll overwrite per stage run
  
  const maxRequests = Number(process.env.RAPID_MAX_REQUESTS) || 150;
  const delayMs = Number(process.env.RAPID_DELAY_MS) || 1500;
  let requestCount = 0;

  for (const config of env.rapidApiConfigs) {
    let shouldAbortWorker = false;
    console.log(`[rapid] start ${config.host} regions=${env.crawlRegions.join(",") || "US"} maxRequests=${maxRequests}`);
    const regions = env.crawlRegions.length > 0 ? env.crawlRegions : ["US"];

    for (const region of regions) {
      if (requestCount >= maxRequests || shouldAbortWorker) break;

      for (const endpoint of buildRapidEndpointCandidates(region, config.host)) {
        if (requestCount >= maxRequests) break;

        if (requestCount > 0 && delayMs > 0) {
          await delay(delayMs);
        }

        requestCount++;
        console.log(`[rapid] [req #${requestCount}/${maxRequests}] Fetching ${region} (${endpoint.path})`);
        
        let payload = await tryRapidEndpoint(config.host, config.apiKey, endpoint.path, endpoint.params);
        if (!payload) {
          console.warn(`[rapid] Retrying 1 time...`);
          await delay(1000);
          payload = await tryRapidEndpoint(config.host, config.apiKey, endpoint.path, endpoint.params);
          if (!payload) {
            console.error(`[rapid] Retry failed. Aborting worker ${config.host}!`);
            shouldAbortWorker = true;
            break;
          }
        }

        const outputRecord = {
          host: config.host,
          region,
          endpoint: endpoint.path,
          fetchedAt,
          payload
        };

        stream.write(JSON.stringify(outputRecord) + "\n");
        console.log(`[rapid] [req #${requestCount}/${maxRequests}] Saved raw payload.`);
        
        // Stop after we get one successful payload per region to avoid too many requests?
        // Original logic: "if (records.length > 0) { break; }"
        break; 
      }
    }
  }

  stream.end();
  console.log(`[rapid] Done. Raw results saved to ${OUTPUT_FILE}`);
}

// Allow running standalone
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("rapid.worker.ts")) {
  runRapidWorker().catch(console.error);
}
