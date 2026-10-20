/**
 * @fileoverview 浏览器后端：通过临时 HTTP 服务 + 系统浏览器展示富文本对话框。
 *
 * v2.0 将其封装为 {@link BrowserBackend} 实现 {@link UIBackend} 接口。
 * 内存开销较高（浏览器进程 ~200-500MB），但支持完整富文本。
 *
 * v2.2 加固要点：
 * - 仅绑定 127.0.0.1 回环 + Host 头校验（防 DNS rebinding 读取页面/令牌）；
 * - 会话令牌保护 /submit /cancel /timeout（防本机其他网页 no-cors 跨站伪造）；
 * - 请求体按 Buffer 收集（字符串拼接会在多字节字符跨界 chunk 时产生 U+FFFD）；
 * - socket 全量跟踪，结束后统一销毁（server.close 不会关闭 keep-alive 连接）；
 * - Prism 静态资源带路径遍历防护与内存缓存；
 * - 结束后延迟关停：页面尚未加载过的（浏览器冷启动慢/脚本方秒速提交）等首次加载，
 *   改送"会话已结束"收尾页让晚到窗口自行关闭，避免停在连接拒绝错误页。
 */

import http from 'node:http';
import type { Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateHTML, generateFinalHTML, CSP_HEADER } from '../core/html-template.js';
import type { DialogOptions, DialogResult, UIBackend } from '../core/types.js';
import { launchBrowserForUrl } from './browser-launch.js';
import { renderMarkdownInWorker, type RenderedMarkdown } from '../core/markdown-render.js';

/** 当前模块所在目录（定位包内 assets/prism） */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Prism 资源根目录 */
const PRISM_ROOT = path.resolve(__dirname, '..', '..', 'assets', 'prism');

/** 请求体上限（字节） */
const MAX_BODY_BYTES = 1024 * 1024;

/** Node setTimeout 参数上限（2^31-1ms，超出会立即触发） */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** 结束后给响应留出的冲刷时间，随后强制销毁残余 socket */
const SOCKET_DRAIN_MS = 500;

/** Prism 资源内存缓存条目上限（文件小且有限，超出则清空重建） */
const PRISM_CACHE_MAX = 64;

/** 对话框结束后、页面已加载过时的默认延迟关停时长（等在途请求/响应收尾） */
const POST_RESOLVE_TEARDOWN_MS = 2000;

/**
 * 对话框结束后、页面从未加载过时的最长等待（浏览器冷启动可能很慢）。
 *
 * 覆盖"脚本方秒速提交/超时，浏览器窗口数秒后才发起首次加载"的场景：
 * 等到首次加载时改送收尾页让窗口自行关闭，而不是停在连接被拒错误页。
 */
const POST_RESOLVE_MAX_WAIT_MS = 30_000;

/** Prism 文件缓存 */
const prismCache = new Map<string, Buffer>();

