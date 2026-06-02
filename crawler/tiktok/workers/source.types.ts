import type { IVideoRecordCandidate } from "../../src/core/types.js";

export interface IWorkerCollector<TInput> {
  collect(input: TInput): AsyncIterable<IVideoRecordCandidate> | Iterable<IVideoRecordCandidate> | Promise<AsyncIterable<IVideoRecordCandidate> | Iterable<IVideoRecordCandidate>>;
}

export function createUnsupportedCollector<TInput>(workerName: string): IWorkerCollector<TInput> {
  return {
    collect(): never {
      throw new Error(`${workerName} collector is not wired yet. Provide a source adapter before running the pipeline.`);
    },
  };
}
