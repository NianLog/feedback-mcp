/**
 * Markdown 处理边界测试：XSS 净化、纯文本轻量化的误伤防护。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownSafe, markdownToPlain } from '../src/core/markdown.js';

// ---------- renderMarkdownSafe（XSS 净化） ----------

test('净化：<script> 标签被剥离', () => {
  const html = renderMarkdownSafe('<script>alert(1)</script>hello');
  assert.ok(!html.includes('<script'), `script tag leaked: ${html}`);
  assert.ok(html.includes('hello'));
});

test('净化：img onerror 事件属性被剥离', () => {
  const html = renderMarkdownSafe('<img src="https://x.com/a.png" onerror="alert(1)">');
  assert.ok(!html.includes('onerror'), `onerror leaked: ${html}`);
});

test('净化：javascript: 协议链接被剥离', () => {
  const html = renderMarkdownSafe('[click](javascript:alert(1))');
  assert.ok(!html.includes('javascript:'), `javascript: leaked: ${html}`);
});

test('净化：链接被强制加 rel=noopener noreferrer + target=_blank', () => {
  const html = renderMarkdownSafe('[site](https://example.com)');
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes('target="_blank"'));
});

test('净化：正常 Markdown 元素保留（代码/表格/粗体）', () => {
  const html = renderMarkdownSafe('# Title\n\n**bold** `code`\n\n| a | b |\n| - | - |\n| 1 | 2 |');
  assert.ok(html.includes('<h1'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(html.includes('<table>'));
});

test('净化：代码块中的 HTML 展示为文本不执行', () => {
  const html = renderMarkdownSafe('```\n<img src=x onerror=alert(1)>\n```');
  // 原始 <img 标签必须被转义为文本（&lt;img），不得存活为可执行标签
  assert.ok(!/<img[\s>]/i.test(html), `raw <img tag survived: ${html}`);
});

test('渲染异常回退：输入 marked 无法处理的内容仍返回安全 HTML', () => {
  // 极长未闭合围栏不应抛出
  const html = renderMarkdownSafe('```' + 'x'.repeat(100_000));
  assert.equal(typeof html, 'string');
});

// ---------- markdownToPlain（native 后端轻量化） ----------

test('轻量化：下划线标识符不被吞（file_name_here 保持原样）', () => {
  assert.equal(markdownToPlain('file_name_here'), 'file_name_here');
  assert.equal(markdownToPlain('snake_case_var and another_one'), 'snake_case_var and another_one');
});

test('轻量化：单词边界的 _em_ 斜体被剥离', () => {
  assert.equal(markdownToPlain('this is _emphasized_ text'), 'this is emphasized text');
});

test('轻量化：尖括号比较表达式不被当 HTML 删除', () => {
  assert.equal(markdownToPlain('if x < 3 and y > 2 then ok'), 'if x < 3 and y > 2 then ok');
});

test('轻量化：真 HTML 标签被剥离', () => {
  assert.equal(markdownToPlain('<div>hello</div> <b>world</b>'), 'hello world');
  assert.equal(markdownToPlain('a <br/> b'), 'a  b');
});

test('轻量化：HTML 注释被剥离（含多行）', () => {
  assert.equal(markdownToPlain('a <!-- hidden\ncomment --> b'), 'a  b');
});

test('轻量化：标题/粗体/斜体/删除线被剥离', () => {
  assert.equal(markdownToPlain('## 标题'), '标题');
  assert.equal(markdownToPlain('**bold** and *italic*'), 'bold and italic');
  assert.equal(markdownToPlain('~~gone~~'), 'gone');
});

test('轻量化：链接展开为 text (url)，图片保留 alt', () => {
  assert.equal(markdownToPlain('[site](https://example.com)'), 'site (https://example.com)');
  assert.equal(markdownToPlain('![alt text](https://x.com/i.png)'), 'alt text');
});

test('轻量化：代码块围栏剥离、内容保留', () => {
  const out = markdownToPlain('before\n```ts\nconst a = 1;\nconst b = 2;\n```\nafter');
  assert.ok(out.includes('const a = 1;'));
  assert.ok(out.includes('const b = 2;'));
  assert.ok(!out.includes('```'));
});

test('轻量化：代码块内的 Markdown 标记不被二次处理', () => {
  const out = markdownToPlain('```\n**not bold** _not_em_\n```');
  assert.ok(out.includes('**not bold**'));
});

test('轻量化：列表转 •、有序列表保留数字', () => {
  assert.equal(markdownToPlain('- a\n- b'), '• a\n• b');
  assert.equal(markdownToPlain('top\n  - nested'), 'top\n  • nested');
  assert.equal(markdownToPlain('1. first\n2. second'), '1. first\n2. second');
});

test('轻量化：引用标记剥离', () => {
  assert.equal(markdownToPlain('> quoted text'), 'quoted text');
});

test('轻量化：CRLF 输入正常处理', () => {
  const out = markdownToPlain('# 标题\r\n\r\n**加粗**\r\n');
  assert.ok(out.includes('标题'));
  assert.ok(out.includes('加粗'));
  assert.ok(!out.includes('**'));
});

test('轻量化：空输入与纯空白', () => {
  assert.equal(markdownToPlain(''), '');
  assert.equal(markdownToPlain('   \n\n  '), '');
});

test('轻量化：行中减号不被当列表（"a - b"）', () => {
  assert.equal(markdownToPlain('a - b'), 'a - b');
});