/** 扩展名 → Content-Type */
function prismMime(ext: string): string {
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

/** 目标路径是否位于 root 目录内（防路径遍历） */
function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * 提供本地化的 Prism 静态资源（代码高亮）。
 *
 * 从包内 assets/prism/ 读取文件返回，带路径遍历防护，完全离线、不经任何 CDN。
 *
 * @param reqUrl - 请求 URL（如 /prism/components/prism-javascript.js）
 * @param res - HTTP 响应对象
 */
function servePrismAsset(reqUrl: string, res: http.ServerResponse): void {
  const prefixed = reqUrl.slice('/prism/'.length).split('?')[0];

  let relPath: string;
  try {
    relPath = decodeURIComponent(prefixed);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request');
    return;
  }

  // 路径遍历防护：禁止 ..、绝对路径与 NUL
  if (!relPath || relPath.includes('..') || path.isAbsolute(relPath) || relPath.includes('\0')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  const filePath = path.resolve(PRISM_ROOT, relPath);
  if (!isWithin(PRISM_ROOT, filePath)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  try {
    let data = prismCache.get(filePath);
    if (!data) {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      data = fs.readFileSync(filePath);
      if (prismCache.size >= PRISM_CACHE_MAX) prismCache.clear();
      prismCache.set(filePath, data);
    }

    res.writeHead(200, {
      'Content-Type': prismMime(path.extname(filePath).toLowerCase()),
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(data);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } else {
      console.error('[feedback-mcp] Prism asset read error:', err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Read error');
    }
  }
}

/** BrowserBackend 构造选项（测试注入点） */
export interface BrowserBackendOptions {
  /** 自定义浏览器启动器（默认 launchBrowserForUrl） */
  launcher?: (url: string, signal?: AbortSignal) => Promise<string>;
  /** 服务器就绪回调（集成测试用来获取 URL） */
  onServerReady?: (url: string) => void;
  /** 对话框结束后的延迟关停毫秒数（默认 2000；测试可注入更小值加速收尾） */
  postResolveTeardownMs?: number;
}

/**
 * 浏览器后端：起临时 HTTP 服务并用系统浏览器打开对话框。
 *
 * 富文本（Markdown + 代码高亮）、跨平台一致、内存较高。
 */
export class BrowserBackend implements UIBackend {
  private readonly portClosures = new Map<number, Promise<void>>();
  private readonly launcher: (url: string, signal?: AbortSignal) => Promise<string>;
  private readonly onServerReady?: (url: string) => void;
  private readonly postResolveTeardownMs: number;

  constructor(options: BrowserBackendOptions = {}) {
    this.launcher = options.launcher ?? launchBrowserForUrl;
    this.onServerReady = options.onServerReady;
    this.postResolveTeardownMs = Math.max(0, options.postResolveTeardownMs ?? POST_RESOLVE_TEARDOWN_MS);
  }

  /** 浏览器后端始终可用（只要本机有浏览器，启动失败会在 show 结果中报错） */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  /** 展示浏览器对话框并等待用户响应 */
  show(options: DialogOptions): Promise<DialogResult> {
    if (options.signal?.aborted) return Promise.resolve({ submitted: false });
    if (!options.port) return this.showOne(options);
    const port = options.port;
    const previous = this.portClosures.get(port);
    let release!: () => void;
    const closed = new Promise<void>((resolve) => { release = resolve; });
    this.portClosures.set(port, closed);
    const releasePort = () => {
      release();
      if (this.portClosures.get(port) === closed) this.portClosures.delete(port);
    };
    const run = () => this.showOne(options, releasePort);
    return previous ? previous.then(run) : run();
  }

  private showOne(options: DialogOptions, releasePort: () => void = () => {}): Promise<DialogResult> {
    if (options.signal?.aborted) {
      releasePort();
      return Promise.resolve({ submitted: false });
    }
    // 钳制到 Node 定时器上限，防止溢出导致定时器立即触发
    const timeout = Math.min(options.timeout || 300000, MAX_TIMER_MS);
    // 会话令牌：页面脚本持有，POST 端点必须匹配（跨站网页无法读取）
    const token = randomBytes(24).toString('base64url');

    return new Promise<DialogResult>((resolve) => {
      let server: http.Server | null = null;
      let timeoutId: NodeJS.Timeout | null = null;
      let teardownTimer: NodeJS.Timeout | null = null;
      let finalStatus: 'submitted' | 'cancelled' | 'timeout' | 'error' | undefined;
      let deadline = 0;
      let pageSeen = false;
      const sockets = new Set<Socket>();
      const eventStreams = new Set<http.ServerResponse>();
      const renderLifetime = new AbortController();
      let rendering: Promise<RenderedMarkdown> | undefined;
      let allowedHosts: string[] = [];

      // 终局关停：停止接收新连接，短暂冲刷在途响应后强制销毁残余 socket
      const teardown = () => {
        teardownTimer = null;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (!server) return;
        const closingServer = server;
        server = null;
        try {
          closingServer.close(() => releasePort());
        } catch {
          releasePort();
        }
        // server.close() 不中断 keep-alive 连接；先关空闲，短暂冲刷后强制销毁残余
        closingServer.closeIdleConnections?.();
        const hardKill = setTimeout(() => {
          for (const s of sockets) s.destroy();
          closingServer.closeAllConnections?.();
        }, SOCKET_DRAIN_MS);
        hardKill.unref?.();
      };

      // 结束后的关停调度：页面已加载过的窗口持有自己的收尾逻辑（JS 自关），
      // 稍等在途请求冲刷即可；页面从未加载过的（浏览器冷启动慢/脚本方秒速提交）
      // 则继续等首次加载，届时改送收尾页让晚到的窗口自行关闭，
      // 而不是对着"无法访问此网站"错误页永久卡死。
      const scheduleTeardown = (delayMs: number) => {
        if (teardownTimer) clearTimeout(teardownTimer);
        teardownTimer = setTimeout(teardown, delayMs);
        teardownTimer.unref?.();
      };

      const resolveOnce = (result: DialogResult, teardownMs?: number) => {
        if (finalStatus) return;
        finalStatus = result.error ? 'error' : result.submitted ? 'submitted' : result.timedOut ? 'timeout' : 'cancelled';
        renderLifetime.abort();
        options.signal?.removeEventListener('abort', onAbort);
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        scheduleTeardown(teardownMs ?? (pageSeen ? this.postResolveTeardownMs : POST_RESOLVE_MAX_WAIT_MS));
        for (const stream of eventStreams) {
          stream.end(`data: ${JSON.stringify({ finished: true, status: finalStatus })}\n\n`);
        }
        eventStreams.clear();
        // 结果完成后队列会前进，先等渲染线程退出。
        if (rendering) void rendering.then(() => resolve(result));
        else resolve(result);
      };
      const onAbort = () => resolveOnce({ submitted: false });

      server = http.createServer((req, res) => {
        // 固定端口会用于下一会话，旧连接不能留在客户端连接池中复用。
        res.setHeader('Connection', 'close');
        // 客户端断开等流错误不应演化为未处理异常
        res.on('error', (err) => {
          console.error('[feedback-mcp] Response error:', err.message);
        });

        // 统一 JSON 响应收口：保证每个 res 只写一次
        let responded = false;
        const safeJson = (status: number, payload: unknown): void => {
          if (responded || res.writableEnded || res.destroyed) return;
          responded = true;
          try {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
          } catch (err) {
            console.error('[feedback-mcp] Failed to write response:', err);
          }
        };

        try {
          // Host 头校验：只接受本回环地址形式，阻断 DNS rebinding（rebind 域名解析到
          // 127.0.0.1 后其页面会被同源策略放行读取页面与令牌）
          const host = (req.headers.host || '').toLowerCase();
          if (!allowedHosts.includes(host)) {
            safeJson(403, { error: 'Forbidden host' });
            return;
          }

          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const pathname = url.pathname;

          if (req.method === 'GET' && pathname === '/events') {
            if (!tokenMatches(req, token)) {
              safeJson(403, { error: 'Invalid token' });
              return;
            }
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
            if (finalStatus) {
              res.end(`data: ${JSON.stringify({ finished: true, status: finalStatus })}\n\n`);
            } else {
              res.write(': connected\n\n');
              eventStreams.add(res);
              res.once('close', () => eventStreams.delete(res));
            }
            return;
          }

          // 提交（令牌校验 + Buffer 收集体）
          if (req.method === 'POST' && pathname === '/submit') {
            if (!tokenMatches(req, token)) {
              safeJson(403, { error: 'Invalid token' });
              return;
            }

            if (finalStatus) {
              // 会话已结束后到达的请求（晚到窗口/重复提交）：如实告知已结束，页面据此收尾
              safeJson(200, { finished: true, status: finalStatus });
              return;
            }

            const chunks: Buffer[] = [];
            let size = 0;
            let aborted = false;

            req.on('error', (err) => {
              console.error('[feedback-mcp] Request error:', err);
              safeJson(400, { error: 'Request error' });
            });

            req.on('data', (chunk: Buffer) => {
              if (aborted) return;
              size += chunk.length;
              if (size > MAX_BODY_BYTES) {
                aborted = true;
                req.destroy();
                safeJson(413, { error: 'Request too large' });
                return;
              }
              chunks.push(chunk);
            });

            req.on('end', () => {
              if (aborted) return;
              if (finalStatus) {
                safeJson(200, { finished: true, status: finalStatus });
                return;
              }
              try {
                const body = Buffer.concat(chunks).toString('utf8');
                const parsed = JSON.parse(body) as { response?: unknown };

                if (typeof parsed.response !== 'string') {
                  safeJson(400, { error: 'Invalid response format' });
                  return;
                }

                resolveOnce({ submitted: true, response: parsed.response });
                safeJson(200, { success: true, status: finalStatus });
              } catch {
                console.error('[feedback-mcp] Invalid submit JSON');
                safeJson(400, { error: 'Invalid JSON format' });
              }
            });
            return;
          }

          // 取消（令牌校验）
          if (req.method === 'POST' && pathname === '/cancel') {
            if (!tokenMatches(req, token)) {
              safeJson(403, { error: 'Invalid token' });
              return;
            }
            if (finalStatus) {
              safeJson(200, { finished: true, status: finalStatus });
              return;
            }
            resolveOnce({ submitted: false });
            safeJson(200, { success: true, status: finalStatus });
            return;
          }

          // 超时上报（客户端倒计时到点触发，区别于取消：带 timedOut 标志）
          if (req.method === 'POST' && pathname === '/timeout') {
            if (!tokenMatches(req, token)) {
              safeJson(403, { error: 'Invalid token' });
              return;
            }
            if (finalStatus) {
              safeJson(200, { finished: true, status: finalStatus });
              return;
            }
            resolveOnce({ submitted: false, timedOut: true });
            safeJson(200, { success: true, status: finalStatus });
            return;
          }

          // 本地化的 Prism 静态资源（代码高亮，离线可用，不经 CDN）
          if (pathname.startsWith('/prism/')) {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              safeJson(405, { error: 'Method not allowed' });
              return;
            }
            servePrismAsset(pathname, res);
            return;
          }

          // 对话框页面（会话已结束则改送收尾页，让晚到的窗口自行关闭）
          if (pathname === '/') {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              safeJson(405, { error: 'Method not allowed' });
              return;
            }
            if (responded || res.writableEnded || res.destroyed) return;
            responded = true;
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Content-Security-Policy': CSP_HEADER,
              'X-Content-Type-Options': 'nosniff',
              'X-Frame-Options': 'DENY',
              'Referrer-Policy': 'no-referrer',
              'Cache-Control': 'no-store',
            });
            if (req.method === 'HEAD') { res.end(); return; }

            pageSeen = true;
            if (finalStatus) {
              scheduleTeardown(this.postResolveTeardownMs);
              res.end(generateFinalHTML(options.language));
              return;
            }
            void (rendering ??= renderMarkdownInWorker(options.message, renderLifetime.signal)).then((rendered) => {
              if (res.writableEnded || res.destroyed) return;
              if (finalStatus) { res.end(generateFinalHTML(options.language)); return; }
              res.end(generateHTML(
                options.message,
                Math.max(0, deadline - Date.now()),
                options.language,
                options.theme ?? 'auto',
                token,
                rendered
              ));
            }).catch(() => {
              resolveOnce({ submitted: false, error: 'Failed to prepare dialog page' });
              if (!res.writableEnded && !res.destroyed) res.end(generateFinalHTML(options.language));
            });
            return;
          }

          safeJson(404, { error: 'Not found' });
        } catch (error) {
          console.error('[feedback-mcp] Server error:', error);
          safeJson(500, { error: 'Internal server error' });
        }
      });

      // 跟踪所有连接，保证结束后可彻底释放（防句柄/端口泄漏累积）
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });

      // 请求处理节奏约束：慢速/挂起请求不应长期占用资源
      server.headersTimeout = 10_000;
      server.requestTimeout = 60_000;
      server.keepAliveTimeout = 5_000;

      server.on('error', (error) => {
        console.error('[feedback-mcp] HTTP server error:', error);
        resolveOnce({ submitted: false, error: `HTTP server error: ${error.message}` });
      });

      options.signal?.addEventListener('abort', onAbort, { once: true });

      // 监听回环地址（显式 127.0.0.1，避免 localhost 解析差异与外部暴露）
      server.listen(options.port ?? 0, '127.0.0.1', async () => {
        const address = server?.address();
        if (!address || typeof address === 'string') {
          resolveOnce({ submitted: false, error: 'Failed to bind local server' });
          return;
        }

        const port = address.port;
        allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
        const url = `http://127.0.0.1:${port}`;

        deadline = Date.now() + timeout;
        timeoutId = setTimeout(() => {
          console.error('[feedback-mcp] Dialog timed out');
          resolveOnce({ submitted: false, timedOut: true });
        }, timeout);

        console.error(`[feedback-mcp] Dialog opened at ${url}`);
        this.onServerReady?.(url);
        if (finalStatus) return;

        // 打开浏览器窗口；启动失败必须显式报错，不能伪装成"用户取消"
        try {
          const how = await this.launcher(url, options.signal);
          console.error(`[feedback-mcp] Dialog window opened via ${how}`);
        } catch (error) {
          console.error('[feedback-mcp] Failed to open browser:', error);
          // 启动失败意味着不会有窗口到来，无需为晚到的页面长期保留服务
          resolveOnce({
            submitted: false,
            error: `Failed to open dialog window: ${error instanceof Error ? error.message : String(error)}`,
          }, 1000);
          return;
        }

      });
    }).catch((error) => { releasePort(); throw error; });
  }
}

/** 校验请求令牌（Header 优先，兼容查询参数） */
function tokenMatches(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers['x-feedback-token'];
  const headerToken = Array.isArray(header) ? header[0] : header;
  if (headerToken) return headerToken === token;
  try {
    const tokenParam = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('token');
    return tokenParam === token;
  } catch {
    return false;
  }
}
