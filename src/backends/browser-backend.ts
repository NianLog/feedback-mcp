/**
 * @fileoverview 浏览器后端：通过临时 HTTP 服务 + 系统浏览器展示富文本对话框。
 *
 * 这是 v1.x 的既有能力（Markdown 渲染、代码高亮、主题切换、超时），
 * v2.0 将其封装为 {@link BrowserBackend} 实现 {@link UIBackend} 接口。
 * 内存开销较高（浏览器进程 ~200-500MB），但支持完整富文本。
 */

import http from 'node:http';
import open from 'open';
import { spawn, exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateHTML, CSP_HEADER } from '../core/html-template.js';
import type { UIBackend, DialogOptions, DialogResult } from '../core/types.js';

const execAsync = promisify(exec);

/** 当前模块所在目录（定位包内 assets/prism） */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 提供本地化的 Prism 静态资源（代码高亮）。
 *
 * 从包内 assets/prism/ 读取文件返回，带路径遍历防护，完全离线、不经任何 CDN。
 *
 * @param reqUrl - 请求 URL（如 /prism/components/prism-javascript.js）
 * @param res - HTTP 响应对象
 */
function servePrismAsset(reqUrl: string, res: http.ServerResponse): void {
  const prismRoot = path.join(__dirname, '..', '..', 'assets', 'prism');
  const relPath = decodeURIComponent(reqUrl.slice('/prism/'.length).split('?')[0]);

  // 路径遍历防护：禁止 .. 与绝对路径
  if (!relPath || relPath.includes('..') || path.isAbsolute(relPath)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  const filePath = path.join(prismRoot, relPath);
  if (!filePath.startsWith(prismRoot) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime =
    ext === '.js' ? 'text/javascript; charset=utf-8' :
    ext === '.css' ? 'text/css; charset=utf-8' :
    'application/octet-stream';

  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
    res.end(data);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Read error');
  }
}

/**
 * 浏览器后端：起临时 HTTP 服务并用系统浏览器打开对话框。
 *
 * 富文本（Markdown + 代码高亮）、跨平台一致、内存较高。
 */
export class BrowserBackend implements UIBackend {
  /** 浏览器后端始终可用（只要本机有浏览器） */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  /** 展示浏览器对话框并等待用户响应 */
  show(options: DialogOptions): Promise<DialogResult> {
    const timeout = options.timeout || 300000; // 默认5分钟
    let server: http.Server | null = null;
    let timeoutId: NodeJS.Timeout | null = null;

    return new Promise((resolve) => {
      let resolved = false;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (server) {
          server.close();
          server = null;
        }
      };

      const resolveOnce = (result: DialogResult) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve(result);
        }
      };

      // 处理消息截断
      let message = options.message;
      if (options.maxTokens) {
        // 粗略估算：1 token ≈ 4 字符
        const maxChars = options.maxTokens * 4;
        if (message.length > maxChars) {
          message = message.slice(0, maxChars) + '\n\n[... 内容已截断 ...]';
        }
      }

      // 创建HTTP服务器（增强错误处理）
      server = http.createServer((req, res) => {
        // 统一 JSON 响应收口：保证每个 res 只写一次，
        // 消除 1MB 限流 destroy、req error、JSON 解析失败之间的重复 writeHead/end 竞态
        let responded = false;
        const safeJson = (status: number, payload: unknown): void => {
          if (responded || res.writableEnded) return;
          responded = true;
          try {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
          } catch (err) {
            console.error('[feedback-mcp] Failed to write response:', err);
          }
        };

        try {
          // 处理提交
          if (req.method === 'POST' && req.url === '/submit') {
            let body = '';

            req.on('error', (err) => {
              console.error('[feedback-mcp] Request error:', err);
              safeJson(400, { error: 'Request error' });
            });

            req.on('data', chunk => {
              body += chunk;

              // 防止过大的请求体
              if (body.length > 1024 * 1024) { // 1MB限制
                req.destroy();
                safeJson(413, { error: 'Request too large' });
                return;
              }
            });

            req.on('end', () => {
              try {
                const { response } = JSON.parse(body);

                // 验证响应内容
                if (typeof response !== 'string') {
                  safeJson(400, { error: 'Invalid response format' });
                  return;
                }

                // 限制响应长度
                if (response.length > 10000) {
                  safeJson(400, { error: 'Response too long' });
                  return;
                }

                safeJson(200, { success: true });
                resolveOnce({ submitted: true, response });
              } catch (error) {
                console.error('[feedback-mcp] Submit JSON parse error:', error);
                safeJson(400, { error: 'Invalid JSON format' });
              }
            });
            return;
          }

          // 处理取消
          if (req.method === 'POST' && req.url === '/cancel') {
            safeJson(200, { success: true });
            resolveOnce({ submitted: false });
            return;
          }

          // 处理超时（客户端倒计时到点触发，区别于取消：带 timedOut 标志）
          if (req.method === 'POST' && req.url === '/timeout') {
            safeJson(200, { success: true });
            resolveOnce({ submitted: false, timedOut: true });
            return;
          }

          // 提供本地化的 Prism 静态资源（代码高亮，离线可用，不经 CDN）
          if (req.url?.startsWith('/prism/')) {
            servePrismAsset(req.url, res);
            return;
          }

          // 处理404
          if (req.url !== '/') {
            safeJson(404, { error: 'Not found' });
            return;
          }

          // 返回HTML页面（含 CSP 与安全头）
          if (!responded && !res.writableEnded) {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Content-Security-Policy': CSP_HEADER,
              'X-Content-Type-Options': 'nosniff',
              'Referrer-Policy': 'no-referrer',
            });
            res.end(generateHTML(message, timeout, options.language));
          }
        } catch (error) {
          console.error('[feedback-mcp] Server error:', error);
          safeJson(500, { error: 'Internal server error' });
        }
      });

      // 监听随机端口
      server.listen(0, 'localhost', async () => {
        const address = server!.address();
        if (!address || typeof address === 'string') {
          resolveOnce({ submitted: false });
          return;
        }

        const port = address.port;
        const url = `http://localhost:${port}`;

        console.error(`[feedback-mcp] Dialog opened at ${url}`);

        // 打开轻量级浏览器窗口（App模式）
        try {
          let browserOpened = false;

          // 首先尝试找到浏览器的完整路径
          const findBrowserPath = async (): Promise<string | null> => {
            const commonPaths = [];

            if (process.platform === 'win32') {
              // Windows常见浏览器路径
              const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
              const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
              const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');

              // Chrome
              commonPaths.push(
                path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
                path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
                path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')
              );

              // Edge
              commonPaths.push(
                path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
                path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
              );

              // Firefox
              commonPaths.push(
                path.join(programFiles, 'Mozilla Firefox', 'firefox.exe'),
                path.join(programFilesX86, 'Mozilla Firefox', 'firefox.exe'),
                path.join(localAppData, 'Programs', 'Firefox', 'firefox.exe')
              );

            } else if (process.platform === 'darwin') {
              // macOS常见浏览器路径
              commonPaths.push(
                // Chrome
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                // Edge
                '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
                // Firefox
                '/Applications/Firefox.app/Contents/MacOS/firefox',
                '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
                // Safari (不支持app模式，但可以作为备用)
                '/Applications/Safari.app/Contents/MacOS/Safari'
              );
            } else {
              // Linux常见浏览器路径
              commonPaths.push(
                // Chrome/Chromium
                '/usr/bin/google-chrome',
                '/usr/bin/google-chrome-stable',
                '/usr/bin/chromium-browser',
                '/usr/bin/chromium',
                '/snap/bin/chromium',
                // Edge
                '/usr/bin/microsoft-edge',
                '/opt/microsoft/msedge/msedge',
                // Firefox
                '/usr/bin/firefox',
                '/usr/bin/firefox-esr',
                '/snap/bin/firefox'
              );
            }

            // 检查哪个路径存在（优先Chrome/Edge，然后Firefox）
            for (const browserPath of commonPaths) {
              if (fs.existsSync(browserPath)) {
                console.error(`[feedback-mcp] Found browser at: ${browserPath}`);
                return browserPath;
              }
            }

            // 尝试在PATH中查找
            try {
              if (process.platform === 'win32') {
                const { stdout } = await execAsync('where chrome 2>nul || where msedge 2>nul || where firefox 2>nul || echo notfound');
                const cmdPath = stdout.trim();
                return cmdPath !== 'notfound' ? cmdPath : null;
              } else {
                const { stdout } = await execAsync('which google-chrome 2>/dev/null || which msedge 2>/dev/null || which firefox 2>/dev/null || echo notfound');
                const cmdPath = stdout.trim();
                return cmdPath !== 'notfound' ? cmdPath : null;
              }
            } catch {
              return null;
            }
          };

          // 尝试启动浏览器App模式
          const launchAppMode = async (browserPath: string, browserName: string): Promise<boolean> => {
            return new Promise((resolve) => {
              const args = [
                `--app=${url}`,
                '--window-size=900,700',
                '--new-window',
                '--always-on-top'
              ];

              console.error(`[feedback-mcp] Launching ${browserName} with args:`, args);

              const child = spawn(browserPath, args, {
                detached: true,
                stdio: 'ignore'
              });

              child.on('error', (err) => {
                console.error(`[feedback-mcp] ${browserName} launch failed:`, err.message);
                resolve(false);
              });

              child.on('spawn', () => {
                console.error(`[feedback-mcp] ${browserName} app mode launched successfully`);
                child.unref();
                resolve(true);
              });

              // 如果进程在2秒内没有spawn，认为失败
              setTimeout(() => {
                resolve(false);
              }, 2000);
            });
          };

          // 启动普通模式（用于不支持app模式的浏览器）
          const launchRegularMode = async (browserPath: string, browserName: string): Promise<boolean> => {
            return new Promise((resolve) => {
              // Safari和Firefox的普通模式参数
              let args = [url];

              if (browserName === 'Firefox') {
                // Firefox特定参数
                args = [
                  '--new-window',
                  '--width=900',
                  '--height=700',
                  url
                ];
              } else if (browserName === 'Safari') {
                // Safari特定参数
                args = [url];
              }

              console.error(`[feedback-mcp] Launching ${browserName} in regular mode with args:`, args);

              const child = spawn(browserPath, args, {
                detached: true,
                stdio: 'ignore'
              });

              child.on('error', (err) => {
                console.error(`[feedback-mcp] ${browserName} regular mode failed:`, err.message);
                resolve(false);
              });

              child.on('spawn', () => {
                console.error(`[feedback-mcp] ${browserName} regular mode launched successfully`);
                child.unref();
                resolve(true);
              });

              // 如果进程在3秒内没有spawn，认为失败
              setTimeout(() => {
                resolve(false);
              }, 3000);
            });
          };

          // 根据浏览器完整路径检测类型并启动（Chrome/Edge 走 app 模式；Firefox/Safari 走普通窗口）
          const launchDetectedBrowser = async (browserPath: string): Promise<boolean> => {
            const lowerPath = browserPath.toLowerCase();
            const isFirefox = lowerPath.includes('firefox');
            const isSafari = lowerPath.includes('safari');

            let browserName = 'Chrome';
            if (lowerPath.includes('edge')) browserName = 'Edge';
            else if (isFirefox) browserName = 'Firefox';
            else if (isSafari) browserName = 'Safari';

            // Firefox 与 Safari 不支持 app 模式，使用普通窗口
            if (isFirefox || isSafari) {
              console.error(`[feedback-mcp] ${browserName} detected, using regular window mode`);
              return launchRegularMode(browserPath, browserName);
            }
            return launchAppMode(browserPath, browserName);
          };

          // 查找浏览器完整路径并启动。
          // 不再使用 "start chrome"：chrome 多数不在 PATH 会静默失败，且 startArgs 字符串拼接经 shell 有注入面。
          const browserPath = await findBrowserPath();
          if (browserPath) {
            browserOpened = await launchDetectedBrowser(browserPath);
            if (!browserOpened) {
              console.error('[feedback-mcp] Browser launch failed, trying default browser');
            }
          } else {
            console.error('[feedback-mcp] No known browser found, trying default browser');
          }

          // 如果App模式失败，使用默认浏览器
          if (!browserOpened) {
            console.error('[feedback-mcp] Using default browser as fallback');
            await open(url);
          }
        } catch (error) {
          console.error('[feedback-mcp] Failed to open browser:', error);
          resolveOnce({ submitted: false });
          return;
        }

        // 设置超时
        timeoutId = setTimeout(() => {
          console.error('[feedback-mcp] Dialog timed out');
          resolveOnce({ submitted: false, timedOut: true });
        }, timeout);
      });

      server.on('error', (error) => {
        console.error('[feedback-mcp] Server error:', error);
        resolveOnce({ submitted: false });
      });
    });
  }
}
