import "./polyfills.js";
import { pathToFileURL } from "node:url";
import { env } from "../src/config/env.js";
import { GoogleWorker } from "./google-worker.js";
import { syncHashtagsFromVideos } from "../../shared/db/index.js";

async function main(): Promise<void> {
  if (!env.youtubeDataApiKey) {
    console.log("YouTube Shorts crawler is ready.");
    console.log("Set YOUTUBE_DATA_API_KEY or YT_DATA_API_KEY to enable enrichment.");
    return;
  }

  if (process.env.RUN_PIPELINE !== "true") {
    console.log("YouTube Shorts crawler is ready.");
    console.log(`Max video age (days): ${env.maxVideoAgeDays}`);
    console.log(`Viral threshold: ${env.viralScoreThreshold}`);
    console.log("Set RUN_PIPELINE=true to execute the crawl.");
    console.log("Google worker configured: true");
    return;
  }

  const worker = new GoogleWorker({
    workerId: "1",
    workerName: "youtube-shorts-google",
    maxVideoAgeDays: env.maxVideoAgeDays,
  });

  const result = await worker.run();
  console.log(JSON.stringify(result, null, 2));

  await syncHashtagsFromVideos("YouTube_Shorts");
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;

if (entryPoint && import.meta.url === entryPoint) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
