/**
 * E2E 冒烟测试：以真实 MCP 客户端方式驱动 dist/index.js。
 *
 * 场景：
 * 1. stdio JSON-RPC 握手 + tools/list + 非法输入校验（不弹窗）；
 * 2. native 后端（Windows 弹出真实 WinForms 对话框，等待自动超时）；
 * 3. browser 后端（真实打开浏览器窗口，随后通过 HTTP 提交响应）。
 *
 * 运行：npm run test:e2e（需要先 npm run build；会短暂弹出真实窗口）
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 服务器入口：dist/index.js（构建产物路径，仓库内固定位置） */
const SERVER_ENTRY = path.resolve(__dirname, '..', 'dist', 'index.js');

/** FEEDBACK_* 配置项（本文件内固定取值） */
interface ServerEnv {
  ui: 'browser' | 'native';
  timeoutSec: number;
}

let failures = 0;

function ok(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}`, detail ?? '');
  }
}

interface McpSession {
  child: ChildProcess;
  request(method: string, params?: unknown): Promise<any>;
  notify(method: string): void;
  stderr: string[];
  close(): Promise<void>;
}

/**
 * 启动 MCP 服务器会话并完成 initialize 握手。
 *
 * FEEDBACK_* 通过父进程环境变量传入（spawn 显式指定字面量命令 'node'，
 * 参数为仓库内固定构建产物路径）。
 */
async function startSession(env: ServerEnv): Promise<McpSession> {
  const savedUi = process.env.FEEDBACK_UI;
  const savedTimeout = process.env.FEEDBACK_TIMEOUT;
  process.env.FEEDBACK_UI = env.ui;
  process.env.FEEDBACK_TIMEOUT = String(env.timeoutSec);

  const child: ChildProcess = spawn('node', [SERVER_ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  process.env.FEEDBACK_UI = savedUi;
  process.env.FEEDBACK_TIMEOUT = savedTimeout;

  const stderr: string[] = [];
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (d: string) => {
    stderr.push(d);
    process.stderr.write(`[server] ${d}`);
  });

  const rl = readline.createInterface({ input: child.stdout! });
  const pending = new Map<number, (value: any) => void>();
  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    } catch {
      /* 忽略非 JSON 行 */
    }
  });

  let id = 0;
  const request = (method: string, params?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const msgId = ++id;
      const timer = setTimeout(() => {
        pending.delete(msgId);
        reject(new Error(`timeout waiting for ${method} (id=${msgId})`));
      }, 30_000);
      pending.set(msgId, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      child.stdin!.write(
        JSON.stringify({ jsonrpc: '2.0', id: msgId, method, params }) + '\n'
      );
    });

  const session: McpSession = {
    child,
    request,
    notify: (method) => child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'),
    stderr,
    close: () =>
      new Promise<void>((resolve) => {
        // 先结束子进程，再关闭 readline；顺序关闭避免 Windows libuv 断言
        child.once('exit', () => {
          rl.close();
          resolve();
        });
        child.kill();
      }),
  };

  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e-smoke', version: '1.0.0' },
  });
  if (!init?.result?.serverInfo?.name) throw new Error(`initialize failed: ${JSON.stringify(init)}`);
  session.notify('notifications/initialized');
  return session;
}

async function main() {
  console.log('\n== 场景 1：握手 + 工具发现 + 输入边界校验 ==');
  {
    const s = await startSession({ ui: 'browser', timeoutSec: 30 });

    const tools = await s.request('tools/list');
    const names = (tools?.result?.tools ?? []).map((t: any) => t.name);
    ok(names.includes('interactive_feedback'), 'tools/list 包含 interactive_feedback', names);

    const empty = await s.request('tools/call', {
      name: 'interactive_feedback',
      arguments: { message: '' },
    });
    ok(empty?.error !== undefined || empty?.result?.isError === true, '空 message 被拒绝（不弹窗）', empty);

    const tooLong = await s.request('tools/call', {
      name: 'interactive_feedback',
      arguments: { message: 'x'.repeat(1_000_001) },
    });
    ok(
      tooLong?.error !== undefined || tooLong?.result?.isError === true,
      '超长 message 被拒绝（不弹窗）',
      tooLong
    );

    await s.close();
  }

  if (process.platform === 'win32') {
    console.log('\n== 场景 2：native 后端（真实 WinForms 对话框，等待自动超时） ==');
    const s = await startSession({ ui: 'native', timeoutSec: 6 });
    const started = Date.now();
    const call = await s.request('tools/call', {
      name: 'interactive_feedback',
      arguments: { message: '## E2E native 冒烟测试\n\n此对话框将在 6 秒后自动超时关闭。`file_name` 中文 ✓' },
    });
    const elapsed = Date.now() - started;
    const structured = call?.result?.structuredContent;
    ok(structured?.timedOut === true, 'native 超时返回 timedOut=true', structured);
    ok(structured?.submitted === false, 'native 超时 submitted=false', structured);
    ok(elapsed >= 5_000 && elapsed <= 20_000, `native 耗时合理（${elapsed}ms）`);
    await s.close();
  } else {
    console.log('\n== 场景 2：非 Windows，跳过 native 后端 ==');
  }

  console.log('\n== 场景 3：browser 后端（真实浏览器窗口 + HTTP 提交） ==');
  {
    const s = await startSession({ ui: 'browser', timeoutSec: 60 });

    // 先发起工具调用（对话框窗口随调用打开）
    const callPromise = s.request('tools/call', {
      name: 'interactive_feedback',
      arguments: { message: '# E2E browser 冒烟\n\n窗口已自动提交，即将关闭。' },
    });

    // 从 stderr 日志中拿对话框 URL（真实浏览器窗口由服务器自行打开）
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('未捕获到 Dialog opened 日志')), 20_000);
      const poll = () => {
        const m = s.stderr.join('').match(/Dialog opened at (http:\/\/127\.0\.0\.1:\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        } else {
          setTimeout(poll, 100);
        }
      };
      poll();
    });

    const page = await fetch(url);
    const html = await page.text();
    ok(page.status === 200 && html.includes('交互式反馈'), '页面正常渲染');
    const token = html.match(/const FEEDBACK_TOKEN = "([^"]+)";/)?.[1] ?? '';
    ok(!!token, '页面包含会话令牌');

    const payload = 'E2E-OK-中文响应\n第二行';
    const submit = await fetch(`${url}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Feedback-Token': token },
      body: JSON.stringify({ response: payload }),
    });
    ok(submit.status === 200, '提交返回 200');

    const call = await callPromise;
    const structured = call?.result?.structuredContent;
    ok(structured?.submitted === true, 'browser 提交 submitted=true', structured);
    ok(
      (call?.result?.content?.[0]?.text ?? '').includes(payload),
      '工具结果包含用户响应原文',
      call?.result?.content?.[0]?.text
    );

    // 给真实浏览器窗口留出加载收尾页并自行关闭的时间（对话框结束后服务延迟关停）
    console.log('  ……等待浏览器窗口加载收尾页并自动关闭');
    await new Promise((r) => setTimeout(r, 4_000));
    const finished = await fetch(url).then(
      (r) => r.text(),
      () => 'closed'
    );
    ok(
      finished === 'closed' || finished.includes('会话已结束'),
      '结束后服务不再提供对话框页（收尾页或已关停）'
    );
    await s.close();
  }

  if (failures === 0) {
    console.log('\nE2E SMOKE: ALL PASS\n');
    process.exitCode = 0;
  } else {
    console.error(`\nE2E SMOKE: ${failures} FAILURES\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\nE2E SMOKE CRASHED:', err);
  process.exit(1);
});
