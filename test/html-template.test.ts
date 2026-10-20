/**
 * HTML 模板安全测试：script 块注入逃逸、防御性白名单、令牌注入。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { generateHTML, generateFinalHTML, jsonForInlineScript, CSP_HEADER } from '../src/core/html-template.js';

const BASE = { timeout: 300_000 } as const;

test('CVE-2024-53382：离线 Prism 不把 DOM 覆盖的图片当作当前脚本', () => {
  const source = readFileSync(new URL('../assets/prism/prism.js', import.meta.url), 'utf8');
  for (const tagName of ['IMG', 'SCRIPT']) {
    const script = { tagName, src: tagName === 'IMG' ? 'https://untrusted.example/prism.js' : '/prism/prism.js', hasAttribute: () => false };
    const context: any = { document: { currentScript: script, querySelector: () => null, getElementsByTagName: () => [] },
      Element: class { matches() { return false; } }, Prism: { manual: true } };
    context.window = context;
    vm.runInNewContext(source, context, { timeout: 1000 });
    if (tagName === 'IMG') {
      assert.equal(context.Prism.util.currentScript(), null);
      assert.notEqual(context.Prism.filename, script.src);
    } else {
      assert.equal(context.Prism.util.currentScript(), script);
      assert.equal(context.Prism.filename, script.src);
    }
  }
});

test('jsonForInlineScript：`</script>` 被转义为 \\u003c 序列', () => {
  const encoded = jsonForInlineScript('</script><script>alert(1)</script>');
  assert.ok(!encoded.includes('</script>'), 'raw </script> must not survive');
  assert.ok(encoded.includes('\\u003c/script\\u003e'));
});

test('jsonForInlineScript：U+2028/U+2029 被转义', () => {
  const encoded = jsonForInlineScript('a\u2028b\u2029c');
  assert.ok(encoded.includes('\\u2028'));
  assert.ok(encoded.includes('\\u2029'));
});

test('generateHTML：消息含 </script> 时内嵌 JSON 不逃逸脚本块', () => {
  const html = generateHTML(
    'hello </script><script>alert("xss")</script> world',
    BASE.timeout,
    'zh',
    'auto',
    'testtoken'
  );
  // 提取 originalMarkdown 赋值行，验证用户内容不包含未转义的 </script>
  const line = html.match(/const originalMarkdown = .*?;/)?.[0] ?? '';
  assert.ok(line, 'originalMarkdown assignment not found');
  assert.ok(!line.includes('</script>'), 'script-breakout not escaped');
  assert.ok(line.includes('\\u003c/script\\u003e'));
});

test('generateHTML：令牌以转义 JSON 注入', () => {
  const html = generateHTML('msg', BASE.timeout, 'zh', 'auto', 'tok123');
  assert.ok(html.includes('const FEEDBACK_TOKEN = "tok123"'));
});

test('generateHTML：主题走防御性白名单（未知值回退 auto）', () => {
  const html = generateHTML('msg', BASE.timeout, 'zh', 'dark");alert(1);//', 't');
  assert.ok(html.includes('const themeMode = "auto"'));
  assert.ok(!html.includes('alert(1)'));
});

test('generateHTML：语言走防御性白名单（未知值回退 zh）', () => {
  const html = generateHTML('msg', BASE.timeout, 'fr', 'auto', 't');
  assert.ok(html.includes('<html lang="zh">'));
  assert.ok(html.includes('交互式反馈'));
});

test('generateFinalHTML：收尾页含标题、手动关闭提示与自关脚本', () => {
  const html = generateFinalHTML('zh');
  assert.ok(html.includes('会话已结束'));
  assert.ok(html.includes('请手动关闭'));
  assert.ok(html.includes('window.close()'));
  assert.ok(html.includes('tryCloseWindow()'));
});

test('generateFinalHTML：语言走防御性白名单（未知值回退 zh）', () => {
  assert.ok(generateFinalHTML('en').includes('Session ended'));
  assert.ok(generateFinalHTML('de').includes('<html lang="zh">'));
  assert.ok(generateFinalHTML('de').includes('会话已结束'));
});

test('generateHTML：英文界面文案正确', () => {
  const html = generateHTML('msg', BASE.timeout, 'en', 'auto', 't');
  assert.ok(html.includes('<html lang="en">'));
  assert.ok(html.includes('Interactive Feedback'));
});

test('generateHTML：超时毫秒数注入为整数', () => {
  const html = generateHTML('msg', 90_000, 'zh', 'auto', 't');
  assert.ok(html.includes('Date.now() + 90000'));
});

test('generateHTML：CSP 包含 frame-ancestors 与 connect-src self', () => {
  assert.ok(CSP_HEADER.includes("frame-ancestors 'none'"));
  assert.ok(CSP_HEADER.includes("connect-src 'self'"));
  const html = generateHTML('msg', BASE.timeout, 'zh', 'auto', 't');
  assert.ok(html.includes('X-Feedback-Token'));
});

test('generateHTML：净化后的消息正文不含原始 script 标签', () => {
  const html = generateHTML('<script>alert(1)</script>ok', BASE.timeout, 'zh', 'auto', 't');
  const content = html.match(/<div class="content" id="content">([\s\S]*?)<\/div>/)?.[1] ?? '';
  assert.ok(!content.includes('<script'));
  assert.ok(content.includes('ok'));
});

test('generateHTML：消息含 HTML 注入的组合攻击载荷', () => {
  const payload = '"><img src=x onerror=alert(1)>```js\n</script><script>alert(2)</script>\n```';
  const html = generateHTML(payload, BASE.timeout, 'zh', 'auto', 't');

  // 正文区：onerror 事件属性必须被净化（img 可保留但不得携带事件属性）
  const content = html.match(/<div class="content" id="content">([\s\S]*?)<\/div>/)?.[1] ?? '';
  assert.ok(!content.includes('onerror'), `onerror must be sanitized in content: ${content}`);

  // 内嵌 JSON：不得包含未转义的 </script>（防脚本块逃逸）
  const line = html.match(/const originalMarkdown = .*?;/)?.[0] ?? '';
  assert.ok(!line.includes('</script>'));
});
