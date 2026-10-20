import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import workerThreads from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { renderMarkdownInWorker, markdownToPlainInWorker, MAX_RENDER_BYTES } from '../src/core/markdown-render.js';
import { BrowserBackend } from '../src/backends/browser-backend.js';

test('Worker：普通 Markdown 净化并保留富文本', async () => {
  const result = await renderMarkdownInWorker('# 标题\n\n**正文** <script>alert(1)</script>');
  assert.equal(result.fallback, false);
  assert.match(result.html, /<h1>标题<\/h1>/);
  assert.ok(!result.html.includes('<script'));
});

test('Worker：1M 字符普通文本仍完整渲染', async () => {
  const message = '普通文本'.repeat(250000);
  const result = await renderMarkdownInWorker(message);
  assert.equal(result.fallback, false);
  assert.ok(result.html.includes(message));
});

test('复审R2 Worker：native 转换保留现有 Markdown、代码和中文语义', async () => {
  for (const [message, expected] of [
    ['# 标题\n\n**正文**', '标题\n\n正文'],
    ['```html\n<!-- 保留 -->\n```', '<!-- 保留 -->'],
    ['vector<B> file_name_here', 'vector<B> file_name_here'],
    ['[链接](https://example.com)', '链接 (https://example.com)'],
  ]) {
    assert.deepEqual(await markdownToPlainInWorker(message), { text: expected, fallback: false });
  }
});

test('复审R2 Worker：native 1M 中文普通文本保持完整且无需降级', async () => {
  const message = '普通文本'.repeat(250000);
  assert.deepEqual(await markdownToPlainInWorker(message), { text: message, fallback: false });
});

test('Worker：同一会话的并发加载和重载只渲染一次', async () => {
  const RealWorker = workerThreads.Worker;
  let started = 0;
  const patched = mock.method(workerThreads, 'Worker', function (...args: any[]) {
    started++; return new (RealWorker as any)(...args);
  } as any);
  syncBuiltinESMExports();
  const controller = new AbortController();
  let ready!: (url: string) => void;
  const urlReady = new Promise<string>(resolve => { ready = resolve; });
  const backend = new BrowserBackend({ launcher: async () => 'stub', onServerReady: ready, postResolveTeardownMs: 10 });
  const result = backend.show({ message: '**cached**', language: 'zh', signal: controller.signal });
  try {
    const url = await urlReady;
    const pages = await Promise.all([fetch(url).then(res => res.text()), fetch(url).then(res => res.text())]);
    assert.ok(pages.every(page => page.includes('<strong>cached</strong>')));
    assert.ok((await (await fetch(url)).text()).includes('<strong>cached</strong>'));
    assert.equal(started, 1);
  } finally { controller.abort(); await result; patched.mock.restore(); syncBuiltinESMExports(); }
});

test('Worker：对话框结束结果等待旧线程真正退出，队列不会提前启动下一次渲染', async () => {
  let started!: () => void, stopped!: (code: number) => void;
  const workerStarted = new Promise<void>(resolve => { started = resolve; });
  const termination = new Promise<number>(resolve => { stopped = resolve; });
  const patched = mock.method(workerThreads, 'Worker', function () {
    started(); return Object.assign(new EventEmitter(), { terminate: () => termination });
  } as any);
  syncBuiltinESMExports();
  let ready!: (url: string) => void;
  const urlReady = new Promise<string>(resolve => { ready = resolve; });
  const controller = new AbortController();
  const backend = new BrowserBackend({ launcher: async () => 'stub', onServerReady: ready, postResolveTeardownMs: 100 });
  let settled = false;
  const result = backend.show({ message: 'cancel during rendering', language: 'zh', signal: controller.signal }).then(value => { settled = true; return value; });
  try {
    const url = await urlReady;
    const page = fetch(url).then(response => response.text());
    await workerStarted;
    controller.abort();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    stopped(1);
    assert.equal((await result).submitted, false);
    assert.match(await page, /会话已结束/);
  } finally { stopped(1); controller.abort(); await result; patched.mock.restore(); syncBuiltinESMExports(); }
});

test('Worker：1M 字符复杂输入不阻塞主线程，预算到期保留完整转义原文', async () => {
  const message = '[x](https://example.com) '.repeat(40000);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 20);
  const result = await renderMarkdownInWorker(message);
  clearInterval(timer);
  assert.equal(message.length, 1000000);
  assert.equal(result.fallback, true);
  assert.match(result.html, /plain-fallback/);
  assert.ok(result.html.includes(message));
  assert.ok(ticks >= 5, `main thread did not run: ${ticks}`);
});

test('Worker：取消终止线程；预先取消不启动线程', async () => {
  let started = 0, stopped = 0;
  const patched = mock.method(workerThreads, 'Worker', function () {
    started++;
    return Object.assign(new EventEmitter(), { terminate() { stopped++; return Promise.resolve(0); } });
  } as any);
  syncBuiltinESMExports();
  try {
    for (const plain of [false, true]) {
      const controller = new AbortController();
      const convert = plain ? markdownToPlainInWorker : renderMarkdownInWorker;
      const pending = convert('<script>& payload', controller.signal);
      controller.abort();
      const result = await pending;
      if ('html' in result) assert.ok(result.html.includes('&lt;script&gt;&amp; payload'));
      else assert.equal(result.text, '<script>& payload');
      await convert('pre-aborted', controller.signal);
    }
    assert.equal(started, 2); assert.equal(stopped, 2);
  } finally { patched.mock.restore(); syncBuiltinESMExports(); }
});

test('Worker：输出超限、线程异常和提前退出都安全降为纯文本并释放线程', async () => {
  for (const plain of [false, true]) {
    for (const failure of ['large', 'error', 'exit']) {
      let stopped = 0;
      const patched = mock.method(workerThreads, 'Worker', function () {
        const worker = Object.assign(new EventEmitter(), { terminate() { stopped++; return Promise.resolve(0); } });
        queueMicrotask(() => {
          if (failure === 'large') worker.emit('message', 'x'.repeat(MAX_RENDER_BYTES + 1));
          else if (failure === 'error') worker.emit('error', new Error('failed'));
          else worker.emit('exit', 1);
        });
        return worker;
      } as any);
      syncBuiltinESMExports();
      try {
        const result = await (plain ? markdownToPlainInWorker : renderMarkdownInWorker)('<input>&原文');
        assert.equal(result.fallback, true, failure);
        if ('html' in result) assert.ok(result.html.includes('&lt;input&gt;&amp;原文'));
        else assert.equal(result.text, '<input>&原文');
        assert.equal(stopped, 1);
      } finally { patched.mock.restore(); syncBuiltinESMExports(); }
    }
  }
});
