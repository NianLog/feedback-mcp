import { parentPort, workerData } from 'node:worker_threads';
import { renderMarkdown } from './markdown-renderer.mjs';
import { markdownToPlain } from './markdown-plain.mjs';

const output = workerData.format === 'plain' ? markdownToPlain(workerData.message) : renderMarkdown(workerData.message);
parentPort?.postMessage(Buffer.byteLength(output, 'utf8') <= workerData.maxBytes ? output : null);
