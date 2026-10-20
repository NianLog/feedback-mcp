import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { startMcpSession, startRawMcpSession } from './fixtures/mcp-session.mjs';

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('MCP：启动版本、旧配置迁移提示与旧客户端握手一致', async () => {
  const s = await startMcpSession(entry, { env: { FEEDBACK_TIMEOUT: '600000', FEEDBACK_MAX_TOKENS: 'private-value' } });
  try {
    const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    assert.equal(s.client.getServerVersion()?.version, version);
    assert.match(s.logs(), /FEEDBACK_TIMEOUT.*seconds/);
    assert.match(s.logs(), /FEEDBACK_MAX_TOKENS.*removed/);
    assert.match(s.logs(), /Timeout: 86400s/);
    assert.doesNotMatch(s.logs(), /private-value/);
    assert.equal((await s.client.listTools()).tools[0].inputSchema.properties.message.maxLength, 1000000);
  } finally { await s.close(); }
});

for (const modern of [false, true]) {
test(`MCP ${modern ? 'v2' : 'v1'}：宿主超时早于弹窗期限时取消，连接和后续反馈仍可用`, async () => {
  const s = await startMcpSession(entry, { modern, env: { FEEDBACK_TIMEOUT: '10' } });
  try {
    const call = s.callTool({ name: 'interactive_feedback', arguments: { message: 'Host deadline cancellation' } }, { timeout: 3000 });
    const rejected = assert.rejects(call, /timed out|timeout/i);
    const dialog = await s.dialog();
    const events = await fetch(dialog.url + '/events?token=' + dialog.token, { signal: AbortSignal.timeout(8000) });
    const ended = events.text();
    await rejected;
    assert.match(await ended, /"status":"cancelled"/);
    const next = s.callTool({ name: 'interactive_feedback', arguments: { message: 'Next dialog' } });
    const nextDialog = await s.dialog(1);
    await fetch(nextDialog.url + '/submit', { method: 'POST', headers: { 'X-Feedback-Token': nextDialog.token }, body: JSON.stringify({ response: '后续反馈 ✓' }) });
    assert.deepEqual((await next).structuredContent, { submitted: true, response: '后续反馈 ✓', timedOut: false });
  } finally { await s.close(); }
});
}

test('MCP：2026-07-28 discover 和真实 v2 客户端工具链路', async () => {
  const s = await startMcpSession(entry, { modern: true });
  try {
    assert.equal(s.client.getProtocolEra(), 'modern');
    const tools = await s.client.listTools();
    assert.equal(tools.tools[0].name, 'interactive_feedback');
    const call = s.client.callTool({ name: 'interactive_feedback', arguments: { message: '# 新协议中文' } });
    const dialog = await s.dialog();
    await fetch(dialog.url + '/submit', { method: 'POST', headers: { 'X-Feedback-Token': dialog.token }, body: JSON.stringify({ response: '新旧兼容 ✓' }) });
    assert.deepEqual((await call).structuredContent, { submitted: true, response: '新旧兼容 ✓', timedOut: false });
  } finally { await s.close(); }
});

test('MCP：真实 stdio 握手、输入边界和中文反馈保持兼容', async () => {
  const s = await startMcpSession(entry);
  try {
    const tools = await s.client.listTools();
    assert.equal(tools.tools[0].name, 'interactive_feedback');
    const invalid = await s.client.callTool({ name: 'interactive_feedback', arguments: { message: '' } });
    assert.equal(invalid.isError, true);
    const call = s.client.callTool({ name: 'interactive_feedback', arguments: { message: '# 中文消息' } });
    const dialog = await s.dialog();
    const reply = '中文回复\n第二行 ✓';
    const response = await fetch(dialog.url + '/submit', { method: 'POST', headers: { 'X-Feedback-Token': dialog.token }, body: JSON.stringify({ response: reply }) });
    assert.equal(response.status, 200);
    const result = await call;
    assert.deepEqual(result.structuredContent, { submitted: true, response: reply, timedOut: false });
    assert.equal(result.isError, false);
  } finally { await s.close(); }
});

