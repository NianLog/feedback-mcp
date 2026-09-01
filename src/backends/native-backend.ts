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
 * v2.2 加固要点：
 * - 消息统一经 **stdin** 传递（Windows 命令行 ~32K 字符上限，argv 传长消息会 spawn 失败）；
 * - stdout 按 **Buffer 收集**（字符串拼接在多字节字符跨界 chunk 时产生 U+FFFD）；
 * - 子进程 stdin 挂 error 处理（用户秒关对话框时写管道会 EPIPE，未处理会击穿整个进程）；
 * - Windows 脚本输出走 **B64 信封**（PS5.1 重定向输出用系统代码页，中文 Windows 下
 *   UTF-8 JSON 直接输出会乱码）；
 * - 所有平台均有 Node 侧超时/看门狗兜底，对话框进程挂起不会卡死 MCP 工具调用。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdownToPlain } from '../core/markdown.js';
import type { UIBackend, DialogOptions, DialogResult } from '../core/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 子进程 stdout 累积上限（字节）：防失控输出耗尽内存 */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** PowerShell 脚本看门狗额外宽限（脚本内 Timer 自超时后允许的收尾时间） */
const PS_WATCHDOG_GRACE_MS = 15_000;

/** 平台可用性缓存（where/which 需要 spawn，避免每次探测） */
const availabilityCache = new Map<string, boolean>();

/**
 * 检测命令是否在 PATH 中可用。
 *
 * @param cmd - 命令名（如 zenity / osascript / powershell.exe）
 */
function commandExists(cmd: string): Promise<boolean> {
  const cacheKey = `${process.platform}:${cmd}`;
  const cached = availabilityCache.get(cacheKey);
  if (cached !== undefined) return Promise.resolve(cached);

  return new Promise((resolve) => {
    const check = process.platform === 'win32'
      ? spawn('where', [cmd], { stdio: 'ignore' })
      : spawn('which', [cmd], { stdio: 'ignore' });

    const done = (ok: boolean) => {
      availabilityCache.set(cacheKey, ok);
      resolve(ok);
    };

    check.on('error', () => done(false));
    check.on('exit', (code) => done(code === 0));
  });
}

/**
 * 解析 PowerShell 脚本输出为结果。
 *
 * 支持两种格式：`B64:<base64(UTF-8 JSON)>`（v2.2+，编码无关）与
 * 裸 JSON（旧版脚本兼容）。无法解析返回 null。
 *
 * @param raw - 子进程 stdout 原文
 */
