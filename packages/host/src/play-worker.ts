// Worker thread entry: runs one headless play-test and posts the result back.
import { parentPort, workerData } from 'node:worker_threads';
import type { PlayPayload } from './play.ts';
import { executePlay } from './play-exec.ts';

try {
  const result = await executePlay(workerData as PlayPayload);
  parentPort!.postMessage({ ok: true, result });
} catch (err) {
  parentPort!.postMessage({
    ok: false,
    error: { message: err instanceof Error ? err.message : String(err) },
  });
}
