/**
 * @fileoverview 浏览器探测与启动（browser 后端使用）。
 *
 * 策略：优先以 Chrome/Edge 的 App 模式打开（无地址栏、独立窗口、内存更低），
 * Firefox/Safari 不支持 App 模式走普通窗口；全部失败则回退系统默认浏览器（open 包）。
 *
 * 安全：探测路径全部为硬编码白名单 + spawn 数组参数（不经 shell），无注入面。
 */

import { spawn, exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import open from 'open';

const execAsync = promisify(exec);

/** Windows spawn 成功判定窗口（毫秒） */
const SPAWN_TIMEOUT_MS = 3000;

/** 收集各平台常见浏览器安装路径（优先 Chrome/Edge，其后 Firefox/Safari） */
function commonBrowserPaths(): string[] {
  if (process.platform === 'win32') {
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const localAppData =
      process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');

    return [
      // Chrome
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      // Edge
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      // Firefox
      path.join(programFiles, 'Mozilla Firefox', 'firefox.exe'),
      path.join(programFilesX86, 'Mozilla Firefox', 'firefox.exe'),
      path.join(localAppData, 'Programs', 'Firefox', 'firefox.exe'),
    ];
  }

  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Firefox.app/Contents/MacOS/firefox',
      '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
      // Safari 不支持 app 模式，作为兜底
      '/Applications/Safari.app/Contents/MacOS/Safari',
    ];
  }

  // Linux
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/opt/microsoft/msedge/msedge',
    '/usr/bin/firefox',
    '/usr/bin/firefox-esr',
    '/snap/bin/firefox',
  ];
}

/**
 * 在 PATH 中查找浏览器（where/which 可能返回多行，仅取首个真实存在的路径）。
 */
async function findBrowserInPath(): Promise<string | null> {
  try {
    let stdout: string;
    if (process.platform === 'win32') {
      // 不经用户输入，命令为固定白名单字符串
      ({ stdout } = await execAsync(
        'where chrome 2>nul || where msedge 2>nul || where firefox 2>nul || echo notfound'
      ));
    } else {
      ({ stdout } = await execAsync(
        'which google-chrome 2>/dev/null || which chromium 2>/dev/null || which microsoft-edge 2>/dev/null || which firefox 2>/dev/null || echo notfound'
      ));
    }

    for (const line of stdout.split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate && candidate !== 'notfound' && existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 查找本机可用浏览器完整路径。
 *
 * @returns 浏览器可执行文件路径，找不到返回 null
 */
export async function findBrowserPath(): Promise<string | null> {
  for (const browserPath of commonBrowserPaths()) {
    if (existsSync(browserPath)) {
      console.error(`[feedback-mcp] Found browser at: ${browserPath}`);
      return browserPath;
    }
  }
  return findBrowserInPath();
}

/**
 * 以指定参数启动浏览器进程（detached + stdio ignore，不阻塞、不管道子进程输出）。
 *
 * @returns 是否成功 spawn
 */
function launchProcess(browserPath: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(browserPath, args, { detached: true, stdio: 'ignore' });
    } catch (err) {
      console.error(`[feedback-mcp] Failed to spawn ${browserPath}:`, err);
      resolve(false);
      return;
    }

    const timer = setTimeout(() => resolve(false), SPAWN_TIMEOUT_MS);
    timer.unref?.();

    child.once('error', (err) => {
      clearTimeout(timer);
      console.error(`[feedback-mcp] ${browserPath} launch failed:`, err.message);
      resolve(false);
    });
    child.once('spawn', () => {
      clearTimeout(timer);
      child.unref();
      resolve(true);
    });
  });
}

/**
 * 根据浏览器类型选择启动模式并启动。
 *
 * Chrome/Edge 走 App 模式（无地址栏独立窗口）；Firefox/Safari 走普通窗口。
 *
 * @returns 是否成功启动
 */
async function launchDetectedBrowser(browserPath: string, url: string): Promise<boolean> {
  const lowerPath = browserPath.toLowerCase();
  const isFirefox = lowerPath.includes('firefox');
  const isSafari = lowerPath.includes('safari');

  if (isFirefox || isSafari) {
    console.error(`[feedback-mcp] ${isFirefox ? 'Firefox' : 'Safari'} detected, using regular window mode`);
    const args = isFirefox ? ['--new-window', '--width=900', '--height=700', url] : [url];
    return launchProcess(browserPath, args);
  }

  console.error('[feedback-mcp] Chromium-based browser detected, using app window mode');
  return launchProcess(browserPath, [`--app=${url}`, '--window-size=900,700', '--new-window']);
}

/**
 * 为对话框 URL 打开浏览器窗口。
 *
 * 依次尝试：已知路径浏览器（App/普通模式）→ 系统默认浏览器（open 包）。
 *
 * @param url - 对话框页面 URL
 * @returns 描述实际使用的浏览器（用于日志/测试），失败时 reject
 */
export async function launchBrowserForUrl(url: string): Promise<string> {
  const browserPath = await findBrowserPath();

  if (browserPath && (await launchDetectedBrowser(browserPath, url))) {
    return `browser: ${browserPath}`;
  }

  console.error('[feedback-mcp] Using system default browser as fallback');
  await open(url);
  return 'system default browser';
}
