/** 同步 Markdown API 保持兼容，后端通过 Worker 转换不可信长消息。 */
export { renderMarkdownSafe, SANITIZE_OPTIONS } from './markdown-renderer.mjs';
export { markdownToPlain } from './markdown-plain.mjs';
