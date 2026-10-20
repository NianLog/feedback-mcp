/**
 * 浏览器后端集成测试：真实起 HTTP 服务（stub 掉浏览器启动），验证协议、
 * 安全校验（令牌/Host）、体积限制、路径遍历防护与资源释放。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BrowserBackend } from '../src/backends/browser-backend.js';
import type { DialogResult } from '../src/core/types.js';

/** 起一个对话框服务器（浏览器启动替换为 stub） */
function startDialog(
  options: Partial<Parameters<BrowserBackend['show']>[0]> = {},
  launcher: (url: string) => Promise<string> = async () => 'stub'
) {
  let url: string | undefined;
  const backend = new BrowserBackend({
    launcher,
    onServerReady: (u) => {
      url = u;
    },
    // 测试加速：结束后快速关停（生产默认 2000ms）
    postResolveTeardownMs: 100,
  });
  const result = backend.show({
    message: '# 测试消息\n\nhello **world**',
    language: 'zh',
    timeout: 15_000,
    ...options,
  });
  return {
    result,
    getUrl: () => {
      if (!url) throw new Error('server not ready');
      return url;
    },
  };
}

/** 等待服务器就绪 */
async function waitReady(getUrl: () => string, timeoutMs = 5_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    try {
      return getUrl();
    } catch {
      if (Date.now() - start > timeoutMs) throw new Error('server did not become ready');
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

/** 从页面 HTML 提取会话令牌 */
function extractToken(html: string): string {
  return html.match(/const FEEDBACK_TOKEN = "([^"]+)";/)?.[1] ?? '';
}

/** 原始 HTTP 请求（可控 Host 头与原始 path，绕过 fetch 的 URL 规范化） */
function rawRequest(
  url: string,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: u.port,
        method: opts.method ?? 'GET',
        path: opts.path ?? '/',
        headers: opts.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

test('提交流程：中文与多字节大文本完整无损（Buffer 收集）', async () => {
  // ~30 万字符中文（~900KB UTF-8），超过单个 chunk 大小，验证多字节跨界不损坏
  const bigChinese = '反馈'.repeat(150_000) + '✓完结';
  const { result, getUrl } = startDialog();
  const url = await waitReady(getUrl);

  const page = await rawRequest(url);
  assert.equal(page.status, 200);
  const token = extractToken(page.body);
  assert.ok(token.length >= 16, 'token should be present');

  const res = await fetch(`${url}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Feedback-Token': token },
    body: JSON.stringify({ response: bigChinese }),
  });
  assert.equal(res.status, 200);

  const dialogResult = await result;
  assert.equal(dialogResult.submitted, true);
  assert.equal(dialogResult.response, bigChinese);
  assert.ok(!dialogResult.response.includes('\uFFFD'), 'must not contain replacement chars');
});

test('取消流程：submitted=false 且不带 timedOut', async () => {
  const { result, getUrl } = startDialog();
  const url = await waitReady(getUrl);
  const token = extractToken((await rawRequest(url)).body);

  const res = await fetch(`${url}/cancel`, {
    method: 'POST',
    headers: { 'X-Feedback-Token': token },
  });
  assert.equal(res.status, 200);

  const dialogResult = await result;
  assert.equal(dialogResult.submitted, false);
  assert.notEqual(dialogResult.timedOut, true);
});

test('客户端超时上报：timedOut=true', async () => {
  const { result, getUrl } = startDialog();
  const url = await waitReady(getUrl);
  const token = extractToken((await rawRequest(url)).body);

  const res = await fetch(`${url}/timeout`, {
    method: 'POST',
    headers: { 'X-Feedback-Token': token },
  });
  assert.equal(res.status, 200);

  const dialogResult = await result;
  assert.equal(dialogResult.submitted, false);
  assert.equal(dialogResult.timedOut, true);
});

test('服务器侧超时兜底：无任何请求时到点自动结束', async () => {
  const { result, getUrl } = startDialog({ timeout: 150 });
  await waitReady(getUrl);
  const start = Date.now();
  const dialogResult = await result;
  assert.equal(dialogResult.timedOut, true);
  // 到点即结束（允许小幅调度误差）
  assert.ok(Date.now() - start < 3_000, 'server timeout should fire promptly');
});

test('令牌缺失/错误：POST 端点返回 403', async () => {
  const { result, getUrl } = startDialog();
  const url = await waitReady(getUrl);

  const noToken = await fetch(`${url}/cancel`, { method: 'POST' });
  assert.equal(noToken.status, 403);

  const badToken = await fetch(`${url}/cancel`, {
    method: 'POST',
    headers: { 'X-Feedback-Token': 'forged' },
  });
  assert.equal(badToken.status, 403);

  // 用正确令牌收尾
  const token = extractToken((await rawRequest(url)).body);
  await fetch(`${url}/cancel`, { method: 'POST', headers: { 'X-Feedback-Token': token } });
  assert.equal((await result).submitted, false);
});

test('Host 头校验：非本机回环 Host 拒绝（防 DNS rebinding）', async () => {
  const { result, getUrl } = startDialog();
  const url = await waitReady(getUrl);

  const evil = await rawRequest(url, { headers: { host: 'evil.example.com' } });
  assert.equal(evil.status, 403);

  // 正常 Host 仍可用
  const ok = await rawRequest(url);
  assert.equal(ok.status, 200);
  const token = extractToken(ok.body);
  await fetch(`${url}/cancel`, { method: 'POST', headers: { 'X-Feedback-Token': token } });
  await result;
});

test('请求体超限：>1MB 返回 413', async () => {
  const { result, getUrl } = startDialog();
  const url = await waitReady(getUrl);
  const token = extractToken((await rawRequest(url)).body);

  const huge = 'x'.repeat(1_200_000);
  const oversized = await rawRequest(url, {
    method: 'POST',
    path: '/submit',
    headers: { 'Content-Type': 'application/json', 'X-Feedback-Token': token },
    body: JSON.stringify({ response: huge }),
  }).catch(() => null); // 连接可能被 destroy，视作拒绝

  if (oversized) assert.equal(oversized.status, 413);

  // 服务器仍存活，可正常取消
  await fetch(`${url}/cancel`, { method: 'POST', headers: { 'X-Feedback-Token': token } });
  assert.equal((await result).submitted, false);
});

test('非法 JSON 与非法响应格式返回 400', async () => {
  const { result, getUrl } = startDialog();
  const url = await waitReady(getUrl);
  const token = extractToken((await rawRequest(url)).body);

  const badJson = await fetch(`${url}/submit`, {
    method: 'POST',
    headers: { 'X-Feedback-Token': token },
    body: 'not-json{{{',
  });
  assert.equal(badJson.status, 400);

  const badShape = await fetch(`${url}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Feedback-Token': token },
    body: JSON.stringify({ response: 12345 }),
  });
  assert.equal(badShape.status, 400);

  await fetch(`${url}/cancel`, { method: 'POST', headers: { 'X-Feedback-Token': token } });
  await result;
});

test('非法提交不把回复片段写入日志，后续有效提交仍可完成', async (t) => {
  const logs: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args.map(String).join(' ')));
  const controller = new AbortController();
  const { result, getUrl } = startDialog({ signal: controller.signal });
  try {
    const url = await waitReady(getUrl);
    const token = extractToken((await rawRequest(url)).body);
    const invalid = await fetch(url + '/submit', { method: 'POST', headers: { 'X-Feedback-Token': token }, body: 'secret-reply' });
    assert.equal(invalid.status, 400);
    assert.doesNotMatch(logs.join('\n'), /secret-reply/);
    const valid = await fetch(url + '/submit', { method: 'POST', headers: { 'X-Feedback-Token': token }, body: JSON.stringify({ response: '有效回复 ✓' }) });
    assert.equal(valid.status, 200);
    assert.deepEqual(await result, { submitted: true, response: '有效回复 ✓' });
  } finally { controller.abort(); await result; }
});

