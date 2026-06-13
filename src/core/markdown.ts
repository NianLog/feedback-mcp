/**
 * @fileoverview Markdown 处理：安全渲染（browser 后端用）与轻量化（native 后端用）。
 *
 * - {@link renderMarkdownSafe}：marked 渲染 + sanitize-html 净化，输出可安全插入页面的 HTML。
 * - {@link markdownToPlain}：剥离 Markdown 语法转可读纯文本，供不支持富文本的 native 后端使用。
 */

import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

/**
 * HTML 净化白名单配置。
 *
 * 净化 marked 渲染输出：剥离 `<script>`、`on*` 事件属性、`javascript:` 协议等 XSS 载体；
 * 同时保留 Prism 代码高亮所需的 class 属性（language-xxx / token xxx）。
 */
export const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
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
 * 安全渲染 Markdown 为净化后的 HTML（browser 后端使用）。
 *
 * marked 解析后立即套用 sanitize-html 白名单净化；渲染失败时回退为转义纯文本（同样净化）。
 *
 * @param message - Markdown 原文
 * @returns 可安全插入 HTML 页面的字符串
 */
export function renderMarkdownSafe(message: string): string {
  try {
    const rawHtml = marked.parse(message) as string;
    return sanitizeHtml(rawHtml, SANITIZE_OPTIONS);
  } catch (error) {
    console.error('[feedback-mcp] Markdown rendering failed, using plain text:', error);
    return sanitizeHtml(message.replace(/\n/g, '<br>'), SANITIZE_OPTIONS);
  }
}

/**
 * 将 Markdown 轻量化为可读纯文本（native 后端使用）。
 *
 * native 对话框不支持 Markdown 渲染，此函数剥离语法标记、保留语义文字：
 * 标题 `#` → 文字；强调 `**`/`*`/`` ` `` → 内容；代码块围栏 → 代码体；
 * 列表 `-`/`1.` → 缩进项；链接 `[t](u)` → `t (u)`；HTML 标签去除。
 *
 * @param md - Markdown 原文
 * @returns 可读纯文本
 */
export function markdownToPlain(md: string): string {
  let text = md;

  // 提取代码块（含语言标识）→ 保留代码体，前后空行
  text = text.replace(/```[a-zA-Z0-9]*\n([\s\S]*?)```/g, (_m, code) => `\n${code}\n`);
  // 行内代码 `x` → x
  text = text.replace(/`([^`]+)`/g, '$1');
  // 图片 ![alt](src) → alt
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  // 链接 [text](url) → text (url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  // 标题 #/##/... → 文字（保留层级感用缩进）
  text = text.replace(/^#{1,6}\s+/gm, '');
  // 粗体 **x** / __x__ → x
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
  // 斜体 *x* / _x_ → x
  text = text.replace(/\*([^*]+)\*/g, '$1').replace(/_([^_]+)_/g, '$1');
  // 删除线 ~~x~~ → x
  text = text.replace(/~~([^~]+)~~/g, '$1');
  // 引用 > x → x
  text = text.replace(/^>\s?/gm, '');
  // 无序列表 - / * / + → •
  text = text.replace(/^\s*[-*+]\s+/gm, '  • ');
  // 有序列表 1. → 保留数字
  text = text.replace(/^(\s*)(\d+)\.\s+/gm, '$1$2. ');
  // 水平分割线 ---/*** → ─────
  text = text.replace(/^\s*([-*]){3,}\s*$/gm, '─────────');
  // 去除 HTML 标签
  text = text.replace(/<[^>]+>/g, '');
  // 压缩连续空行（最多保留一个空行）
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}
