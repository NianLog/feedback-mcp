/**
 * @fileoverview 系统原生对话框后端：调用系统自带 GUI 工具展示轻量对话框。
 *
 * 三平台实现：
 * - **Linux**：`zenity --text-info --editable`（多行可编辑），stdin 喂 message。
 * - **macOS**：`osascript display dialog`（单行），stdin 喂 prompt。
 * - **Windows**：`assets/native/win-feedback.ps1`（WinForms 多行 TextBox + Timer 超时）。
 *
 * 优势：内存 ~10MB（系统对话框进程）、完全离线、安全、不依赖浏览器。
 * 限制：不支持 Markdown 渲染（用 {@link markdownToPlain} 转纯文本）；macOS 仅单行输入。
 *
 * 超时统一由 Node 层 `setTimeout` 兜底（kill 子进程）；PowerShell 另由脚本内 Timer 自超时输出明确状态。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdownToPlain } from '../core/markdown.js';
import type { UIBackend, DialogOptions, DialogResult } from '../core/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 检测命令是否在 PATH 中可用。
 *
 * @param cmd - 命令名（如 zenity / osascript / powershell）
 */
function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const check = process.platform === 'win32'
      ? spawn('where', [cmd], { stdio: 'ignore' })
      : spawn('which', [cmd], { stdio: 'ignore' });
    check.on('error', () => resolve(false));
    check.on('exit', (code) => resolve(code === 0));
  });
}

/** 截断 message（避免超长文本撑爆 native 对话框） */
function truncateForNative(message: string, maxTokens?: number): string {
  if (!maxTokens) return message;
  const maxChars = maxTokens * 4;
  return message.length > maxChars
    ? message.slice(0, maxChars) + '\n\n[... 内容已截断 ...]'
    : message;
}

/**
 * Linux：zenity 多行可编辑文本对话框。
 *
 * - stdin 传入 message 作为初始内容（`--text-info` 从 stdin 读）。
 * - exit 0 = 提交（stdout=输入），1 = 取消，null（被 kill）= 超时。
 */
function showZenity(message: string, timeoutMs: number): Promise<DialogResult> {
  return new Promise((resolve) => {
    const child = spawn('zenity', [
      '--text-info', '--editable',
      '--title=Interactive Feedback',
      '--width=600', '--height=450',
    ], { stdio: ['pipe', 'pipe', 'inherit'] });

    let stdout = '';
    let settled = false;
    const finish = (r: DialogResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stdin.write(message);
    child.stdin.end();
    child.on('error', () => finish({ submitted: false }));

    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish({ submitted: false, timedOut: true }); }, timeoutMs);

    child.on('exit', (code) => {
      if (code === 0) finish({ submitted: true, response: stdout.replace(/\s+$/, '') });
      else if (code === null) finish({ submitted: false, timedOut: true });
      else finish({ submitted: false });
    });
  });
}

/**
 * macOS：osascript display dialog（单行输入）。
 *
 * - prompt 通过 stdin → `do shell script "cat"` 读入，避免 AppleScript 转义难题。
 * - 用户取消 → AppleScript 错误 -128（非零退出）；超时 → Node kill（exit null）。
 */
function showOsascript(message: string, timeoutMs: number): Promise<DialogResult> {
  return new Promise((resolve) => {
    const script = [
      'set promptText to (do shell script "cat")',
      'try',
      '\tset dialogResult to display dialog promptText default answer "" buttons {"Cancel","Submit"} default button "Submit"',
      '\treturn "submitted" & return & (text returned of dialogResult)',
      'on error number -128',
      '\treturn "cancelled"',
      'end try',
    ].join('\n');

    const child = spawn('osascript', ['-e', script], { stdio: ['pipe', 'pipe', 'inherit'] });

    let stdout = '';
    let settled = false;
    const finish = (r: DialogResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stdin.write(message);
    child.stdin.end();
    child.on('error', () => finish({ submitted: false }));

    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish({ submitted: false, timedOut: true }); }, timeoutMs);

    child.on('exit', (code) => {
      const out = stdout.trim();
      if (out.startsWith('submitted')) {
        const response = out.split('\n').slice(1).join('\n').replace(/\s+$/, '');
        finish({ submitted: true, response });
      } else if (code === null) {
        finish({ submitted: false, timedOut: true });
      } else {
        finish({ submitted: false });
      }
    });
  });
}

/**
 * Windows：PowerShell WinForms 对话框（assets/native/win-feedback.ps1）。
 *
 * - ps1 自带 Timer 超时，输出 `submitted\t<response>` / `cancelled` / `timeout` 到 stdout。
 * - Node 解析首行状态；进程异常时回退取消。
 */
function showPowerShell(message: string, timeoutSec: number): Promise<DialogResult> {
  return new Promise((resolve) => {
    const ps1 = path.join(__dirname, '..', '..', 'assets', 'native', 'win-feedback.ps1');
    const child = spawn('powershell.exe', [
      '-ExecutionPolicy', 'Bypass',
      '-NoProfile',
      '-File', ps1,
      '-Message', message,
      '-Timeout', String(timeoutSec),
    ], { stdio: ['ignore', 'pipe', 'inherit'] });

    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('error', () => resolve({ submitted: false }));
    child.on('exit', () => {
      try {
        const result = JSON.parse(stdout.trim());
        if (result.status === 'submitted') {
          resolve({ submitted: true, response: typeof result.response === 'string' ? result.response : '' });
        } else if (result.status === 'timeout') {
          resolve({ submitted: false, timedOut: true });
        } else {
          resolve({ submitted: false });
        }
      } catch {
        resolve({ submitted: false });
      }
    });
  });
}

/**
 * 系统原生对话框后端。
 *
 * 调用平台自带 GUI 工具，内存极低（~10MB）、离线、安全。不支持 Markdown（用纯文本）。
 */
export class NativeBackend implements UIBackend {
  /** 当前平台是否具备 native 对话框工具 */
  async isAvailable(): Promise<boolean> {
    if (process.platform === 'linux') return commandExists('zenity');
    if (process.platform === 'darwin') return commandExists('osascript');
    if (process.platform === 'win32') return commandExists('powershell') || commandExists('powershell.exe');
    return false;
  }

  /** 展示原生对话框并收集用户响应 */
  async show(options: DialogOptions): Promise<DialogResult> {
    const timeoutMs = options.timeout || 300000;
    const timeoutSec = Math.max(5, Math.floor(timeoutMs / 1000));
    const message = truncateForNative(markdownToPlain(options.message), options.maxTokens);

    try {
      if (process.platform === 'linux') return await showZenity(message, timeoutMs);
      if (process.platform === 'darwin') return await showOsascript(message, timeoutMs);
      if (process.platform === 'win32') return await showPowerShell(message, timeoutSec);
    } catch (error) {
      console.error('[feedback-mcp] Native backend error:', error);
    }
    return { submitted: false };
  }
}
