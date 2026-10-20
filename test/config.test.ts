/**
 * 配置解析边界测试：非法值回退、区间钳制。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC } from '../src/core/config.js';

test('默认配置（无环境变量）', () => {
  const c = parseConfig({});
  assert.equal(c.defaultTimeoutMs, DEFAULT_TIMEOUT_SEC * 1000);
  assert.equal(c.language, 'zh');
  assert.equal(c.ui, 'browser');
  assert.equal(c.theme, 'auto');
  assert.equal(c.port, 0);
});

test('FEEDBACK_TIMEOUT 合法值正常换算', () => {
  assert.equal(parseConfig({ FEEDBACK_TIMEOUT: '30' }).defaultTimeoutMs, 30_000);
  assert.equal(parseConfig({ FEEDBACK_TIMEOUT: ' 120 ' }).defaultTimeoutMs, 120_000);
});

test('FEEDBACK_TIMEOUT 非法值回退默认', () => {
  assert.equal(parseConfig({ FEEDBACK_TIMEOUT: 'abc' }).defaultTimeoutMs, DEFAULT_TIMEOUT_SEC * 1000);
  assert.equal(parseConfig({ FEEDBACK_TIMEOUT: '' }).defaultTimeoutMs, DEFAULT_TIMEOUT_SEC * 1000);
  // parseInt 解析 '300.9' → 300
  assert.equal(parseConfig({ FEEDBACK_TIMEOUT: '300.9' }).defaultTimeoutMs, 300_000);
});

test('FEEDBACK_TIMEOUT 钳制到 [5, 86400]', () => {
  // 低于下界 → 钳到 5s（不再回退 300s，行为可预测）
  assert.equal(parseConfig({ FEEDBACK_TIMEOUT: '1' }).defaultTimeoutMs, 5_000);
  assert.equal(parseConfig({ FEEDBACK_TIMEOUT: '-100' }).defaultTimeoutMs, 5_000);
  // 高于上界 → 钳到 86400s（防 setTimeout 超 2^31-1ms 溢出立即触发）
  assert.equal(parseConfig({ FEEDBACK_TIMEOUT: '999999999' }).defaultTimeoutMs, MAX_TIMEOUT_SEC * 1000);
});

test('旧毫秒配置和已移除参数有迁移提示，日志不泄露原始值', (t) => {
  const messages: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => messages.push(args.map(String).join(' ')));
  const config = parseConfig({ FEEDBACK_TIMEOUT: '600000', FEEDBACK_MAX_TOKENS: 'private-value' });
  assert.equal(config.defaultTimeoutMs, MAX_TIMEOUT_SEC * 1000);
  assert.match(messages.join('\n'), /FEEDBACK_TIMEOUT.*seconds/);
  assert.match(messages.join('\n'), /FEEDBACK_MAX_TOKENS.*removed/);
  assert.doesNotMatch(messages.join('\n'), /private-value/);
});

test('非法超时回退有提示，正常秒配置保持安静', (t) => {
  const messages: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => messages.push(args.map(String).join(' ')));
  assert.equal(parseConfig({ FEEDBACK_TIMEOUT: 'private-invalid-value' }).defaultTimeoutMs, 300000);
  assert.match(messages.join('\n'), /FEEDBACK_TIMEOUT/);
  assert.doesNotMatch(messages.join('\n'), /private-invalid-value/);
  messages.length = 0;
  assert.equal(parseConfig({ FEEDBACK_TIMEOUT: '600' }).defaultTimeoutMs, 600000);
  assert.deepEqual(messages, []);
});

test('FEEDBACK_LANGUAGE 仅接受 zh/en，非法回退 zh', () => {
  assert.equal(parseConfig({ FEEDBACK_LANGUAGE: 'en' }).language, 'en');
  assert.equal(parseConfig({ FEEDBACK_LANGUAGE: 'zh' }).language, 'zh');
  assert.equal(parseConfig({ FEEDBACK_LANGUAGE: 'fr' }).language, 'zh');
  assert.equal(parseConfig({ FEEDBACK_LANGUAGE: 'EN' }).language, 'zh');
});

test('FEEDBACK_UI 仅接受 browser/native/auto，非法回退 browser', () => {
  assert.equal(parseConfig({ FEEDBACK_UI: 'native' }).ui, 'native');
  assert.equal(parseConfig({ FEEDBACK_UI: 'auto' }).ui, 'auto');
  assert.equal(parseConfig({ FEEDBACK_UI: 'BROWSER' }).ui, 'browser');
  assert.equal(parseConfig({ FEEDBACK_UI: 'chrome' }).ui, 'browser');
});

test('FEEDBACK_THEME 仅接受 auto/light/dark，非法回退 auto', () => {
  assert.equal(parseConfig({ FEEDBACK_THEME: 'light' }).theme, 'light');
  assert.equal(parseConfig({ FEEDBACK_THEME: 'dark' }).theme, 'dark');
  assert.equal(parseConfig({ FEEDBACK_THEME: 'blue' }).theme, 'auto');
});

test('FEEDBACK_PORT 非法回退 0（随机），合法值透传', () => {
  assert.equal(parseConfig({ FEEDBACK_PORT: '8765' }).port, 8765);
  assert.equal(parseConfig({ FEEDBACK_PORT: '0' }).port, 0);
  assert.equal(parseConfig({ FEEDBACK_PORT: 'abc' }).port, 0);
  assert.equal(parseConfig({ FEEDBACK_PORT: '-1' }).port, 0);
  assert.equal(parseConfig({ FEEDBACK_PORT: '99999' }).port, 0);
  assert.equal(parseConfig({ FEEDBACK_PORT: '65536' }).port, 0);
});
