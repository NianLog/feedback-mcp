/**
 * @fileoverview 浏览器后端使用的 HTML 页面模板与 CSP 安全头。
 *
 * {@link generateHTML} 生成完整的对话框 HTML（石墨极简样式 + 本地 Prism 高亮 + 客户端交互逻辑），
 * 内容由 {@link renderMarkdownSafe} 净化后插入，确保无 XSS。
 */

import { renderMarkdownSafe } from './markdown.js';

/**
 * Content-Security-Policy 响应头。
 *
 * 纵深防御：即便 sanitize 净化层被绕过，connect-src 'self' 也能阻止脚本把数据外泄到外部，
 * object-src/frame-src 'none' 阻止插件与嵌入帧。
 * 说明：script-src/style-src 暂需 'unsafe-inline'，因为当前页面是内联脚本/样式。
 */
export const CSP_HEADER =
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
 * 生成对话框 HTML 页面。
 *
 * @param message - Markdown 原文（将经 renderMarkdownSafe 净化）
 * @param timeout - 超时时间（毫秒）
 * @param language - 界面语言（'zh' | 'en'）
 * @returns 完整 HTML 页面字符串
 */
export function generateHTML(message: string, timeout: number, language: string): string {
  const processedMessage = renderMarkdownSafe(message);

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
        document.getElementById('timer').textContent = '${uiText.timeoutMessage}';
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
      button.textContent = '${uiText.copySuccess}';
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
      submitBtn.textContent = '${uiText.submitting}';
      submitBtn.disabled = true;

      fetch('/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response })
      }).then((res) => {
        if (res.ok) {
          document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-size:24px;color:white;">${uiText.submitSuccess}</div>';
          setTimeout(() => window.close(), 1500);
        } else {
          throw new Error(\`HTTP \${res.status}\`);
        }
      }).catch((error) => {
        console.error('[feedback-mcp] Submit error:', error);
        submitting = false;
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
        showError('${uiText.errorMessage} (' + error.message + ')');
      });
    }

    // 取消（带错误处理 + 防重入）
    function cancel() {
      if (cancelling) return;
      cancelling = true;

      const cancelBtn = document.querySelector('.btn-secondary');
      const originalText = cancelBtn.textContent;

      cancelBtn.textContent = '${uiText.cancelling}';
      cancelBtn.disabled = true;

      fetch('/cancel', { method: 'POST' })
        .then((res) => {
          if (res.ok) {
            document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-size:24px;color:white;">${uiText.cancelMessage}</div>';
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
          showError('${uiText.errorMessage} (' + error.message + ')');
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