test('路径遍历防护：/prism/.. 越界访问被拒绝', async () => {
  const { result, getUrl } = startDialog();
  const url = await waitReady(getUrl);
  const token = extractToken((await rawRequest(url)).body);

  // 原始 path 绕过 fetch/URL 的规范化
  const traversal = await rawRequest(url, { path: '/prism/../package.json' });
  assert.ok(traversal.status === 403 || traversal.status === 404, `got ${traversal.status}`);
  assert.ok(!traversal.body.includes('feedback-mcp-server'), 'package.json must not leak');

  const encoded = await rawRequest(url, { path: '/prism/%2e%2e/package.json' });
  assert.ok(encoded.status === 403 || encoded.status === 404);

  await fetch(`${url}/cancel`, { method: 'POST', headers: { 'X-Feedback-Token': token } });
  await result;
});

test('畸形 URL 编码返回 400，正常 Prism 资源 200', async () => {
  const { result, getUrl } = startDialog();
  const url = await waitReady(getUrl);
  const token = extractToken((await rawRequest(url)).body);

  const bad = await rawRequest(url, { path: '/prism/%zz.js' });
  assert.ok(bad.status === 400 || bad.status === 404, `got ${bad.status}`);

  const good = await rawRequest(url, { path: '/prism/components/prism-javascript.js' });
  assert.equal(good.status, 200);
  assert.match(good.body, /Prism\.languages/);

  const missing = await rawRequest(url, { path: '/prism/components/prism-nope.js' });
  assert.equal(missing.status, 404);

  await fetch(`${url}/cancel`, { method: 'POST', headers: { 'X-Feedback-Token': token } });
  await result;
});

