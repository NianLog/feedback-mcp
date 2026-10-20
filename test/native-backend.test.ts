/**
 * 原生后端测试：PowerShell 输出解析（B64 信封/旧格式/畸形）、ps1 脚本存在性、
 * stdin→stdout UTF-8 管道（Windows 真实 powershell 下验证编码链路）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { NativeBackend, parsePowerShellResult } from '../src/backends/native-backend.js';
import { DialogRouter } from '../src/dialog.js';
import { MAX_RESPONSE_CHARS, RESPONSE_TRUNCATION_MARKER } from '../src/core/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PS1_PATH = path.resolve(__dirname, '..', 'assets', 'native', 'win-feedback.ps1');

/** 生成 B64 信封输出（与 ps1 脚本同构） */
function b64Envelope(obj: unknown): string {
  return 'B64:' + Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

test('解析：B64 信封 submitted（含中文与多行）', () => {
  const response = '第一行\nsecond line\n\ttabbed';
  const r = parsePowerShellResult(b64Envelope({ status: 'submitted', response }));
  assert.deepEqual(r, { submitted: true, response });
});

test('解析：B64 信封 cancelled / timeout', () => {
  assert.deepEqual(parsePowerShellResult(b64Envelope({ status: 'cancelled', response: '' })), {
    submitted: false,
  });
  assert.deepEqual(parsePowerShellResult(b64Envelope({ status: 'timeout', response: '' })), {
    submitted: false,
    timedOut: true,
  });
});

test('解析：旧版裸 JSON 兼容', () => {
  const r = parsePowerShellResult(JSON.stringify({ status: 'submitted', response: 'legacy' }));
  assert.deepEqual(r, { submitted: true, response: 'legacy' });
});

test('解析：response 非字符串时回退空串', () => {
  const r = parsePowerShellResult(b64Envelope({ status: 'submitted', response: 42 }));
  assert.deepEqual(r, { submitted: true, response: '' });
});

test('解析：畸形输入返回 null', () => {
  assert.equal(parsePowerShellResult(''), null);
  assert.equal(parsePowerShellResult('garbage'), null);
  assert.equal(parsePowerShellResult('B64:!!!not-base64'), null);
  assert.equal(parsePowerShellResult('B64:' + Buffer.from('not json').toString('base64')), null);
  assert.equal(parsePowerShellResult(JSON.stringify({ status: 'weird' })), null);
  assert.equal(parsePowerShellResult(b64Envelope(null)), null);
});

test('native：异常退出、正常取消与中文响应保持不同语义', async (t) => {
  const originalSpawn = childProcess.spawn;
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let script = '';
  t.mock.method(childProcess, 'spawn', ((_command: string, _args: string[], options: object) =>
    originalSpawn(process.execPath, ['-e', script], options)) as typeof childProcess.spawn);
  syncBuiltinESMExports();
  try {
    for (const scenario of [
      { os: 'linux', code: 255, output: '', error: true },
      { os: 'linux', code: 1, output: '', error: false },
      { os: 'darwin', code: 1, output: '', error: true },
      { os: 'darwin', code: 0, output: 'cancelled\n', error: false },
      { os: 'darwin', code: 0, output: 'submitted\r中文回复\n', response: '中文回复' },
    ]) {
      Object.defineProperty(process, 'platform', { ...descriptor, value: scenario.os });
      script = `process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(scenario.output)}); process.exitCode = ${scenario.code}; });`;
      const result = await new NativeBackend().show({ message: 'audit', language: 'zh', timeout: 2000 });
      if (scenario.response) assert.deepEqual(result, { submitted: true, response: scenario.response });
      else if (scenario.error) assert.ok(result.error, `${scenario.os}/${scenario.code} must be an error`);
      else assert.deepEqual(result, { submitted: false });
    }
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});

test('native：调用取消会终止真实子进程并返回取消结果', async (t) => {
  const originalSpawn = childProcess.spawn;
  let child!: ReturnType<typeof spawn>;
  let started!: () => void;
  const spawned = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(childProcess, 'spawn', ((_command: string, _args: string[], options: object) => {
    child = originalSpawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'], options);
    started();
    return child;
  }) as typeof childProcess.spawn);
  syncBuiltinESMExports();
  try {
    const controller = new AbortController();
    const result = new NativeBackend().show({ message: 'cancel', language: 'zh', timeout: 2000, signal: controller.signal });
    await spawned;
    const closed = once(child, 'close');
    controller.abort();
    assert.deepEqual(await result, { submitted: false });
    await closed;
    assert.equal(child.killed, true);
  } finally {
    child?.kill(); t.mock.restoreAll(); syncBuiltinESMExports();
  }
});

test('ps1 脚本随包存在', () => {
  assert.ok(fs.existsSync(PS1_PATH), `${PS1_PATH} should exist`);
});

/** Windows 下才执行的 powershell 真实链路检查 */
const onWindows = process.platform === 'win32' && psAvailable();
function psAvailable(): boolean {
  try {
    spawn('powershell.exe', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

;(onWindows ? test : test.skip)('Windows：ps1 脚本语法有效（不启动 GUI）', async () => {
  const check = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-Command',
      `$null = [scriptblock]::Create((Get-Content -LiteralPath '${PS1_PATH.replace(/'/g, "''")}' -Raw)); Write-Output 'SYNTAX_OK'`,
    ]);
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', () => resolve({ code: -1, stdout: '' }));
    child.on('exit', (code) => resolve({ code, stdout: out }));
  });
  assert.equal(check.code, 0);
  assert.match(check.stdout, /SYNTAX_OK/);
});

;(onWindows ? test : test.skip)('Windows：stdin→stdout UTF-8+B64 管道无乱码（模拟 ps1 编码链路）', async () => {
  const message = '中文消息内容测试【】✓ 第二行';
  const result = await new Promise<{ stdout: string }>((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-Command',
      '$t = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false))); $s = $t.ReadToEnd(); \'B64:\' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($s))',
    ]);
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stdin.on('error', () => undefined);
    child.stdin.end(message, 'utf8');
    child.on('error', reject);
    child.on('exit', () => resolve({ stdout }));
  });

  assert.match(result.stdout, /^B64:[A-Za-z0-9+/=]+/);
  const decoded = Buffer.from(result.stdout.trim().slice(4), 'base64').toString('utf8');
  assert.equal(decoded, message, 'Chinese text must round-trip through PowerShell without mojibake');
});

;(onWindows ? test : test.skip)('Windows：实际输出处理截断后，路由只返回一个显式截断标记', async () => {
  const source = fs.readFileSync(PS1_PATH, 'utf8');
  const outputBlock = source.slice(source.indexOf('$response = $txtResponse.Text'), source.indexOf('$form.Dispose()'));
  const script = "$txtResponse = [PSCustomObject]@{ Text = ('x' * 1000001) }; $form = [PSCustomObject]@{ Tag = [PSCustomObject]@{ status = 'submitted' } }; " + outputBlock;
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(Buffer.concat(chunks).toString()) : reject(new Error(`PowerShell exited ${code}`)));
  });
  const parsed = parsePowerShellResult(output)!;
  const router = new DialogRouter(async () => ({ isAvailable: async () => true, show: async () => parsed }));
  const result = await router.show({ message: 'm', language: 'zh' });
  assert.equal(result.response, 'x'.repeat(MAX_RESPONSE_CHARS) + RESPONSE_TRUNCATION_MARKER);
});
