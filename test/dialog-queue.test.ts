/**
 * 对话框路由测试：并发串行化、响应钳制、后端异常兜底。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DialogRouter } from '../src/dialog.js';
import type { DialogResult, UIBackend, DialogOptions } from '../src/core/types.js';
import { MAX_RESPONSE_CHARS, RESPONSE_TRUNCATION_MARKER } from '../src/core/config.js';

interface TraceBackend extends UIBackend {
  events: string[];
}

/** 记录开始/结束事件的桩后端（可控制时序） */
function makeTraceBackend(name: string, durationMs: number, result: DialogResult): TraceBackend {
  return {
    events: [],
    async isAvailable() {
      return true;
    },
    show(options: DialogOptions): Promise<DialogResult> {
      const self = this as TraceBackend;
      self.events.push(`start:${name}`);
      return new Promise((resolve) =>
        setTimeout(() => {
          self.events.push(`end:${name}`);
          resolve(result);
        }, durationMs)
      );
    },
  };
}

test('并发调用被串行化：第二个对话框在第一个结束后才启动', async () => {
  const events: string[] = [];
  const backendA: UIBackend = {
    async isAvailable() {
      return true;
    },
    show: () =>
      new Promise((resolve) =>
        setTimeout(() => {
          events.push('end:A');
          resolve({ submitted: true, response: 'a' });
        }, 80)
      ),
  };
  const backendB: UIBackend = {
    async isAvailable() {
      return true;
    },
    show: () =>
      new Promise((resolve) =>
        setTimeout(() => {
          events.push('end:B');
          resolve({ submitted: true, response: 'b' });
        }, 10)
      ),
  };

  let call = 0;
  const router = new DialogRouter(async () => (call++ === 0 ? backendA : backendB));

  const [ra, rb] = await Promise.all([
    router.show({ message: 'a', language: 'zh' }),
    router.show({ message: 'b', language: 'zh' }),
  ]);

  // B（快）必须在 A（慢）之后完成 —— 串行而非并行
  assert.deepEqual(events, ['end:A', 'end:B']);
  assert.equal(ra.response, 'a');
  assert.equal(rb.response, 'b');
});

test('响应超长被钳制并追加截断标记', async () => {
  const huge = 'x'.repeat(MAX_RESPONSE_CHARS + 500);
  const backend = makeTraceBackend('big', 1, { submitted: true, response: huge });
  const router = new DialogRouter(async () => backend);

  const r = await router.show({ message: 'm', language: 'zh' });
  assert.equal(r.response?.length, MAX_RESPONSE_CHARS + RESPONSE_TRUNCATION_MARKER.length);
  assert.ok(r.response?.endsWith(RESPONSE_TRUNCATION_MARKER));
});

test('后端 show 抛异常时兜底为 error 结果，不击穿调用方', async () => {
  const backend: UIBackend = {
    async isAvailable() {
      return true;
    },
    show: () => Promise.reject(new Error('boom')),
  };
  const router = new DialogRouter(async () => backend);

  const r = await router.show({ message: 'm', language: 'zh' });
  assert.equal(r.submitted, false);
  assert.ok(r.error?.includes('boom'));
});

test('前序失败不阻塞后续对话框', async () => {
  let call = 0;
  const router = new DialogRouter(async () =>
    call++ === 0
      ? {
          async isAvailable() {
            return true;
          },
          show: () => Promise.reject(new Error('first fails')),
        }
      : makeTraceBackend('second', 1, { submitted: true, response: 'ok' })
  );

  const first = await router.show({ message: '1', language: 'zh' });
  assert.ok(first.error);
  const second = await router.show({ message: '2', language: 'zh' });
  assert.deepEqual(second, { submitted: true, response: 'ok' });
});

test('排队请求取消后立即返回，轮到它时不会启动后端', async () => {
  let release!: (result: DialogResult) => void;
  const shown: string[] = [];
  const backend: UIBackend = {
    isAvailable: async () => true,
    show: (options) => {
      shown.push(options.message);
      return new Promise((resolve) => { release = resolve; });
    },
  };
  const router = new DialogRouter(async () => backend);
  const first = router.show({ message: 'first', language: 'zh' });
  await new Promise((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const second = router.show({ message: 'cancelled', language: 'zh', signal: controller.signal });
  controller.abort();
  const result = await Promise.race([
    second,
    new Promise((resolve) => setTimeout(() => resolve('still waiting'), 100)),
  ]);
  release({ submitted: true, response: 'first' });
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(result, { submitted: false });
  assert.deepEqual(shown, ['first']);
});

test('已经取消的调用不会探测或启动后端', async () => {
  const controller = new AbortController();
  controller.abort();
  let selected = false;
  const router = new DialogRouter(async () => {
    selected = true;
    throw new Error('must not select');
  });
  assert.deepEqual(await router.show({ message: 'm', language: 'zh', signal: controller.signal }), { submitted: false });
  assert.equal(selected, false);
});
