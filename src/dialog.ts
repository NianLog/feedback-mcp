/**
 * @fileoverview 对话框模块 - 提供基于浏览器的交互式反馈功能
 *
 * 该模块通过创建临时HTTP服务器并在用户浏览器中打开对话框来实现交互式反馈。
 * 支持Markdown渲染、超时控制和文本复制功能。
 */

import http from 'node:http';
import { marked } from 'marked';
import open from 'open';
import { spawn, exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execAsync = promisify(exec);

/**
 * 对话框配置选项
 */
export interface DialogOptions {
  /** 消息内容（支持Markdown格式） */
  message: string;
  /** 超时时间（毫秒），默认300000ms（5分钟） */
  timeout?: number;
  /** 最大输出token数，超出则截断 */
  maxTokens?: number;
  /** 界面语言 ('zh' | 'en') */
  language: string;
}

/**
 * 对话框返回结果
 */
export interface DialogResult {
  /** 用户是否提交了响应（false表示超时或取消） */
  submitted: boolean;
  /** 用户输入的内容 */
  response?: string;
  /** 是否因超时而结束 */
  timedOut?: boolean;
}

/**
 * 生成HTML页面内容
 *
 * @param message - Markdown格式的消息内容
 * @param timeout - 超时时间（毫秒）
 * @param language - 界面语言
 * @returns 完整的HTML页面字符串
 */
function generateHTML(message: string, timeout: number, language: string): string {
  let processedMessage = message;

  // 根据语言选择UI文本
  const uiText = language === 'en' ? {
    title: 'Interactive Feedback',
    description: 'Please review the following information and provide your feedback',
    timerPrefix: 'Time remaining: ',
    copyPlain: 'Copy as Plain Text',
    copyMarkdown: 'Copy as Markdown',
    copySuccess: 'Copied!',
    inputLabel: 'Your response:',
    inputPlaceholder: 'Please enter your response here...',
    submit: 'Submit',
    cancel: 'Cancel',
    themeToggle: '🌙️',
    timeoutMessage: 'Timeout! Window will auto close...',
    submitSuccess: 'Submitted! Window will auto close...',
    cancelMessage: 'Cancelled! Window will auto close...',
    shortcutsHint: '💡 Shortcuts: Ctrl+Enter to submit, Esc to cancel'
  } : {
    title: '🤖 AI 交互式反馈',
    description: '请查看以下信息并提供您的反馈',
    timerPrefix: '⏰ 剩余时间: ',
    copyPlain: '📋 复制为纯文本',
    copyMarkdown: '📝 复制为Markdown',
    copySuccess: '✓ 已复制',
    inputLabel: '您的回复：',
    inputPlaceholder: '请在此输入您的回复...',
    submit: '✅ 提交',
    cancel: '❌ 取消',
    themeToggle: '🌙️',
    timeoutMessage: '⏰ 超时！窗口将自动关闭...',
    submitSuccess: '✅ 已提交，窗口将自动关闭...',
    cancelMessage: '❌ 已取消，窗口将自动关闭...',
    shortcutsHint: '💡 快捷键：Ctrl+Enter 提交，Esc 取消'
  };

  // 尝试渲染Markdown
  try {
    processedMessage = marked.parse(message) as string;
  } catch (error) {
    // 如果渲染失败，使用纯文本并替换换行符
    console.error('[feedback-mcp] Markdown rendering failed, using plain text:', error);
    processedMessage = message.replace(/\n/g, '<br>');
  }

  return `<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${uiText.title}</title>

  <!-- Prism.js 代码高亮 -->
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/plugins/line-numbers/prism-line-numbers.min.css">

  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 800px;
      width: 100%;
      overflow: hidden;
    }

    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 24px;
      text-align: center;
    }

    .header h1 {
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 8px;
    }

    .header p {
      font-size: 14px;
      opacity: 0.9;
    }

    .content {
      padding: 24px;
      max-height: 60vh;
      overflow-y: auto;
      background: #f8f9fa;
    }

    .content pre {
      background: #2d2d2d;
      color: #f8f8f2;
      padding: 16px;
      border-radius: 8px;
      overflow-x: auto;
      margin: 16px 0;
      position: relative;
    }

    .content pre[class*="language-"] {
      padding: 16px;
      margin: 16px 0;
    }

    .content code {
      background: #e9ecef;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'Courier New', monospace;
      font-size: 0.9em;
    }

    .content pre code {
      background: none;
      padding: 0;
      color: inherit;
    }

    .content blockquote {
      border-left: 4px solid #667eea;
      padding-left: 16px;
      margin: 16px 0;
      color: #6c757d;
    }

    .copy-buttons {
      display: flex;
      gap: 12px;
      padding: 16px 24px;
      background: #e9ecef;
      border-top: 1px solid #dee2e6;
    }

    .copy-btn {
      flex: 1;
      padding: 10px 16px;
      background: white;
      border: 2px solid #dee2e6;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.2s;
      color: #495057;
    }

    .copy-btn:hover {
      background: #f8f9fa;
      border-color: #667eea;
      transform: translateY(-2px);
    }

    .copy-btn.copied {
      background: #28a745;
      border-color: #28a745;
      color: white;
    }

    .input-section {
      padding: 24px;
      border-top: 1px solid #dee2e6;
    }

    .input-section label {
      display: block;
      font-weight: 600;
      margin-bottom: 12px;
      color: #495057;
    }

    .input-section textarea {
      width: 100%;
      min-height: 120px;
      padding: 12px;
      border: 2px solid #dee2e6;
      border-radius: 8px;
      font-family: inherit;
      font-size: 14px;
      resize: vertical;
      transition: border-color 0.2s;
    }

    .input-section textarea:focus {
      outline: none;
      border-color: #667eea;
    }

    .button-group {
      display: flex;
      gap: 12px;
      margin-top: 16px;
    }

    .btn {
      flex: 1;
      padding: 12px 24px;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn-primary {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }

    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(102, 126, 234, 0.4);
    }

    .btn-secondary {
      background: #6c757d;
      color: white;
    }

    .btn-secondary:hover {
      background: #5a6268;
      transform: translateY(-2px);
    }

    .timer {
      text-align: center;
      padding: 12px;
      background: #fff3cd;
      color: #856404;
      font-size: 14px;
      font-weight: 500;
    }

    .shortcuts-hint {
      text-align: center;
      padding: 8px 16px;
      background: #e3f2fd;
      color: #1976d2;
      font-size: 13px;
      font-weight: 500;
      border-bottom: 1px solid #dee2e6;
    }

    @media (max-width: 600px) {
      .copy-buttons {
        flex-direction: column;
      }

      .button-group {
        flex-direction: column;
      }
    }

    /* 主题切换按钮 */
    .theme-toggle {
      position: absolute;
      top: 12px;
      right: 12px;
      background: rgba(255, 255, 255, 0.2);
      border: 1px solid rgba(255, 255, 255, 0.3);
      border-radius: 20px;
      padding: 8px 12px;
      cursor: pointer;
      font-size: 14px;
      transition: all 0.2s;
      z-index: 1000;
    }

    .theme-toggle:hover {
      background: rgba(255, 255, 255, 0.3);
      transform: scale(1.1);
    }

    /* 暗色主题 */
    body.dark-theme {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    }

    body.dark-theme .container {
      background: #1e1e2e;
      color: #ffffff;
    }

    body.dark-theme .header {
      background: linear-gradient(135deg, #2d3748 0%, #4a5568 100%);
    }

    body.dark-theme .content {
      background: #2d3748;
      color: #e2e8f0;
    }

    body.dark-theme .copy-buttons {
      background: #374151;
      border-top: 1px solid #4b5563;
    }

    body.dark-theme .copy-btn {
      background: #4b5563;
      color: #e2e8f0;
      border-color: #6b7280;
    }

    body.dark-theme .copy-btn:hover {
      background: #6b7280;
      border-color: #9ca3af;
    }

    body.dark-theme .input-section {
      border-top: 1px solid #4b5563;
    }

    body.dark-theme .input-section label {
      color: #e2e8f0;
    }

    body.dark-theme .input-section textarea {
      background: #374151;
      border-color: #4b5563;
      color: #e2e8f0;
    }

    body.dark-theme .input-section textarea:focus {
      border-color: #667eea;
    }

    body.dark-theme .btn-secondary {
      background: #4b5563;
    }

    body.dark-theme .btn-secondary:hover {
      background: #6b7280;
    }

    body.dark-theme .timer {
      background: #374151;
      color: #fbbf24;
    }

    body.dark-theme .shortcuts-hint {
      background: #1e3a8a;
      color: #93c5fd;
      border-bottom: 1px solid #4b5563;
    }

    body.dark-theme .theme-toggle {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.2);
    }

    body.dark-theme .theme-toggle:hover {
      background: rgba(255, 255, 255, 0.2);
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- 主题切换按钮 -->
    <button class="theme-toggle" onclick="toggleTheme()" title="Toggle Theme">
      ${uiText.themeToggle}
    </button>

    <div class="header">
      <h1>${language === 'en' ? '🤖 AI Interactive Feedback' : '🤖 AI 交互式反馈'}</h1>
      <p>${uiText.description}</p>
    </div>

    <div id="timer" class="timer"></div>

    <div class="shortcuts-hint">
      ${uiText.shortcutsHint}
    </div>

    <div class="content" id="content">
      ${processedMessage}
    </div>

    <div class="copy-buttons">
      <button class="copy-btn" onclick="copyAsPlainText()">${uiText.copyPlain}</button>
      <button class="copy-btn" onclick="copyAsMarkdown()">${uiText.copyMarkdown}</button>
    </div>

    <div class="input-section">
      <label for="response">${uiText.inputLabel}</label>
      <textarea id="response" placeholder="${uiText.inputPlaceholder}"></textarea>

      <div class="button-group">
        <button class="btn btn-primary" onclick="submitResponse()">${uiText.submit}</button>
        <button class="btn btn-secondary" onclick="cancel()">${uiText.cancel}</button>
      </div>
    </div>
  </div>

  <script>
    const originalMarkdown = ${JSON.stringify(message)};
    let timeoutSeconds = ${Math.floor(timeout / 1000)};

    // 更新倒计时
    function updateTimer() {
      const minutes = Math.floor(timeoutSeconds / 60);
      const seconds = timeoutSeconds % 60;
      document.getElementById('timer').textContent =
        \`${uiText.timerPrefix}\${minutes}:\${seconds.toString().padStart(2, '0')}\`;

      if (timeoutSeconds > 0) {
        timeoutSeconds--;
        setTimeout(updateTimer, 1000);
      } else {
        document.getElementById('timer').textContent = uiText.timeoutMessage;
        setTimeout(() => {
          cancel();
        }, 2000);
      }
    }

    updateTimer();

    // 主题切换
    function toggleTheme() {
      const body = document.body;
      const themeToggle = document.querySelector('.theme-toggle');

      if (body.classList.contains('dark-theme')) {
        body.classList.remove('dark-theme');
        themeToggle.textContent = '🌙️';
        // 保存主题偏好
        localStorage.setItem('feedback-mcp-theme', 'light');
      } else {
        body.classList.add('dark-theme');
        themeToggle.textContent = '☀️';
        // 保存主题偏好
        localStorage.setItem('feedback-mcp-theme', 'dark');
      }
    }

    // 恢复主题偏好
    function restoreTheme() {
      const savedTheme = localStorage.getItem('feedback-mcp-theme');
      const themeToggle = document.querySelector('.theme-toggle');

      if (savedTheme === 'dark') {
        document.body.classList.add('dark-theme');
        themeToggle.textContent = '☀️';
      } else {
        themeToggle.textContent = '🌙️';
      }
    }

    // 页面加载时恢复主题和窗口位置
    restoreTheme();
    restoreWindowPosition();

    // 保存窗口位置
    function saveWindowPosition() {
      try {
        localStorage.setItem('feedback-mcp-window-pos', JSON.stringify({
          left: window.screenX,
          top: window.screenY,
          width: window.outerWidth,
          height: window.outerHeight
        }));
      } catch (e) {
        // 忽略存储错误
      }
    }

    // 恢复窗口位置（仅在支持App模式的浏览器中有效）
    function restoreWindowPosition() {
      try {
        const saved = localStorage.getItem('feedback-mcp-window-pos');
        if (saved) {
          const pos = JSON.parse(saved);
          // 对于App模式窗口，尝试移动到保存的位置
          if (window.opener === null && window.top === window) {
            // 检查是否在合理范围内
            const isValidPosition =
              pos.left >= 0 && pos.top >= 0 &&
              pos.left < screen.width && pos.top < screen.height &&
              pos.width > 100 && pos.height > 100;

            if (isValidPosition) {
              window.moveTo(pos.left, pos.top);
            }
          }
        }
      } catch (e) {
        // 忽略恢复错误
      }
    }

    // 监听窗口移动和大小变化
    let saveTimeout;
    function scheduleSave() {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(saveWindowPosition, 500);
    }

    window.addEventListener('move', scheduleSave);
    window.addEventListener('resize', scheduleSave);

    // 页面关闭时保存
    window.addEventListener('beforeunload', saveWindowPosition);

    // 复制为纯文本
    function copyAsPlainText() {
      const content = document.getElementById('content').innerText;
      navigator.clipboard.writeText(content).then(() => {
        showCopied(event.target);
      });
    }

    // 复制为Markdown
    function copyAsMarkdown() {
      navigator.clipboard.writeText(originalMarkdown).then(() => {
        showCopied(event.target);
      });
    }

    // 显示复制成功状态
    function showCopied(button) {
      const originalText = button.textContent;
      button.textContent = uiText.copySuccess;
      button.classList.add('copied');
      setTimeout(() => {
        button.textContent = originalText;
        button.classList.remove('copied');
      }, 2000);
    }

    // 提交响应
    function submitResponse() {
      const response = document.getElementById('response').value;
      fetch('/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response })
      }).then(() => {
        document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-size:24px;color:white;">${uiText.submitSuccess}</div>';
        setTimeout(() => window.close(), 1500);
      });
    }

    // 取消
    function cancel() {
      fetch('/cancel', { method: 'POST' }).then(() => {
        document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-size:24px;color:white;">${uiText.cancelMessage}</div>';
        setTimeout(() => window.close(), 1500);
      });
    }

    // 快捷键支持
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'Enter') {
        submitResponse();
      } else if (e.key === 'Escape') {
        cancel();
      }
    });
  </script>

  <!-- Prism.js 代码高亮脚本 -->
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/plugins/autoloader/prism-autoloader.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/plugins/line-numbers/prism-line-numbers.min.js"></script>
</body>
</html>`;
}

/**
 * 显示交互式对话框并等待用户响应
 *
 * @param options - 对话框配置选项
 * @returns Promise，解析为用户的响应结果
 */
export async function showDialog(options: DialogOptions): Promise<DialogResult> {
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

    // 创建HTTP服务器
    server = http.createServer((req, res) => {
      // 处理提交
      if (req.method === 'POST' && req.url === '/submit') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const { response } = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
            resolveOnce({ submitted: true, response });
          } catch (error) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }

      // 处理取消
      if (req.method === 'POST' && req.url === '/cancel') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        resolveOnce({ submitted: false });
        return;
      }

      // 返回HTML页面
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(generateHTML(message, timeout, options.language));
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
              const path = stdout.trim();
              return path !== 'notfound' ? path : null;
            } else {
              const { stdout } = await execAsync('which google-chrome 2>/dev/null || which msedge 2>/dev/null || which firefox 2>/dev/null || echo notfound');
              const path = stdout.trim();
              return path !== 'notfound' ? path : null;
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

            const process = spawn(browserPath, args, {
              detached: true,
              stdio: 'ignore'
            });

            process.on('error', (err) => {
              console.error(`[feedback-mcp] ${browserName} launch failed:`, err.message);
              resolve(false);
            });

            process.on('spawn', () => {
              console.error(`[feedback-mcp] ${browserName} app mode launched successfully`);
              process.unref();
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

            const process = spawn(browserPath, args, {
              detached: true,
              stdio: 'ignore'
            });

            process.on('error', (err) => {
              console.error(`[feedback-mcp] ${browserName} regular mode failed:`, err.message);
              resolve(false);
            });

            process.on('spawn', () => {
              console.error(`[feedback-mcp] ${browserName} regular mode launched successfully`);
              process.unref();
              resolve(true);
            });

            // 如果进程在3秒内没有spawn，认为失败
            setTimeout(() => {
              resolve(false);
            }, 3000);
          });
        };

        // Windows最佳实践：优先使用start命令
        if (process.platform === 'win32') {
          try {
            console.error('[feedback-mcp] Trying Windows start command...');

            // 构建start命令参数
            const startArgs = [
              'start',
              '""', // 空标题，避免窗口标题问题
              'chrome',
              `--app=${url}`,
              '--window-size=900,700',
              '--new-window',
              '--always-on-top'
            ];

            console.error(`[feedback-mcp] Executing: ${startArgs.join(' ')}`);

            // 使用exec启动start命令
            await execAsync(startArgs.join(' '), {
              timeout: 3000
            });

            browserOpened = true;
            console.error('[feedback-mcp] Windows start command executed successfully');
          } catch (startError) {
            console.error('[feedback-mcp] Windows start command failed:', (startError as Error).message);

            // 如果start命令失败，尝试完整路径
            const browserPath = await findBrowserPath();

            if (browserPath) {
              const isChrome = browserPath.toLowerCase().includes('chrome');
              const isEdge = browserPath.toLowerCase().includes('edge');
              const isFirefox = browserPath.toLowerCase().includes('firefox');

              let browserName = 'Chrome';
              if (isEdge) browserName = 'Edge';
              else if (isFirefox) browserName = 'Firefox';

              // Firefox不支持app模式，需要特殊处理
              if (isFirefox) {
                console.error('[feedback-mcp] Firefox detected, using regular window mode');
                browserOpened = await launchRegularMode(browserPath, browserName);
              } else {
                browserOpened = await launchAppMode(browserPath, browserName);
              }

              if (!browserOpened) {
                console.error('[feedback-mcp] Browser launch failed, trying default browser');
              }
            }
          }
        } else {
          // 非Windows系统，使用原有逻辑
          const browserPath = await findBrowserPath();

          if (browserPath) {
            const isChrome = browserPath.toLowerCase().includes('chrome');
            const isEdge = browserPath.toLowerCase().includes('edge');
            const isFirefox = browserPath.toLowerCase().includes('firefox');
            const isSafari = browserPath.toLowerCase().includes('safari');

            let browserName = 'Chrome';
            if (isEdge) browserName = 'Edge';
            else if (isFirefox) browserName = 'Firefox';
            else if (isSafari) browserName = 'Safari';

            // Safari和Firefox不支持app模式，需要特殊处理
            if (isFirefox || isSafari) {
              console.error(`[feedback-mcp] ${browserName} detected, using regular window mode`);
              browserOpened = await launchRegularMode(browserPath, browserName);
            } else {
              browserOpened = await launchAppMode(browserPath, browserName);
            }

            if (!browserOpened) {
              console.error('[feedback-mcp] App mode failed, trying default browser');
            }
          }
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