test('未知路径 404；页面带安全响应头', async () => {
  const { result, getUrl } = startDialog();
  const url = await waitReady(getUrl);
  const token = extractToken((await rawRequest(url)).body);

  const notFound = await fetch(`${url}/whatever`);
  assert.equal(notFound.status, 404);

  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');

  await fetch(`${url}/cancel`, { method: 'POST', headers: { 'X-Feedback-Token': token } });
  await result;
});

test('资源释放：结束后端口关闭、进程句柄不泄漏', async () => {
  const { result, getUrl } = startDialog();
  const url = await waitReady(getUrl);
  const token = extractToken((await rawRequest(url)).body);
  await fetch(`${url}/cancel`, { method: 'POST', headers: { 'X-Feedback-Token': token } });
  await result;

  // 等 socket 冲刷 + 强制销毁完成后，端口应不可达
  await new Promise((r) => setTimeout(r, 900));
  await assert.rejects(
    () => fetch(url),
    (err: unknown) => err instanceof Error,
    'server should be closed after resolution'
  );
});

test('浏览器启动失败：返回显式 error 而非伪装成用户取消', async () => {
  const { result, getUrl } = startDialog({}, async () => {
    throw new Error('no browser found on this machine');
  });
  await waitReady(getUrl);
  const dialogResult = await result;
  assert.equal(dialogResult.submitted, false);
  assert.ok(dialogResult.error?.includes('no browser found'), `error: ${dialogResult.error}`);
});

test('连续多轮对话框无累积泄漏（15 轮顺序提交）', async () => {
  const baseline = process.getActiveResourcesInfo().length;

  for (let i = 0; i < 15; i++) {
    const { result, getUrl } = startDialog({ message: `round ${i}` });
    const url = await waitReady(getUrl);
    const token = extractToken((await rawRequest(url)).body);
    const res = await fetch(`${url}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Feedback-Token': token },
      body: JSON.stringify({ response: `r${i}` }),
    });
    assert.equal(res.status, 200);
    const r = await result;
    assert.equal(r.response, `r${i}`);
  }

  // 等待最后的 socket 冲刷/销毁完成，活动资源应回到基线附近（允许小幅波动）
  await new Promise((r) => setTimeout(r, 1_200));
  const after = process.getActiveResourcesInfo().length;
  assert.ok(after <= baseline + 4, `resource leak: baseline=${baseline}, after=${after}`);
});

test('并发两台服务器端口独立互不干扰', async () => {
  const a = startDialog();
  const b = startDialog();
  const urlA = await waitReady(a.getUrl);
  const urlB = await waitReady(b.getUrl);
  assert.notEqual(urlA, urlB);

  const tokenA = extractToken((await rawRequest(urlA)).body);
  const tokenB = extractToken((await rawRequest(urlB)).body);
  assert.notEqual(tokenA, tokenB);

  // A 的令牌不能操作 B（令牌与会话绑定）
  const cross = await fetch(`${urlB}/cancel`, {
    method: 'POST',
    headers: { 'X-Feedback-Token': tokenA },
  });
  assert.equal(cross.status, 403);

  await fetch(`${urlA}/cancel`, { method: 'POST', headers: { 'X-Feedback-Token': tokenA } });
  await fetch(`${urlB}/cancel`, { method: 'POST', headers: { 'X-Feedback-Token': tokenB } });
  await a.result;
  await b.result;
});

test('结束后晚到的页面加载拿到收尾页（页面从未加载过的路径）', async () => {
  // 模拟"脚本方秒速提交、浏览器冷启动晚到"：到超时结束前页面从未被加载
  const { result, getUrl } = startDialog({ timeout: 150 });
  await waitReady(getUrl);
  await result; // 服务器侧超时结束

  // 晚到的窗口此刻加载：应得到"会话已结束"收尾页（含自关脚本），而不是连接拒绝
  const url = getUrl();
  const late = await fetch(url);
  assert.equal(late.status, 200);
  const html = await late.text();
  assert.ok(html.includes('会话已结束'), 'late window must see finished page');
  assert.ok(html.includes('window.close()'), 'finished page must attempt self-close');
  assert.ok(!html.includes('FEEDBACK_TOKEN'), 'finished page must not embed session token');
});

test('结束后重复加载与过期提交：收尾页 + finished 响应', async () => {
  const { result, getUrl } = startDialog();
  const url = await waitReady(getUrl);
  const token = extractToken((await rawRequest(url)).body);

  await fetch(`${url}/cancel`, { method: 'POST', headers: { 'X-Feedback-Token': token } });
  assert.equal((await result).submitted, false);

  // 已结束后：页面请求改送收尾页；过期提交不再改变结果，如实返回 finished
  const page = await fetch(url);
  assert.ok((await page.text()).includes('会话已结束'));

  const stale = await fetch(`${url}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Feedback-Token': token },
    body: JSON.stringify({ response: '迟到的回复' }),
  });
  assert.equal(stale.status, 200);
  assert.deepEqual(await stale.json(), { finished: true, status: 'cancelled' });
});