for (const modern of [false, true]) {
test(`复审R1 MCP ${modern ? 'modern' : 'legacy'}：真实异步启动失败返回 error，连接仍可使用`, async () => {
  const s = await startMcpSession(entry, { modern, env: { FEEDBACK_TEST_FAIL_LAUNCH: 'async' } });
  try {
    const result = await s.callTool({ name: 'interactive_feedback', arguments: { message: 'async launch failure' } });
    assert.equal(result.isError, true);
    assert.match(result.structuredContent.error as string, /ENOENT/);
    assert.match(s.logs(), /Using system default browser as fallback/);
    assert.equal((await s.client.listTools()).tools[0].name, 'interactive_feedback');
  } finally { await s.close(); }
});

test(`复审R2 MCP ${modern ? 'modern' : 'legacy'}：native 1M 畸形消息不阻塞协议，预算到期保留全文`, async () => {
  const s = await startMcpSession(entry, { modern, env: { FEEDBACK_UI: 'native', FEEDBACK_TEST_NATIVE_ECHO: '1' } });
  const message = '['.repeat(1000000);
  try {
    const call = s.callTool({ name: 'interactive_feedback', arguments: { message } });
    void call.catch(() => {});
    await s.waitFor(/message length: 1000000/);
    if (modern) await s.client.listTools({}, { timeout: 1500 });
    else await s.client.ping({ timeout: 1500 });
    const result = await call;
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.response, message);
    assert.match(s.logs(), /using original text/);
  } finally { await s.close(); }
});

test(`复审R2 MCP ${modern ? 'modern' : 'legacy'}：native 转换期间取消不弹窗，后续调用正常`, async () => {
  const s = await startMcpSession(entry, { modern, env: { FEEDBACK_UI: 'native', FEEDBACK_TEST_NATIVE_ECHO: '1' } });
  const controller = new AbortController();
  let cancelled: Promise<void> | undefined;
  try {
    cancelled = assert.rejects(s.callTool({ name: 'interactive_feedback', arguments: { message: '['.repeat(1000000) } },
      { signal: controller.signal }), /abort|cancel/i);
    await s.waitFor(/message length: 1000000/);
    controller.abort(); await cancelled;
    const next = await s.callTool({ name: 'interactive_feedback', arguments: { message: '**后续调用 ✓**' } });
    assert.equal(next.structuredContent.response, '后续调用 ✓');
    assert.equal((s.logs().match(/Native process started/g) ?? []).length, 1);
  } finally { controller.abort(); await cancelled; await s.close(); }
});

