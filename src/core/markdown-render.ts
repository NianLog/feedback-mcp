import { Worker } from 'node:worker_threads';
import { plainTextHTML } from './markdown-renderer.mjs';

export const RENDER_TIMEOUT_MS = 2000;
export const MAX_RENDER_BYTES = 10 * 1024 * 1024;
export interface RenderedMarkdown { html: string; fallback: boolean }
interface ConvertedMarkdown { text: string; fallback: boolean }

/** 原生 ESM Worker 同时支持源码开发和编译后的 npm 包，不依赖 TypeScript 加载器。 */
function convertMarkdownInWorker(message: string, format: 'html' | 'plain', signal?: AbortSignal): Promise<ConvertedMarkdown> {
  const fallback = (): ConvertedMarkdown => ({ text: format === 'html' ? plainTextHTML(message) : message, fallback: true });
  if (signal?.aborted) return Promise.resolve(fallback());
  return new Promise((resolve) => {
    let worker: Worker | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (output?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const result = typeof output === 'string' && Buffer.byteLength(output, 'utf8') <= MAX_RENDER_BYTES
        ? { text: output, fallback: false } : fallback();
      void Promise.resolve(worker?.terminate()).catch(() => {}).then(() => resolve(result));
    };
    const onAbort = () => finish();
    try {
      worker = new Worker(new URL('./markdown-worker.mjs', import.meta.url), {
        workerData: { message, format, maxBytes: MAX_RENDER_BYTES },
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      });
      worker.once('message', finish);
      worker.once('error', () => finish());
      worker.once('exit', () => finish());
      timer = setTimeout(() => finish(), RENDER_TIMEOUT_MS);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    } catch { finish(); }
  });
}

export async function renderMarkdownInWorker(message: string, signal?: AbortSignal): Promise<RenderedMarkdown> {
  const result = await convertMarkdownInWorker(message, 'html', signal);
  return { html: result.text, fallback: result.fallback };
}

export function markdownToPlainInWorker(message: string, signal?: AbortSignal): Promise<ConvertedMarkdown> {
  return convertMarkdownInWorker(message, 'plain', signal);
}
