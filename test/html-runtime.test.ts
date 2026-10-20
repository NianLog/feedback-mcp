import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { generateHTML } from '../src/core/html-template.js';

function page(fetcher: typeof fetch = async () => { throw new Error('offline'); }, imageSources: string[] = []) {
  const element = (text = ''): any => ({ textContent: text, innerText: text, value: '', disabled: false,
    children: [], attributes: {}, listeners: {},
    classList: { add() {}, remove() {}, contains: () => false }, style: {},
    setAttribute(name: string, value: string) { this.attributes[name] = value; },
    getAttribute(name: string) { return this.attributes[name]; },
    replaceChildren(...nodes: object[]) { this.children = nodes; },
    addEventListener(type: string, listener: Function) { this.listeners[type] = listener; },
    appendChild() {}, focus() {} });
  const images: any[] = [];
  const placeholders = imageSources.map(src => {
    const placeholder = element('说明');
    placeholder.setAttribute('data-remote-src', src);
    placeholder.setAttribute('data-remote-alt', '图片说明');
    return placeholder;
  });
  const input = element();
  const submit = element('提交'); const cancel = element('取消'); const copy = element('复制');
  const status = element(); const alerts: string[] = [];
  const body = { innerHTML: '', classList: element().classList,
    appendChild: (node: any) => alerts.push(node.message?.textContent ?? '') };
  const context: any = {
    fetch: fetcher, console, URL, setTimeout: () => 0,
    navigator: { clipboard: { writeText: async () => {} } },
    window: { location: { href: 'http://127.0.0.1:3000/' }, matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    EventSource: class { onmessage: any; close() {} constructor() { context.events = this; } },
    document: { body, addEventListener() {},
      getElementById: (id: string) => ({ response: input, content: element('消息'), timer: element(), 'feedback-status': status })[id],
      querySelector: (selector: string) => ({ '.btn-primary': submit, '.btn-secondary': cancel, '.theme-toggle': element(), '[role="status"]': status })[selector],
      querySelectorAll: (selector: string) => selector === '.btn' ? [submit, cancel] : placeholders,
      createElement: (tag: string) => {
        const node = { ...element(), appendChild(child: any) { (this as any).message = child; } };
        if (tag === 'img') images.push(node);
        return node;
      },
    },
  };
  const script = generateHTML('**消息**', 5000, 'zh', 'light', 'token').match(/<script>([\s\S]*?)<\/script>/)![1];
  vm.runInNewContext(script, context);
  return { context, input, submit, cancel, copy, status, body, alerts, placeholders, images };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const response = (state: object) => ({ ok: true, status: 200, json: async () => state }) as Response;

test('页面：复制异步完成后使用保存的按钮引用，事件失效不报错', async () => {
  const p = page();
  let finish!: () => void;
  p.context.navigator.clipboard.writeText = () => new Promise<void>((resolve) => { finish = resolve; });
  const event = { currentTarget: p.copy as object | null };
  const copied = p.context.copyAsPlainText(event);
  event.currentTarget = null;
  finish(); await copied;
  assert.equal(p.copy.textContent, '已复制');
  assert.equal(p.status.textContent, '已复制');
});

test('页面：复制权限失败时有提示，不产生未处理 Promise', async () => {
  const p = page();
  p.context.navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
  await p.context.copyAsMarkdown({ currentTarget: p.copy });
  assert.match(p.alerts.join(''), /复制失败/);
});

test('页面：过期提交保留原文，不能将其他窗口的已提交当作本次成功', async () => {
  const p = page(async () => response({ finished: true, status: 'submitted' }));
  p.input.value = '这次未被接收的回复';
  p.context.submitResponse(); await tick();
  assert.equal(p.body.innerHTML, '');
  assert.equal(p.input.value, '这次未被接收的回复');
  assert.match(p.status.textContent, /会话已结束/);
  assert.equal(p.submit.disabled, true);
});

test('页面：结束事件不能代替本次提交的 HTTP 确认', async () => {
  let acknowledge!: (value: Response) => void;
  const p = page(() => new Promise<Response>((resolve) => { acknowledge = resolve; }));
  p.input.value = '已送达的回复'; p.context.submitResponse();
  p.context.events.onmessage({ data: JSON.stringify({ finished: true, status: 'submitted' }) });
  assert.equal(p.body.innerHTML, '');
  acknowledge(response({ success: true, status: 'submitted' })); await tick();
  assert.match(p.body.innerHTML, /已提交/);
});

test('页面：网络故障不自动重试，保留输入并提示先核对结果', async () => {
  let requests = 0;
  const p = page(async () => { requests++; throw new Error('offline'); });
  p.input.value = '不能丢的回复'; p.context.submitResponse(); await tick();
  assert.equal(requests, 1);
  assert.equal(p.input.value, '不能丢的回复');
  assert.equal(p.submit.disabled, false);
  assert.match(p.alerts.join(''), /核对后再决定是否重试/);
});

test('页面：服务端取消通过事件流结束窗口，不依赖页面计时器', () => {
  const p = page();
  p.context.events.onmessage({ data: JSON.stringify({ finished: true, status: 'cancelled' }) });
  assert.match(p.body.innerHTML, /已取消/);
  assert.doesNotMatch(p.body.innerHTML, /已提交/);
});

for (const status of ['cancelled', 'timeout', 'submitted']) {
test(`页面：${status} 事件保留尚未点击提交的草稿`, () => {
  const p = page();
  p.input.value = '正在输入的中文草稿\n第二行 ✓';
  p.context.events.onmessage({ data: JSON.stringify({ finished: true, status }) });
  assert.equal(p.body.innerHTML, '');
  assert.equal(p.input.value, '正在输入的中文草稿\n第二行 ✓');
  assert.equal(p.submit.disabled, true);
  assert.match(p.status.textContent, /会话已结束/);
});
}

test('页面：用户主动取消仍正常结束，不把放弃的输入当作已提交', async () => {
  const p = page(async () => response({ success: true, status: 'cancelled' }));
  p.input.value = '主动放弃的草稿';
  p.context.cancel(); await tick();
  assert.match(p.body.innerHTML, /已取消/);
  assert.doesNotMatch(p.body.innerHTML, /已提交/);
});

test('页面：远程图片逐张点击加载，显示域名，失败后由用户决定是否重试', () => {
  const p = page(undefined, ['https://images.example/one.png', 'https://other.example/two.png']);
  assert.equal(p.images.length, 0);
  const [button, hint] = p.placeholders[0].children;
  assert.match(button.textContent, /images.example/);
  assert.match(hint.textContent, /网络地址/);
  button.listeners.click(); button.listeners.click();
  assert.equal(p.images.length, 1);
  assert.equal(p.images[0].src, 'https://images.example/one.png');
  assert.equal(p.images[0].referrerPolicy, 'no-referrer');
  p.images[0].onerror();
  assert.equal(button.disabled, false);
  assert.match(hint.textContent, /加载失败/);
  button.listeners.click(); p.images[1].onload();
  assert.equal(p.placeholders[0].children[0], p.images[1]);
  assert.equal(p.placeholders[1].children[0].disabled, false);
});

test('页面：伪造占位符不能加载非法协议；会话结束后不再加载新图片', () => {
  const p = page(undefined, ['javascript:alert(1)', 'https://images.example/one.png']);
  assert.equal(p.placeholders[0].children.length, 0);
  const button = p.placeholders[1].children[0];
  p.context.events.onmessage({ data: '{"status":"cancelled"}' });
  button.listeners.click();
  assert.equal(p.images.length, 0);
});

test('页面：高亮跳过超长代码和会话总量超限，保留完整原文并分任务执行', () => {
  const blocks = [20000, 20000, 20000, 1000000].map(size => ({ textContent: 'x'.repeat(size),
    parentElement: { insertAdjacentElement(_where: string, _note: object) { notes++; } } }));
  let notes = 0, highlighted = 0;
  const scheduled: Function[] = [];
  const prism = { highlightElement() { highlighted++; } };
  const html = generateHTML('```js\nlet x = 1;\n```', 5000, 'zh', 'light', 'token');
  assert.match(html, /prism.js" data-manual/);
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1];
  vm.runInNewContext(script, { window: { Prism: prism }, Prism: prism, finished: false,
    document: { querySelectorAll: () => blocks, createElement: () => ({}) }, setTimeout: (fn: Function) => scheduled.push(fn) });
  while (scheduled.length) scheduled.shift()!();
  assert.equal(highlighted, 2); assert.equal(notes, 2);
  assert.equal(blocks[3].textContent.length, 1000000);
});
