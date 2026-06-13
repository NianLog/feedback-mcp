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
import { fileURLToPath } from 'node:url';
import sanitizeHtml from 'sanitize-html';

const execAsync = promisify(exec);

/**
 * 当前模块所在目录（ESM 无 __dirname，手动计算）。
 * 用于定位包内本地化静态资源 assets/prism/（代码高亮，离线可用）。
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * HTML 净化白名单配置
 *
 * 用于净化 marked 渲染输出：剥离 <script>、on* 事件属性、javascript: 协议等 XSS 载体；
 * 同时保留 Prism 代码高亮所需的 class 属性（language-xxx / token xxx）。
 */
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'del', 'ins']),
  allowedAttributes: {
    '*': ['class'],
    a: ['href', 'name', 'target', 'rel', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
  },
};

/**
 * Content-Security-Policy 响应头
 *
 * 纵深防御：即便 sanitize 净化层被绕过，connect-src 'self' 也能阻止脚本把数据外泄到外部，
 * object-src/frame-src 'none' 阻止插件与嵌入帧。
 * 说明：script-src/style-src 暂需 'unsafe-inline'，因为当前页面是内联脚本/样式，
 * 待 v2.0 将客户端脚本与样式外置为独立文件后即可收紧为 'self'。
 */
const CSP_HEADER =
  "default-src 'self'; " +
  "script-src 'unsafe-inline' 'self'; " +
  "style-src 'unsafe-inline' 'self'; " +
  "img-src 'self' data: http: https:; " +
  "font-src 'self'; " +
  "connect-src 'self'; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "frame-src 'none'; " +
  "form-action 'self'";

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
    copySuccess: 'Copied',
    inputLabel: 'Your response:',
    inputPlaceholder: 'Please enter your response here...',
    submit: 'Submit',
    cancel: 'Cancel',
    themeToggleDark: 'Dark',
    themeToggleLight: 'Light',
    themeToggleTitle: 'Toggle theme',
    timeoutMessage: 'Timeout — window will close...',
    submitSuccess: 'Submitted — window will close...',
    cancelMessage: 'Cancelled — window will close...',
    shortcutsHint: 'Shortcuts: Ctrl+Enter to submit · Esc to cancel',
    errorMessage: 'Error occurred, please retry',
    retryButton: 'Retry',
    submitting: 'Submitting...',
    cancelling: 'Processing...'
  } : {
    title: '交互式反馈',
    description: '请查看以下信息并提供您的反馈',
    timerPrefix: '剩余时间：',
    copyPlain: '复制为纯文本',
    copyMarkdown: '复制为 Markdown',
    copySuccess: '已复制',
    inputLabel: '您的回复：',
    inputPlaceholder: '请在此输入您的回复...',
    submit: '提交',
    cancel: '取消',
    themeToggleDark: '深色',
    themeToggleLight: '浅色',
    themeToggleTitle: '切换主题',
    timeoutMessage: '已超时——窗口将自动关闭',
    submitSuccess: '已提交——窗口将自动关闭',
    cancelMessage: '已取消——窗口将自动关闭',
    shortcutsHint: '快捷键：Ctrl+Enter 提交 · Esc 取消',
    errorMessage: '发生错误，请重试',
    retryButton: '重试',
    submitting: '提交中...',
    cancelling: '处理中...'
  };

  // 尝试渲染Markdown并净化（防止XSS：剥离脚本、事件属性、危险协议）
  try {
    const rawHtml = marked.parse(message) as string;
    processedMessage = sanitizeHtml(rawHtml, SANITIZE_OPTIONS);
  } catch (error) {
    // 如果渲染失败，使用纯文本并替换换行符（同样经过净化）
    console.error('[feedback-mcp] Markdown rendering failed, using plain text:', error);
    processedMessage = sanitizeHtml(message.replace(/\n/g, '<br>'), SANITIZE_OPTIONS);
  }

  return `<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${uiText.title}</title>

  <!-- Prism.js 代码高亮（本地化，离线可用） -->
  <link rel="stylesheet" href="/prism/prism-tomorrow.min.css">

  <style>
    /* 设计令牌：石墨极简 —— 中性灰阶 + 墨绿强调，纯色无渐变 */
    :root {
      --bg: #f4f5f7;
      --surface: #ffffff;
      --surface-2: #f9fafb;
      --text: #1f232a;
      --text-muted: #6b7280;
      --border: #e5e7eb;
      --border-strong: #d1d5db;
      --accent: #15803d;
      --accent-hover: #16a34a;
      --accent-soft: rgba(21, 128, 61, 0.12);
      --danger: #dc2626;
      --code-bg: #1f232a;
      --radius: 8px;
      --radius-sm: 6px;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      -webkit-font-smoothing: antialiased;
    }

    .container {
      position: relative;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06), 0 1px 3px rgba(0, 0, 0, 0.04);
      max-width: 800px;
      width: 100%;
      overflow: hidden;
    }

    .header {
      background: var(--surface);
      padding: 20px 24px;
      border-bottom: 1px solid var(--border);
    }

    .header h1 {
      font-size: 17px;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: var(--text);
      padding-left: 10px;
      border-left: 3px solid var(--accent);
      line-height: 1.3;
    }

    .header p {
      font-size: 13px;
      color: var(--text-muted);
      margin-top: 6px;
      padding-left: 13px;
    }

    /* 元信息条：倒计时 + 快捷键提示合并为一行，克制不抢戏 */
    .meta-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding: 8px 24px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      font-size: 12px;
    }

    .timer {
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
      font-weight: 500;
    }

    .timer.timeout {
      color: var(--danger);
    }

    .shortcuts-hint {
      color: var(--text-muted);
    }

    .content {
      padding: 20px 24px;
      max-height: 55vh;
      overflow-y: auto;
      background: var(--surface-2);
      color: var(--text);
      font-size: 14px;
      line-height: 1.65;
    }

    .content pre {
      background: var(--code-bg);
      color: #e6e8eb;
      padding: 14px 16px;
      border-radius: var(--radius-sm);
      overflow-x: auto;
      margin: 14px 0;
      font-size: 13px;
    }

    .content pre[class*="language-"] {
      padding: 14px 16px;
      margin: 14px 0;
    }

    .content code {
      background: var(--border);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 0.88em;
    }

    .content pre code {
      background: none;
      padding: 0;
      color: inherit;
    }

    .content blockquote {
      border-left: 3px solid var(--accent);
      padding: 2px 0 2px 14px;
      margin: 14px 0;
      color: var(--text-muted);
    }

    .content a {
      color: var(--accent);
      text-decoration: none;
    }

    .content a:hover {
      text-decoration: underline;
    }

    .copy-buttons {
      display: flex;
      gap: 8px;
      padding: 12px 24px;
      background: var(--surface);
      border-top: 1px solid var(--border);
    }

    .copy-btn {
      padding: 7px 14px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      color: var(--text);
      transition: border-color 0.15s, color 0.15s, background 0.15s;
    }

    .copy-btn:hover {
      border-color: var(--accent);
      color: var(--accent);
    }

    .copy-btn.copied {
      background: var(--accent);
      border-color: var(--accent);
      color: #ffffff;
    }

    .input-section {
      padding: 18px 24px 22px;
      border-top: 1px solid var(--border);
    }

    .input-section label {
      display: block;
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 8px;
      color: var(--text);
    }

    .input-section textarea {
      width: 100%;
      min-height: 110px;
      padding: 10px 12px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-family: inherit;
      font-size: 14px;
      color: var(--text);
      resize: vertical;
      transition: border-color 0.15s, box-shadow 0.15s;
    }

    .input-section textarea:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-soft);
    }

    .button-group {
      display: flex;
      gap: 10px;
      margin-top: 14px;
    }

    .btn {
      flex: 1;
      padding: 10px 20px;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s, opacity 0.15s;
    }

    .btn-primary {
      background: var(--accent);
      color: #ffffff;
    }

    .btn-primary:hover {
      background: var(--accent-hover);
    }

    .btn-secondary {
      background: var(--surface);
      color: var(--text);
      border-color: var(--border);
    }

    .btn-secondary:hover {
      background: var(--surface-2);
      border-color: var(--border-strong);
    }

    .btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .theme-toggle {
      position: absolute;
      top: 14px;
      right: 16px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 5px 12px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-muted);
      transition: border-color 0.15s, color 0.15s;
      z-index: 10;
    }

    .theme-toggle:hover {
      border-color: var(--accent);
      color: var(--accent);
    }

    @media (max-width: 600px) {
      .copy-buttons,
      .button-group {
        flex-direction: column;
      }

      .meta-bar {
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
      }
    }

    /* 暗色主题：中性石墨深灰（非蓝紫），仅覆盖设计令牌即可整体生效 */
    body.dark-theme {
      --bg: #1a1d23;
      --surface: #252932;
      --surface-2: #2a2e37;
      --text: #e6e8eb;
      --text-muted: #9ca3af;
      --border: #3a4150;
      --border-strong: #4b5563;
      --accent: #22c55e;
      --accent-hover: #16a34a;
      --accent-soft: rgba(34, 197, 94, 0.18);
      --code-bg: #14171c;
    }

    body.dark-theme .btn-primary {
      color: #0f1a14;
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- 主题切换按钮（文字标识当前可切换到的主题） -->
    <button class="theme-toggle" onclick="toggleTheme()" title="${uiText.themeToggleTitle}">
      ${uiText.themeToggleDark}
    </button>

    <div class="header">
      <h1>${uiText.title}</h1>
      <p>${uiText.description}</p>
    </div>

    <div class="meta-bar">
      <div id="timer" class="timer"></div>
      <div class="shortcuts-hint">${uiText.shortcutsHint}</div>
    </div>

    <div class="content" id="content">
      ${processedMessage}
    </div>

    <div class="copy-buttons">
      <button class="copy-btn" onclick="copyAsPlainText(event)">${uiText.copyPlain}</button>
      <button class="copy-btn" onclick="copyAsMarkdown(event)">${uiText.copyMarkdown}</button>
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
    // 防重入状态：避免按钮与快捷键重复触发 submit/cancel
    let submitting = false;
    let cancelling = false;

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
          timeoutSubmit();
        }, 2000);
      }
    }

    // 超时上报（区别于取消：服务端记录为 timedOut，便于 AI 区分"超时"与"主动取消"）
    function timeoutSubmit() {
      fetch('/timeout', { method: 'POST' }).finally(() => {
        setTimeout(() => window.close(), 1000);
      });
    }

    updateTimer();

    // 主题切换（按钮文字标识当前可切换到的主题）
    function toggleTheme() {
      const body = document.body;
      const themeToggle = document.querySelector('.theme-toggle');

      if (body.classList.contains('dark-theme')) {
        body.classList.remove('dark-theme');
        themeToggle.textContent = '${uiText.themeToggleDark}';
        localStorage.setItem('feedback-mcp-theme', 'light');
      } else {
        body.classList.add('dark-theme');
        themeToggle.textContent = '${uiText.themeToggleLight}';
        localStorage.setItem('feedback-mcp-theme', 'dark');
      }
    }

    // 恢复主题偏好
    function restoreTheme() {
      const savedTheme = localStorage.getItem('feedback-mcp-theme');
      const themeToggle = document.querySelector('.theme-toggle');

      if (savedTheme === 'dark') {
        document.body.classList.add('dark-theme');
        themeToggle.textContent = '${uiText.themeToggleLight}';
      } else {
        themeToggle.textContent = '${uiText.themeToggleDark}';
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
    function copyAsPlainText(e) {
      const content = document.getElementById('content').innerText;
      navigator.clipboard.writeText(content).then(() => {
        showCopied(e.currentTarget);
      });
    }

    // 复制为Markdown
    function copyAsMarkdown(e) {
      navigator.clipboard.writeText(originalMarkdown).then(() => {
        showCopied(e.currentTarget);
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

    // 提交响应（带重试机制 + 防重入）
    function submitResponse() {
      if (submitting) return;
      submitting = true;

      const response = document.getElementById('response').value;
      const submitBtn = document.querySelector('.btn-primary');
      const originalText = submitBtn.textContent;

      // 显示加载状态
      submitBtn.textContent = uiText.submitting;
      submitBtn.disabled = true;

      fetch('/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response })
      }).then((res) => {
        if (res.ok) {
          document.body.innerHTML = \`<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-size:24px;color:white;">\${uiText.submitSuccess}</div>\`;
          setTimeout(() => window.close(), 1500);
        } else {
          throw new Error(\`HTTP \${res.status}\`);
        }
      }).catch((error) => {
        console.error('[feedback-mcp] Submit error:', error);
        submitting = false;
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
        showError(\`\${uiText.errorMessage} (\${error.message})\`);
      });
    }

    // 取消（带错误处理 + 防重入）
    function cancel() {
      if (cancelling) return;
      cancelling = true;

      const cancelBtn = document.querySelector('.btn-secondary');
      const originalText = cancelBtn.textContent;

      cancelBtn.textContent = uiText.cancelling;
      cancelBtn.disabled = true;

      fetch('/cancel', { method: 'POST' })
        .then((res) => {
          if (res.ok) {
            document.body.innerHTML = \`<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-size:24px;color:white;">\${uiText.cancelMessage}</div>\`;
            setTimeout(() => window.close(), 1500);
          } else {
            throw new Error(\`HTTP \${res.status}\`);
          }
        })
        .catch((error) => {
          console.error('[feedback-mcp] Cancel error:', error);
          cancelling = false;
          cancelBtn.textContent = originalText;
          cancelBtn.disabled = false;
          showError(\`\${uiText.errorMessage} (\${error.message})\`);
        });
    }

    // 显示错误信息
    function showError(message) {
      const errorDiv = document.createElement('div');
      errorDiv.style.cssText = \`
        position: fixed;
        top: 20px;
        right: 20px;
        background: #dc2626;
        color: white;
        padding: 12px 20px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(220, 53, 69, 0.3);
        z-index: 10000;
        max-width: 300px;
        font-size: 14px;
        font-weight: 500;
      \`;
      // 使用 textContent 构建，避免 innerHTML 拼接导致的 XSS
      const msgEl = document.createElement('span');
      msgEl.textContent = message;
      errorDiv.appendChild(msgEl);

      document.body.appendChild(errorDiv);

      // 3秒后自动移除
      setTimeout(() => {
        if (errorDiv.parentNode) {
          errorDiv.parentNode.removeChild(errorDiv);
        }
      }, 3000);
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

  <!-- Prism.js 代码高亮脚本（本地化，按依赖顺序预加载常用语言，离线可用） -->
  <script src="/prism/prism.js"></script>
  <script src="/prism/components/prism-clike.js"></script>
  <script src="/prism/components/prism-markup.js"></script>
  <script src="/prism/components/prism-css.js"></script>
  <script src="/prism/components/prism-javascript.js"></script>
  <script src="/prism/components/prism-typescript.js"></script>
  <script src="/prism/components/prism-jsx.js"></script>
  <script src="/prism/components/prism-tsx.js"></script>
  <script src="/prism/components/prism-python.js"></script>
  <script src="/prism/components/prism-json.js"></script>
  <script src="/prism/components/prism-bash.js"></script>
  <script src="/prism/components/prism-markdown.js"></script>
  <script src="/prism/components/prism-go.js"></script>
  <script src="/prism/components/prism-rust.js"></script>
  <script src="/prism/components/prism-java.js"></script>
  <script src="/prism/components/prism-sql.js"></script>
  <script src="/prism/components/prism-yaml.js"></script>
  <script>if (window.Prism) { Prism.highlightAll(); }</script>
</body>
</html>`;
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
  const prismRoot = path.join(__dirname, '..', 'assets', 'prism');
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
