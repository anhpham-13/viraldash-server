import { resolve } from "node:path";
import { promises as fs } from "node:fs";
import { appendJsonLine } from "./jsonl.js";
import type { IWorkerRunSummary, IYouTubeVideoRaw, IVideoRecordCandidate } from "./types.js";

export interface BaseWorkerOptions {
  workerId: string;
  workerName: string;
  maxVideoAgeDays: number;
  rawOutputDir?: string;
}

export abstract class BaseWorker {
  protected readonly outputFile: string;

  protected constructor(protected readonly options: BaseWorkerOptions) {
    const rawOutputDir = options.rawOutputDir ?? resolve(process.cwd(), "data", "raw");
    this.outputFile = resolve(rawOutputDir, `${options.workerName}-${options.workerId}.jsonl`);
  }

  protected abstract collect(): AsyncIterable<IVideoRecordCandidate> | Iterable<IVideoRecordCandidate> | Promise<AsyncIterable<IVideoRecordCandidate> | Iterable<IVideoRecordCandidate>>;

  protected toSafeRecord(candidate: IVideoRecordCandidate): IYouTubeVideoRaw | null {
    const id     = String(candidate.id ?? candidate.video_id ?? "").trim();
    const author = String(candidate.author ?? candidate.username ?? "").trim();
    const url    = String(candidate.url ?? "").trim();

    // Bug fix: `sound` is optional — TikTok/IG videos may have no background audio.
    // Bug fix: require an explicit URL; never fabricate a platform-specific fallback URL.
    if (!id || !author || !url) {
      return null;
    }

    if (this.isOlderThanLimit(
      this.toIsoString(candidate.postDate ?? candidate.publishedAt ?? candidate.createdAt),
      this.toIsoString(candidate.fetchedAt),
    )) {
      return null;
    }

    const likes           = this.toNumber(candidate.likes);
    const views           = this.toNumber(candidate.views);
    const comments        = this.toNumber(candidate.comments);
    const shares          = this.toNumber(candidate.shares ?? candidate.total_view_growth);
    const saves           = this.toNumber(candidate.saves ?? 0);
    const totalViewGrowth = this.toNumber(candidate.total_view_growth);
    const hashtags        = this.toHashtags(candidate.hashtags);
    const sound           = String(candidate.sound ?? candidate.music ?? "").trim();
    const fetchedAt       = this.toIsoString(candidate.fetchedAt);
    const postDate        = this.toIsoString(candidate.postDate ?? candidate.publishedAt ?? candidate.createdAt ?? fetchedAt);

    return {
      id,
      author,
      url,
      postDate,
      likes,
      views,
      comments,
      shares,
      saves,
      total_view_growth: totalViewGrowth,
      hashtags,
      sound,
      fetchedAt,
    };
  }

  public async run(): Promise<IWorkerRunSummary> {
    let acceptedCount = 0;
    let skippedCount  = 0;

    for await (const candidate of this.toAsyncIterable(await this.collect())) {
      const record = this.toSafeRecord(candidate);

      if (!record) {
        skippedCount += 1;
        continue;
      }

      await appendJsonLine(this.outputFile, record);
      acceptedCount += 1;
    }

    return {
      workerName:    this.options.workerName,
      workerId:      this.options.workerId,
      outputFile:    this.outputFile,
      acceptedCount,
      skippedCount,
    };
  }

  private async *toAsyncIterable(value: AsyncIterable<IVideoRecordCandidate> | Iterable<IVideoRecordCandidate>): AsyncIterable<IVideoRecordCandidate> {
    if (Symbol.asyncIterator in value) {
      for await (const item of value as AsyncIterable<IVideoRecordCandidate>) {
        yield item;
      }
      return;
    }

    for (const item of value as Iterable<IVideoRecordCandidate>) {
      yield item;
    }
  }

  private toNumber(value: number | string | undefined): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  private toHashtags(value: string[] | string | undefined): string[] {
    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }
    if (typeof value === "string") {
      return value.split(",").map((item) => item.trim()).filter(Boolean);
    }
    return [];
  }

  private toIsoString(value: string | undefined): string {
    if (!value) return new Date().toISOString();
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }

  private isOlderThanLimit(postDate: string, fetchedAt: string): boolean {
    const postTime  = new Date(postDate).getTime();
    const fetchTime = new Date(fetchedAt).getTime();
    if (!Number.isFinite(postTime) || !Number.isFinite(fetchTime)) return false;
    const ageHours = (fetchTime - postTime) / 3_600_000;
    return ageHours > this.options.maxVideoAgeDays * 24;
  }
}
