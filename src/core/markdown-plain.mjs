/**
 * @fileoverview native 后端纯文本转换，主线程同步 API 与 ESM Worker 共用。
 */

import sanitizeHtml from 'sanitize-html';

const HTML_TAGS = new Set(sanitizeHtml.defaults.allowedTags.concat(['img', 'del', 'ins', 'script', 'style', 'html', 'head', 'body']));
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

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
 * @param {string} md - Markdown 原文
 * @returns {string} 可读纯文本
 */
export function markdownToPlain(md) {
  let text = md;

  // 代码块与行内代码先提取为占位符，处理完其余语法后再回填——
  // 否则代码内容中的 **bold**、_xx_、<tag> 会被后续规则误处理。
  /** @type {string[]} */
  const codeSlots = [];
  /** @param {string} code */
  const stashCode = (code) => {
    codeSlots.push(code);
    return `\u0000CODE${codeSlots.length - 1}\u0000`;
  };

  // 代码块（含语言标识，兼容 CRLF 与结尾无换行）→ 占位符，前后空行
  text = text.replace(/```[a-zA-Z0-9+-]*(?:\r?\n|$)([\s\S]*?)```/g, (_m, code) =>
    `\n${stashCode(code)}\n`
  );
  // 行内代码 `x` → 占位符
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => stashCode(code));
  // 代码内容已保护，只删除正文中的 HTML 注释。
  text = text.replace(/<!--[\s\S]*?-->/g, '');
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
  // 成对标签与空元素才按 HTML 处理，保留 x<a、vector<B> 等未成对文本。
  const closingTags = new Set([...text.matchAll(/<\/([A-Za-z][\w:-]*)\s*>/g)].map(match => match[1].toLowerCase()));
  text = text.replace(/<\/?([A-Za-z][\w:-]*)\b[^>]*>/g, (tag, name) => {
    const lower = name.toLowerCase();
    return HTML_TAGS.has(lower) && (closingTags.has(lower) || VOID_TAGS.has(lower) || tag.endsWith('/>')) ? '' : tag;
  });
  // 回填代码内容
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_m, i) => codeSlots[Number(i)] ?? '');
  // 压缩连续空行（最多保留一个空行）
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}