test(`MCP ${modern ? 'v2 modern' : 'v1 legacy'}：取消阻止排队窗口，并结束活动窗口的事件流`, async () => {
  const s = await startMcpSession(entry, { modern });
  try {
    const first = s.client.callTool({ name: 'interactive_feedback', arguments: { message: 'first' } });
    const firstDialog = await s.dialog();
    const queuedController = new AbortController();
    const queued = s.callTool({ name: 'interactive_feedback', arguments: { message: 'must not open' } }, { signal: queuedController.signal });
    const queuedRejected = assert.rejects(queued, /abort|cancel/i);
    await s.waitFor(/queueing/);
    queuedController.abort(); await queuedRejected;
    await fetch(firstDialog.url + '/cancel', { method: 'POST', headers: { 'X-Feedback-Token': firstDialog.token } });
    await first; await pause(150);
    assert.equal(s.urls().length, 1);

    const activeController = new AbortController();
    const active = s.callTool({ name: 'interactive_feedback', arguments: { message: 'cancel active' } }, { signal: activeController.signal });
    const activeRejected = assert.rejects(active, /abort|cancel/i);
    const activeDialog = await s.dialog(1);
    const stream = await fetch(`${activeDialog.url}/events?token=${activeDialog.token}`, { signal: AbortSignal.timeout(3000) });
    const body = stream.text();
    activeController.abort(); await activeRejected;
    assert.match(await body, /"status":"cancelled"/);
  } finally { await s.close(); }
});
test(`MCP ${modern ? 'v2 modern' : 'v1 legacy'}：输入边界、超时及启动错误保持原有语义`, async () => {
  const s = await startMcpSession(entry, { modern });
  try {
    for (const message of ['', 'x'.repeat(1000001)]) {
      assert.equal((await s.client.callTool({ name: 'interactive_feedback', arguments: { message } })).isError, true);
    }
    const call = s.client.callTool({ name: 'interactive_feedback', arguments: { message: 'timeout' } });
    const dialog = await s.dialog();
    await fetch(dialog.url + '/timeout', { method: 'POST', headers: { 'X-Feedback-Token': dialog.token } });
    const result = await call;
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, { submitted: false, response: '', timedOut: true });
  } finally { await s.close(); }
  const failing = await startMcpSession(entry, { modern, env: { FEEDBACK_TEST_FAIL_LAUNCH: '1' } });
  try {
    const result = await failing.callTool({ name: 'interactive_feedback', arguments: { message: 'launch must fail' } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.submitted, false);
    assert.match(result.structuredContent.error as string, /Failed to open/);
  } finally { await failing.close(); }
});
}

for (const [revision, probeModern] of [['2024-10-07', false], ['2024-11-05', false], ['2025-03-26', false], ['2025-06-18', false], ['2025-11-25', false], ['2025-11-25', true]] as const) {
test(`MCP ${revision}${probeModern ? ' probe 回退' : ''}：原始旧握手、工具发现和中文回复`, async () => {
  const s = await startRawMcpSession(entry, revision, probeModern);
  try {
    assert.equal(s.initialized.result.protocolVersion, revision);
    const tools = await s.request('tools/list');
    assert.equal(tools.result.tools[0].name, 'interactive_feedback');
    assert.equal(tools.result.tools[0].inputSchema.properties.message.maxLength, 1000000);
    const invalid = await s.request('tools/call', { name: 'interactive_feedback', arguments: { message: '' } });
    assert.equal(invalid.result.isError, true);
    const call = s.request('tools/call', { name: 'interactive_feedback', arguments: { message: '旧协议中文' } });
    const dialog = await s.dialog();
    await fetch(dialog.url + '/submit', { method: 'POST', headers: { 'X-Feedback-Token': dialog.token }, body: JSON.stringify({ response: '旧客户端回复 ✓' }) });
    const result = await call;
    assert.equal(result.result.isError, false);
    assert.match(result.result.content[0].text, /旧客户端回复 ✓/);
  } finally { await s.close(); }
});
}

for (const modern of [false, true]) {
test(`MCP ${modern ? 'modern tools/list' : 'legacy ping'}：1M 字符渲染期间仍响应协议请求和取消`, async () => {
  const s = await startMcpSession(entry, { modern });
  const controller = new AbortController();
  let cancelled: Promise<void> | undefined;
  try {
    const call = s.callTool({ name: 'interactive_feedback', arguments: { message: '[x](https://example.com) '.repeat(40000) } }, { signal: controller.signal });
    cancelled = assert.rejects(call, /abort|cancel/i);
    await s.waitFor(/Dialog opened/);
    const page = fetch(s.urls()[0]).then(response => response.text()).catch(error => { error.message += '\n' + s.logs(); throw error; });
    await pause(100);
    if (modern) await s.client.listTools({}, { timeout: 1500 });
    else await s.client.ping({ timeout: 1500 });
    controller.abort(); await cancelled;
    assert.match(await page, /会话已结束/);
  } finally { controller.abort(); await cancelled; await s.close(); }
});
}
