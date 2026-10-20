import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

/** @type {import('sanitize-html').IOptions} */
export const SANITIZE_OPTIONS = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'del', 'ins']),
  allowedAttributes: {
    '*': ['class'],
    a: ['href', 'name', 'target', 'rel', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    span: ['data-remote-src', 'data-remote-alt', 'data-remote-title', 'data-remote-width', 'data-remote-height'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
    img: (tagName, attributes) => {
      const src = attributes.src || '';
      try {
        const url = new URL(src, 'http://feedback.invalid');
        // 相对路径会跟随两个不同的基址，带主机的地址不能同时匹配。
        const local = url.origin === 'http://feedback.invalid' &&
          new URL(src, 'http://relative.invalid').origin === 'http://relative.invalid' &&
          !/^[a-z][\w+.-]*:/i.test(src.trim());
        if (url.protocol === 'data:' || local) {
          return { tagName, attribs: attributes };
        }
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          return { tagName: 'span', attribs: {
            class: 'remote-image', 'data-remote-src': src,
            'data-remote-alt': attributes.alt || '', 'data-remote-title': attributes.title || '',
            'data-remote-width': attributes.width || '', 'data-remote-height': attributes.height || '',
          }, text: attributes.alt || url.host };
        }
      } catch { /* 无效地址保留替代文字。 */ }
      return { tagName: 'img', attribs: { alt: attributes.alt || '' } };
    },
  },
};

/** @param {string} message */
export function plainTextHTML(message) {
  const escaped = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return '<pre class="plain-fallback">' + escaped + '</pre>';
}

/** @param {string} message */
export function renderMarkdown(message) {
  return sanitizeHtml(marked.parse(message, { async: false }), SANITIZE_OPTIONS);
}

/** @param {string} message */
export function renderMarkdownSafe(message) {
  try { return renderMarkdown(message); }
  catch { return plainTextHTML(message); }
}
