/**
 * @fileoverview 浏览器后端使用的 HTML 页面模板与 CSP 安全头。
 *
 * {@link generateHTML} 生成完整的对话框 HTML（石墨极简样式 + 本地 Prism 高亮 + 客户端交互逻辑），
 * 内容由 {@link renderMarkdownSafe} 净化后插入，确保无 XSS。
 *
 * 安全要点：用户消息原文会以 `JSON.stringify` 形式内嵌到 `<script>`（供"复制为 Markdown"用），
 * 必须经 {@link jsonForInlineScript} 转义 `<`/`>`/U+2028/U+2029，否则消息中出现的
 * `</script>` 字面量会提前终止脚本块，构成 HTML 注入。
 */

import { renderMarkdownSafe } from './markdown.js';
import type { Language, ThemeMode } from './types.js';
import type { RenderedMarkdown } from './markdown-render.js';

/**
 * Content-Security-Policy 响应头。
 *
 * connect-src 'self' 限制脚本网络请求；图片来源由 img-src 单独控制。
 * object-src/frame-src 'none'、frame-ancestors 'none' 阻止插件与嵌入帧。
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
  "frame-ancestors 'none'; " +
  "form-action 'self'";

/**
 * 将值序列化为可安全内嵌 `<script>` 的 JSON 字面量。
 *
 * JSON.stringify 不转义 `/`，`</script>` 会终结脚本块；`<`/`>`/`&` 统一转义为
 * `\uXXXX` 序列，同时处理 U+2028/U+2029（旧引擎里的换行语义）。
 */