test('同一固定端口连续展示 50 轮，等待旧服务释放后再监听', async () => {
  const reservation = http.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  let ready!: (url: string) => void;
  const backend = new BrowserBackend({
    launcher: async () => 'stub',
    onServerReady: (url) => ready(url),
    postResolveTeardownMs: 10,
  });
  for (let round = 0; round < 50; round++) {
    const readyPromise = new Promise<string>((resolve) => { ready = resolve; });
    const result = backend.show({ message: `round ${round}`, language: 'zh', timeout: 2000, port });
    const url = await Promise.race([
      readyPromise,
      result.then((value) => { throw new Error(value.error ?? 'dialog ended before binding'); }),
    ]);
    const token = extractToken((await rawRequest(url)).body);
    await fetch(`${url}/submit`, {
      method: 'POST', headers: { 'X-Feedback-Token': token }, body: JSON.stringify({ response: `${round}` }),
    });
    assert.deepEqual(await result, { submitted: true, response: `${round}` });
  }
});

test('提交体读取期间取消，迟到的提交返回真实终态而非成功', async () => {
  const { result, getUrl } = startDialog();
  const url = await waitReady(getUrl);
  const token = extractToken((await rawRequest(url)).body);
  let complete!: () => void;
  const submission = new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(`${url}/submit`, { method: 'POST', headers: { 'X-Feedback-Token': token } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write('{"response":');
    complete = () => req.end('"late reply"}');
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await fetch(`${url}/cancel`, { method: 'POST', headers: { 'X-Feedback-Token': token } });
  assert.deepEqual(await result, { submitted: false });
  complete();
  const actual = await submission;
  assert.equal(actual.status, 200);
  assert.deepEqual(JSON.parse(actual.body), { finished: true, status: 'cancelled' });
});

test('HEAD 页面返回完整空响应，不挂起连接', async () => {
  const { result, getUrl } = startDialog();
  const url = await waitReady(getUrl);
  const token = extractToken((await rawRequest(url)).body);
  try {
    const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(500) });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally {
    await fetch(`${url}/cancel`, { method: 'POST', headers: { 'X-Feedback-Token': token } });
    await result;
  }
});

test('浏览器启动器挂起时，配置超时仍能结束调用', async () => {
  const { result, getUrl } = startDialog({ timeout: 100 }, () => new Promise(() => {}));
  const url = await waitReady(getUrl);
  const token = extractToken((await rawRequest(url)).body);
  const actual = await Promise.race([
    result,
    new Promise((resolve) => setTimeout(() => resolve('still waiting'), 500)),
  ]);
  if (actual === 'still waiting') {
    await fetch(`${url}/cancel`, { method: 'POST', headers: { 'X-Feedback-Token': token } });
    await result;
  }
  assert.deepEqual(actual, { submitted: false, timedOut: true });
});

test('客户端取消会结束活动调用，并通过事件流通知页面', async () => {
  const controller = new AbortController();
  const { result, getUrl } = startDialog({ signal: controller.signal });
  const url = await waitReady(getUrl);
  const token = extractToken((await rawRequest(url)).body);
  const events = await fetch(`${url}/events?token=${token}`, { signal: AbortSignal.timeout(1000) });
  assert.equal(events.headers.get('content-type'), 'text/event-stream');
  const body = events.text();
  controller.abort();
  assert.deepEqual(await result, { submitted: false });
  assert.match(await body, /"status":"cancelled"/);
});
