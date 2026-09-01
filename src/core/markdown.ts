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
  allowedSchemesByTag: {
    // data: 图片与 CSP img-src 保持一致，离线小图标友好且无脚本执行面
    img: ['http', 'https', 'data'],
  },
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
 * 边界约束（避免误伤普通文本）：
 * - `_x_` 斜体仅在单词边界处剥离（`file_name_here` 这类下划线标识符保持原样）；
 * - HTML 标签剥离仅针对 `<` 后紧跟字母/斜杠的合法标签形态（`x < 3 and y > 2` 保持原样）。
 *
 * @param md - Markdown 原文
 * @returns 可读纯文本
 */
export function markdownToPlain(md: string): string {
  let text = md;

  // 代码块与行内代码先提取为占位符，处理完其余语法后再回填——
  // 否则代码内容中的 **bold**、_xx_、<tag> 会被后续规则误处理。
  const codeSlots: string[] = [];
  const stashCode = (code: string): string => {
    codeSlots.push(code);
    return `\u0000CODE${codeSlots.length - 1}\u0000`;
  };

  // 先剥 HTML 注释（含多行）
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  // 代码块（含语言标识，兼容 CRLF 与结尾无换行）→ 占位符，前后空行
  text = text.replace(/```[a-zA-Z0-9+-]*(?:\r?\n|$)([\s\S]*?)```/g, (_m, code: string) =>
    `\n${stashCode(code)}\n`
  );
  // 行内代码 `x` → 占位符
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => stashCode(code));
  // 图片 ![alt](src) → alt
  text = text.replace(/!\[([^\]]*)\]\([^)\s]*[^)]*\)/g, '$1');
  // 链接 [text](url) → text (url)
  text = text.replace(/\[([^\]]+)\]\(([^)\s]*[^)]*)\)/g, '$1 ($2)');
  // 标题 #/##/... → 文字
  text = text.replace(/^#{1,6}\s+/gm, '');
  // 粗体 **x** / __x__ → x（__ 仅单词边界，避免误伤下划线标识符）
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  text = text.replace(/(?<![\w\\])__([^_\n]+)__(?!\w)/g, '$1');
  // 斜体 *x* / _x_ → x（_ 仅单词边界：file_name_here 不受影响）
  text = text.replace(/\*([^*\n]+)\*/g, '$1');
  text = text.replace(/(?<![\w\\])_([^_\n]+)_(?!\w)/g, '$1');
  // 删除线 ~~x~~ → x
  text = text.replace(/~~([^~\n]+)~~/g, '$1');
  // 引用 > x → x
  text = text.replace(/^>\s?/gm, '');
  // 无序列表 - / * / + → •（仅行首、后随空白，避免误伤 "a - b"；保留原缩进）
  text = text.replace(/^(\s*)[-*+]\s+/gm, '$1• ');
  // 有序列表 1. → 保留数字
  text = text.replace(/^(\s*)(\d+)\.\s+/gm, '$1$2. ');
  // 水平分割线 ---/*** → ─────（仅整行形态）
  text = text.replace(/^\s*(?:-{3,}|\*{3,})\s*$/gm, '─────────');
  // 去除 HTML 标签（仅 < 后紧跟字母或 </字母 的合法标签形态，避免误删 "x < 3 ... y > 2"）
  text = text.replace(/<\/?[A-Za-z][^>]*>/g, '');
  // 回填代码内容
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_m, i: string) => codeSlots[Number(i)] ?? '');
  // 压缩连续空行（最多保留一个空行）
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}