export function parsePowerShellResult(raw: string): DialogResult | null {
  const text = raw.trim();
  if (!text) return null;

  let json: unknown;
  try {
    if (text.startsWith('B64:')) {
      json = JSON.parse(Buffer.from(text.slice(4), 'base64').toString('utf8'));
    } else if (text.startsWith('{')) {
      json = JSON.parse(text);
    } else {
      return null;
    }
  } catch {
    return null;
  }

  const obj = json as { status?: unknown; response?: unknown };
  if (obj.status === 'submitted') {
    return {
      submitted: true,
      response: typeof obj.response === 'string' ? obj.response : '',
    };
  }
  if (obj.status === 'timeout') {
    return { submitted: false, timedOut: true };
  }
  if (obj.status === 'cancelled') {
    return { submitted: false };
  }
  return null;
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

    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (r: DialogResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };

    child.stdout.on('data', (d: Buffer) => {
      outputBytes += d.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        finish({ submitted: false, error: 'zenity output exceeded limit' });
        return;
      }
      chunks.push(d);
    });

    // 用户秒关对话框时 stdin 写入可能 EPIPE，必须吞掉，否则未处理 error 会击穿进程
    child.stdin.on('error', (err) => {
      console.error('[feedback-mcp] zenity stdin error (ignored):', err.message);
    });
    child.stdin.end(message, 'utf8');

    child.on('error', (err) => finish({ submitted: false, error: `zenity failed: ${err.message}` }));

    timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ submitted: false, timedOut: true });
    }, timeoutMs);

    child.on('exit', (code) => {
      const out = Buffer.concat(chunks).toString('utf8');
      if (code === 0) finish({ submitted: true, response: out.replace(/\s+$/, '') });
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
 * - AppleScript 的 `return` 常量是 CR：输出形态为 `submitted\r<response>`，
 *   剥离标记后需同时兼容 CR/LF。
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

    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (r: DialogResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };

    child.stdout.on('data', (d: Buffer) => {
      outputBytes += d.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        finish({ submitted: false, error: 'osascript output exceeded limit' });
        return;
      }
      chunks.push(d);
    });

    child.stdin.on('error', (err) => {
      console.error('[feedback-mcp] osascript stdin error (ignored):', err.message);
    });
    child.stdin.end(message, 'utf8');

    child.on('error', (err) => finish({ submitted: false, error: `osascript failed: ${err.message}` }));

    timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ submitted: false, timedOut: true });
    }, timeoutMs);

    child.on('exit', (code) => {
      const out = Buffer.concat(chunks).toString('utf8');
      if (out.startsWith('submitted')) {
        const response = out
          .slice('submitted'.length)
          .replace(/^[\r\n]+/, '')
          .replace(/\s+$/, '');
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
 * - 消息经 stdin 以 UTF-8 传入（规避命令行长度上限与编码问题）。
 * - ps1 脚本内 Timer 自超时；Node 侧另设看门狗（超时 + 宽限）防脚本挂起卡死工具调用。
 * - 输出为 `B64:<base64(UTF-8 JSON)>`，编码无关地跨代码页传输。
 */
function showPowerShell(message: string, timeoutMs: number, timeoutSec: number): Promise<DialogResult> {
  return new Promise((resolve) => {
    const ps1 = path.join(__dirname, '..', '..', 'assets', 'native', 'win-feedback.ps1');
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-STA',
      '-File', ps1,
      '-Timeout', String(timeoutSec),
    ], { stdio: ['pipe', 'pipe', 'inherit'] });

    const chunks: Buffer[] = [];
    let settled = false;
    let watchdog: NodeJS.Timeout | undefined;

    const finish = (r: DialogResult) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      resolve(r);
    };

    child.stdout.on('data', (d: Buffer) => chunks.push(d));

    child.stdin.on('error', (err) => {
      console.error('[feedback-mcp] powershell stdin error (ignored):', err.message);
    });
    child.stdin.end(message, 'utf8');

    child.on('error', (err) => {
      finish({ submitted: false, error: `powershell failed: ${err.message}` });
    });

    // 看门狗：脚本自带超时 + 宽限期后仍未退出（GUI 环境异常等），强制终止并按超时处理
    watchdog = setTimeout(() => {
      console.error('[feedback-mcp] PowerShell dialog watchdog triggered, killing process');
      try { child.kill(); } catch { /* ignore */ }
      finish({ submitted: false, timedOut: true, error: 'native dialog process hung and was terminated' });
    }, timeoutMs + PS_WATCHDOG_GRACE_MS);

    child.on('exit', () => {
      const out = Buffer.concat(chunks).toString('utf8');
      const result = parsePowerShellResult(out);
      finish(
        result ?? {
          submitted: false,
          error: 'PowerShell dialog produced unreadable output (WinForms may be unavailable)',
        }
      );
    });
  });
}

/**
 * 系统原生对话框后端。
 *
 * 调用平台自带 GUI 工具，内存极低（~10MB）、离线、安全。不支持 Markdown（用纯文本）。
 */
export class NativeBackend implements UIBackend {
  /** 当前平台是否具备 native 对话框工具（结果缓存） */
  async isAvailable(): Promise<boolean> {
    if (process.platform === 'linux') return commandExists('zenity');
    if (process.platform === 'darwin') return commandExists('osascript');
    if (process.platform === 'win32') return commandExists('powershell.exe');
    return false;
  }

  /** 展示原生对话框并收集用户响应 */
  async show(options: DialogOptions): Promise<DialogResult> {
    const timeoutMs = options.timeout || 300000;
    const timeoutSec = Math.max(5, Math.floor(timeoutMs / 1000));
    const message = markdownToPlain(options.message);

    try {
      if (process.platform === 'linux') return await showZenity(message, timeoutMs);
      if (process.platform === 'darwin') return await showOsascript(message, timeoutMs);
      if (process.platform === 'win32') return await showPowerShell(message, timeoutMs, timeoutSec);
      return { submitted: false, error: `native UI is not supported on platform ${process.platform}` };
    } catch (error) {
      console.error('[feedback-mcp] Native backend error:', error);
      return {
        submitted: false,
        error: `native dialog failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