export function jsonForInlineScript(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** 界面文案表 */
interface UIText {
  title: string;
  description: string;
  timerPrefix: string;
  copyPlain: string;
  copyMarkdown: string;
  copySuccess: string;
  copyFailed: string;
  responseNotSubmitted: string;
  inputLabel: string;
  inputPlaceholder: string;
  submit: string;
  cancel: string;
  themeToggleDark: string;
  themeToggleLight: string;
  themeToggleTitle: string;
  timeoutMessage: string;
  submitSuccess: string;
  cancelMessage: string;
  shortcutsHint: string;
  errorMessage: string;
  retryButton: string;
  submitting: string;
  cancelling: string;
  manualCloseHint: string;
  finishedTitle: string;
  renderFallback: string;
  highlightSkipped: string;
  remoteImageLoad: string;
  remoteImageLoading: string;
  remoteImageDisclosure: string;
  remoteImageFailed: string;
}

/** 按语言取界面文案（未知语言回退中文） */
function getUIText(language: Language): UIText {
  return language === 'en'
    ? {
        title: 'Interactive Feedback',
        description: 'Please review the following information and provide your feedback',
        timerPrefix: 'Time remaining: ',
        copyPlain: 'Copy as Plain Text',
        copyMarkdown: 'Copy as Markdown',
        copySuccess: 'Copied',
        copyFailed: 'Copy failed. Select the text and copy it manually.',
        responseNotSubmitted: 'The session ended without confirmation of this reply. Your text is kept here; check the existing outcome before closing.',
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
        errorMessage: 'The result could not be confirmed. Keep your text and check the outcome before retrying.',
        retryButton: 'Retry',
        submitting: 'Submitting...',
        cancelling: 'Processing...',
        manualCloseHint: '(close this window manually if it does not close itself)',
        finishedTitle: 'Session ended',
        renderFallback: 'Rich text could not finish within the rendering limits. The complete original text is shown; copying and replying still work.',
        highlightSkipped: 'This code block is shown without highlighting to keep the page responsive. Its complete text is preserved.',
        remoteImageLoad: 'Load image',
        remoteImageLoading: 'Loading image...',
        remoteImageDisclosure: 'Loading sends a request to this website, revealing your network address and visit time.',
        remoteImageFailed: 'The image could not load. Check the network or address before retrying.',
      }
    : {
        title: '交互式反馈',
        description: '请查看以下信息并提供您的反馈',
        timerPrefix: '剩余时间：',
        copyPlain: '复制为纯文本',
        copyMarkdown: '复制为 Markdown',
        copySuccess: '已复制',
        copyFailed: '复制失败，请手动选择内容后复制',
        responseNotSubmitted: '会话已结束，本次回复未获确认。内容已保留，请核对已有结果后关闭窗口。',
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
        errorMessage: '暂时无法确认结果，请保留回复内容，核对后再决定是否重试',
        retryButton: '重试',
        submitting: '提交中...',
        cancelling: '处理中...',
        manualCloseHint: '（若窗口未自动关闭，请手动关闭）',
        finishedTitle: '会话已结束',
        renderFallback: '富文本未能在渲染限制内完成，已显示完整原文，仍可复制和回复。',
        highlightSkipped: '为保持页面响应，这段代码显示原文并跳过高亮，内容已完整保留。',
        remoteImageLoad: '加载这张图片',
        remoteImageLoading: '图片加载中...',
        remoteImageDisclosure: '加载会向该网站发送请求，并暴露你的网络地址和访问时间。',
        remoteImageFailed: '图片加载失败，请核对网络或地址后重试。',
      };
}

/**
 * 生成对话框 HTML 页面。
 *
 * @param message - Markdown 原文（将经 renderMarkdownSafe 净化）
 * @param timeout - 超时时间（毫秒）
 * @param language - 界面语言（未知值回退 zh）
 * @param theme - 主题模式（未知值回退 auto）
 * @param token - 会话令牌（客户端提交/取消时携带，防本机恶意网页跨站伪造请求）
 * @returns 完整 HTML 页面字符串
 */
export function generateHTML(
  message: string,
  timeout: number,
  language: string,
  theme: string,
  token: string,
  rendered?: RenderedMarkdown
): string {
  const processedMessage = rendered?.html ?? renderMarkdownSafe(message);

  // 防御性白名单：本模板是导出 API，不能信任调用方已校验
  const lang: Language = language === 'en' ? 'en' : 'zh';
  const safeTheme: ThemeMode = theme === 'light' || theme === 'dark' ? theme : 'auto';
  const uiText = getUIText(lang);

  return `<!DOCTYPE html>
<html lang="${lang}">
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
      --accent-hover: #166534;
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

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }

    .render-note, .highlight-note {
      margin: 12px 0;
      color: var(--text-muted);
      font-size: 13px;
      line-height: 1.6;
    }

    .render-note { padding: 0 24px; }
    .content .plain-fallback { white-space: pre-wrap; overflow-wrap: anywhere; }
    .remote-image { display: inline-flex; flex-direction: column; gap: 8px; max-width: 100%; margin: 8px 0; }
    .remote-image button { white-space: normal; overflow-wrap: anywhere; }
    .remote-image-hint { color: var(--text-muted); font-size: 13px; line-height: 1.6; }

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

    ${rendered?.fallback ? '<p class="render-note" role="status">' + uiText.renderFallback + '</p>' : ''}
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
      <div id="feedback-status" class="sr-only" role="status" aria-live="polite"></div>
    </div>
  </div>

  <script>
    const originalMarkdown = ${jsonForInlineScript(message)};
    // 会话令牌：提交/取消请求必须携带（防本机其他网页跨站伪造）
    const FEEDBACK_TOKEN = ${jsonForInlineScript(token)};
    // 超时截止时刻（基于绝对时间计算剩余，规避链式 setTimeout 漂移与后台节流误差）
    const deadline = Date.now() + ${Math.max(0, Math.floor(timeout))};
    // 主题模式（服务端注入）：auto 跟随系统 / light / dark
    const themeMode = ${jsonForInlineScript(safeTheme)};
    // 防重入状态：避免按钮与快捷键重复触发 submit/cancel
    let submitting = false;
    let cancelling = false;
    let finished = false;
    let attemptedReply = false;

    // 携带令牌的 POST
    function post(path, options) {
      const opts = options || {};
      opts.method = 'POST';
      opts.headers = Object.assign({ 'X-Feedback-Token': FEEDBACK_TOKEN }, opts.headers || {});
      return fetch(path, opts).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
    }

    // 更新倒计时（每次由 deadline 重算，后台标签页节流也不会失真）
    function updateTimer() {
      if (finished) return;
      const timerEl = document.getElementById('timer');
      const remainingMs = deadline - Date.now();

      if (remainingMs > 0) {
        const totalSec = Math.ceil(remainingMs / 1000);
        const minutes = Math.floor(totalSec / 60);
        const seconds = totalSec % 60;
        timerEl.textContent =
          \`${uiText.timerPrefix}\${minutes}:\${seconds.toString().padStart(2, '0')}\`;
        setTimeout(updateTimer, 1000);
      } else {
        timerEl.textContent = '${uiText.timeoutMessage}';
        timerEl.classList.add('timeout');
        setTimeout(timeoutSubmit, 1500);
      }
    }

    // 尝试自行关闭窗口：Chromium app 窗口/单历史记录标签可自关；
    // Firefox/Safari 普通窗口可能拒绝脚本关闭，此时保留画面由用户手动关闭。
    function tryCloseWindow() {
      try { window.open('', '_self'); } catch (e) { /* ignore */ }
      window.close();
      setTimeout(function () { try { window.close(); } catch (e) { /* ignore */ } }, 300);
    }

    // 超时上报（区别于取消：服务端记录为 timedOut，便于 AI 区分"超时"与"主动取消"）
    function timeoutSubmit() {
      if (finished) return;
      post('/timeout').then(function (state) { finishSession(state.finished ? 'ended' : state.status); }).catch(function () {
        if (!finished) showError('${uiText.errorMessage}');
      });
    }

    updateTimer();

    // 应用主题（统一入口，同步切换按钮文字）
    function applyTheme(isDark) {
      const themeToggle = document.querySelector('.theme-toggle');
      if (isDark) {
        document.body.classList.add('dark-theme');
        themeToggle.textContent = '${uiText.themeToggleLight}';
      } else {
        document.body.classList.remove('dark-theme');
        themeToggle.textContent = '${uiText.themeToggleDark}';
      }
    }

    // 系统是否深色模式
    function resolveAutoDark() {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    // 主题切换（手动覆盖，记忆到 localStorage；仅固定端口时跨会话生效）
    function toggleTheme() {
      const isDark = document.body.classList.contains('dark-theme');
      applyTheme(!isDark);
      try {
        localStorage.setItem('feedback-mcp-theme', !isDark ? 'dark' : 'light');
      } catch (e) { /* 隐私模式等存储不可用 */ }
    }

    // 恢复主题：用户手动偏好(localStorage) > themeMode 配置 > 系统跟随(auto)
    function restoreTheme() {
      let savedTheme = null;
      try { savedTheme = localStorage.getItem('feedback-mcp-theme'); } catch (e) { /* ignore */ }
      if (savedTheme === 'dark') { applyTheme(true); return; }
      if (savedTheme === 'light') { applyTheme(false); return; }
      if (themeMode === 'dark') applyTheme(true);
      else if (themeMode === 'light') applyTheme(false);
      else applyTheme(resolveAutoDark());
    }

    // auto 模式且用户未手动覆盖时，跟随系统主题变化
    if (themeMode === 'auto') {
      try {
        const mql = window.matchMedia('(prefers-color-scheme: dark)');
        if (mql.addEventListener) {
          mql.addEventListener('change', function () {
            let saved = null;
            try { saved = localStorage.getItem('feedback-mcp-theme'); } catch (e) { /* ignore */ }
            if (!saved) applyTheme(resolveAutoDark());
          });
        }
      } catch (e) { /* 忽略老浏览器 */ }
    }

    restoreTheme();

    document.querySelectorAll('#content .remote-image').forEach(function (placeholder) {
      let url;
      try { url = new URL(placeholder.getAttribute('data-remote-src'), window.location.href); }
      catch (error) { return; }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'copy-btn';
      const alt = placeholder.getAttribute('data-remote-alt') || '';
      const label = '${uiText.remoteImageLoad}' + ' (' + url.host + ')' + (alt ? ': ' + alt : '');
      button.textContent = label;
      button.setAttribute('aria-label', label);
      const hint = document.createElement('span');
      hint.className = 'remote-image-hint';
      hint.textContent = '${uiText.remoteImageDisclosure}';
      placeholder.replaceChildren(button, hint);
      button.addEventListener('click', function () {
        if (finished || button.disabled) return;
        button.disabled = true;
        button.textContent = '${uiText.remoteImageLoading}';
        const image = document.createElement('img');
        image.alt = alt;
        image.referrerPolicy = 'no-referrer';
        ['title', 'width', 'height'].forEach(function (name) {
          const value = placeholder.getAttribute('data-remote-' + name);
          if (value) image.setAttribute(name, value);
        });
        image.onload = function () { placeholder.replaceChildren(image); };
        image.onerror = function () {
          button.disabled = false;
          button.textContent = label;
          hint.textContent = '${uiText.remoteImageFailed}';
          hint.setAttribute('role', 'alert');
        };
        image.src = url.href;
      });
    });

    // 服务端取消或超时主动通知页面，不依赖按钮请求或后台倒计时。
    const sessionEvents = typeof EventSource === 'function'
      ? new EventSource('/events?token=' + encodeURIComponent(FEEDBACK_TOKEN)) : null;
    if (sessionEvents) {
      sessionEvents.onmessage = function (event) {
        try {
          const state = JSON.parse(event.data);
          // 提交成功只由本次 POST 的确认决定，其他窗口或过期请求不能代为确认。
          if (state.status === 'submitted') {
            sessionEvents.close();
            if (!submitting) finishSession('ended');
          } else finishSession(state.status);
        } catch (error) { /* 等待下一条合法事件 */ }
      };
      window.addEventListener('pagehide', function () { sessionEvents.close(); });
    }

    function finishSession(status) {
      if (finished) return;
      finished = true;
      if (sessionEvents) sessionEvents.close();
      const input = document.getElementById('response');
      if (status !== 'submitted' && input && input.value && (attemptedReply || !cancelling)) {
        document.querySelectorAll('.btn').forEach(function (button) { button.disabled = true; });
        document.querySelector('.btn-primary').textContent = '${uiText.submit}';
        document.querySelector('.btn-secondary').textContent = '${uiText.cancel}';
        document.getElementById('timer').textContent = '${uiText.finishedTitle}';
        const statusEl = document.getElementById('feedback-status');
        statusEl.classList.remove('sr-only');
        statusEl.textContent = '${uiText.responseNotSubmitted}';
        return;
      }
      const message = status === 'submitted' ? '${uiText.submitSuccess}'
        : status === 'cancelled' ? '${uiText.cancelMessage}'
        : status === 'timeout' ? '${uiText.timeoutMessage}' : '${uiText.finishedTitle}';
      showFinalScreen(message);
      setTimeout(tryCloseWindow, 1500);
    }

    // 复制为纯文本
    async function copyAsPlainText(e) {
      const button = e.currentTarget;
      const content = document.getElementById('content').innerText;
      try {
        await navigator.clipboard.writeText(content);
        showCopied(button);
      } catch (error) { showError('${uiText.copyFailed}'); }
    }

    // 复制为Markdown
    async function copyAsMarkdown(e) {
      const button = e.currentTarget;
      try {
        await navigator.clipboard.writeText(originalMarkdown);
        showCopied(button);
      } catch (error) { showError('${uiText.copyFailed}'); }
    }

    // 显示复制成功状态
    function showCopied(button) {
      const originalText = button.textContent;
      button.textContent = '${uiText.copySuccess}';
      button.classList.add('copied');
      const status = document.getElementById('feedback-status');
      if (status) status.textContent = '${uiText.copySuccess}';
      setTimeout(function () {
        button.textContent = originalText;
        button.classList.remove('copied');
      }, 2000);
    }

    // 提交响应（带错误处理 + 防重入）
    function submitResponse() {
      if (submitting || cancelling || finished) return;
      submitting = true;
      attemptedReply = true;

      const response = document.getElementById('response').value;
      const submitBtn = document.querySelector('.btn-primary');
      const originalText = submitBtn.textContent;

      submitBtn.textContent = '${uiText.submitting}';
      submitBtn.disabled = true;
      document.querySelector('.btn-secondary').disabled = true;

      post('/submit', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: response })
      }).then(function (state) {
        finishSession(state.success ? state.status : 'ended');
      }).catch(function (error) {
        if (finished) return;
        console.error('[feedback-mcp] Submit error:', error);
        submitting = false;
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
        document.querySelector('.btn-secondary').disabled = false;
        showError('${uiText.errorMessage} (' + error.message + ')');
      });
    }

    // 取消（带错误处理 + 防重入）
    function cancel() {
      if (submitting || cancelling || finished) return;
      cancelling = true;
      attemptedReply = false;

      const cancelBtn = document.querySelector('.btn-secondary');
      const originalText = cancelBtn.textContent;

      cancelBtn.textContent = '${uiText.cancelling}';
      cancelBtn.disabled = true;
      document.querySelector('.btn-primary').disabled = true;

      post('/cancel').then(function (state) {
        finishSession(state.finished ? 'ended' : state.status);
      }).catch(function (error) {
        if (finished) return;
        console.error('[feedback-mcp] Cancel error:', error);
        cancelling = false;
        cancelBtn.textContent = originalText;
        cancelBtn.disabled = false;
        document.querySelector('.btn-primary').disabled = false;
        showError('${uiText.errorMessage} (' + error.message + ')');
      });
    }

    // 结束画面（window.close 可能被浏览器拒绝，提示手动关闭）
    function showFinalScreen(message) {
      document.body.innerHTML =
        '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;' +
        'gap:12px;min-height:100vh;font-size:22px;color:#1f232a;background:#f4f5f7;">' +
        '<div role="status" tabindex="-1">' + message + '</div>' +
        '<div style="font-size:13px;color:#6b7280;">${uiText.manualCloseHint}</div></div>';
      document.querySelector('[role="status"]').focus();
    }

    // 显示错误信息
    function showError(message) {
      const errorDiv = document.createElement('div');
      errorDiv.setAttribute('role', 'alert');
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
      setTimeout(function () {
        if (errorDiv.parentNode) {
          errorDiv.parentNode.removeChild(errorDiv);
        }
      }, 3000);
    }

    // 快捷键支持（输入法组词期间的按键不触发，避免中文输入时误取消）
    document.addEventListener('keydown', function (e) {
      if (e.isComposing) return;
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        submitResponse();
      } else if (e.key === 'Escape') {
        cancel();
      }
    });
  </script>

  <!-- Prism.js 代码高亮脚本（本地化，按依赖顺序预加载常用语言，离线可用） -->
  <script src="/prism/prism.js" data-manual></script>
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
  <script>
    if (window.Prism) {
      const blocks = Array.from(document.querySelectorAll('#content pre code'));
      const MAX_HIGHLIGHT_BLOCK_CHARS = 20000;
      let remainingHighlightChars = 50000;
      let blockIndex = 0;
      function highlightNext() {
        if (finished || blockIndex >= blocks.length) return;
        const code = blocks[blockIndex++];
        const size = code.textContent.length;
        let skipped = size > MAX_HIGHLIGHT_BLOCK_CHARS || size > remainingHighlightChars;
        if (!skipped) {
          remainingHighlightChars -= size;
          try { Prism.highlightElement(code); } catch (error) { skipped = true; }
        }
        if (skipped) {
          const note = document.createElement('p');
          note.className = 'highlight-note';
          note.textContent = '${uiText.highlightSkipped}';
          code.parentElement.insertAdjacentElement('beforebegin', note);
        }
        setTimeout(highlightNext, 0);
      }
      highlightNext();
    }
  </script>
</body>
</html>`;
}

/**
 * 生成"会话已结束"收尾页。
 *
 * 用于对话框已在服务端结束（提交/取消/超时/出错）之后才到达的浏览器窗口：
 * 浏览器冷启动慢或脚本方秒速提交时，窗口可能在这时才发起首次加载——
 * 若服务已关停，它会停在"无法访问此网站"错误页且没有任何 JS 能关闭它。
 * 给它返回收尾页即可自行关闭（Chromium），或至少给出明确提示（Firefox/Safari）。
 *
 * @param language - 界面语言（未知值回退 zh）
 * @returns 收尾页 HTML
 */
export function generateFinalHTML(language: string): string {
  const lang: Language = language === 'en' ? 'en' : 'zh';
  const uiText = getUIText(lang);

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <title>${uiText.finishedTitle}</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #f4f5f7;
    }
    .box {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      font-size: 22px;
      color: #1f232a;
    }
    .hint { font-size: 13px; color: #6b7280; }
  </style>
</head>
<body>
  <div class="box">
    <div>${uiText.finishedTitle}</div>
    <div class="hint">${uiText.manualCloseHint}</div>
  </div>
  <script>
    // 尝试自行关闭窗口；被拒绝时上面的提示仍然可见
    function tryCloseWindow() {
      try { window.open('', '_self'); } catch (e) { /* ignore */ }
      window.close();
      setTimeout(function () { try { window.close(); } catch (e) { /* ignore */ } }, 300);
    }
    tryCloseWindow();
  </script>
</body>
</html>`;
}
