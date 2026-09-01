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
import { parsePowerShellResult } from '../src/backends/native-backend.js';

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
