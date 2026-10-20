/**
 * @fileoverview 对话框路由层 —— 按 UI 后端配置选择实现，并串行化并发对话框。
 *
 * v2.0 引入可插拔后端架构：
 * - **browser**（默认）：富文本浏览器对话框（{@link BrowserBackend}），Markdown + 代码高亮，内存较高。
 * - **native**：系统原生对话框（{@link NativeBackend}），纯文本、内存 ~10MB。
 * - **auto**：优先 native，不可用则 fallback browser。
 *
 * 由 `options.ui`（来自 `FEEDBACK_UI` 环境变量）控制；未指定时默认 browser，保持向后兼容。
 *
 * v2.2：MCP 协议允许客户端并发调用工具——多个对话框同时弹出会互相抢焦点、
 * 消耗多个端口与浏览器进程。{@link DialogRouter} 以 FIFO 队列串行化，
 * 后到的调用等前一个结束后再展示（各自超时从实际展示时刻起算）。
 */

import type { DialogOptions, DialogResult, UIBackend, UIBackendType } from './core/types.js';
import { MAX_RESPONSE_CHARS, RESPONSE_TRUNCATION_MARKER } from './core/config.js';
import { BrowserBackend } from './backends/browser-backend.js';
import { NativeBackend } from './backends/native-backend.js';

/** 向后兼容：re-export 核心类型（index.ts 等从此处导入） */
export type {
  DialogOptions,
  DialogResult,
  UIBackend,
  UIBackendType,
} from './core/types.js';

/** 响应超长时截断并追加显式标记（不静默丢弃用户输入） */
function clampResponse(result: DialogResult): DialogResult {
  if (result.response && result.response.length > MAX_RESPONSE_CHARS) {
    return {
      ...result,
      response: result.response.slice(0, MAX_RESPONSE_CHARS) + RESPONSE_TRUNCATION_MARKER,
    };
  }
  return result;
}

/** 后端选择器签名（路由器注入，便于测试） */
export type BackendSelector = (ui: UIBackendType | undefined) => Promise<UIBackend>;

/** 按 UI 后端配置选择后端实例（auto：优先 native，不可用则 fallback browser） */
async function selectBackend(ui: UIBackendType | undefined): Promise<UIBackend> {
  const choice = ui ?? 'browser';
  if (choice === 'native') return nativeBackend;
  if (choice === 'browser') return browserBackend;
  if (await nativeBackend.isAvailable()) {
    console.error('[feedback-mcp] auto: native backend available, using it');
    return nativeBackend;
  }
  console.error('[feedback-mcp] auto: native backend unavailable, falling back to browser');
  return browserBackend;
}

/**
 * 对话框路由器：串行化 show 调用 + 结果统一钳制。
 */
export class DialogRouter {
  private queueTail: Promise<unknown> = Promise.resolve();
  private activeCount = 0;

  constructor(private readonly selectBackend: BackendSelector) {}

  /** 展示对话框（并发调用将按 FIFO 排队） */
  show(options: DialogOptions): Promise<DialogResult> {
    const signal = options.signal;
    if (signal?.aborted) return Promise.resolve({ submitted: false });
    if (this.activeCount > 0) {
      console.error(`[feedback-mcp] A dialog is already active, queueing (waiting: ${this.activeCount})`);
    }
    const task = this.queueTail.then(() => this.runOne(options));
    // 队尾吞掉异常，后续调用不受前序失败影响
    this.queueTail = task.then(
      () => undefined,
      () => undefined
    );
    if (!signal) return task;
    let onAbort!: () => void;
    const cancelled = new Promise<DialogResult>((resolve) => {
      onAbort = () => resolve({ submitted: false });
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return Promise.race([task, cancelled]).finally(() => signal.removeEventListener('abort', onAbort));
  }

  private async runOne(options: DialogOptions): Promise<DialogResult> {
    if (options.signal?.aborted) return { submitted: false };
    this.activeCount++;
    try {
      const backend = await this.selectBackend(options.ui);
      if (options.signal?.aborted) return { submitted: false };
      let result: DialogResult;
      try {
        result = await backend.show(options);
      } catch (error) {
        // 后端实现不应 reject，这里兜底防止击穿 MCP 工具调用
        result = {
          submitted: false,
          error: `dialog backend crashed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      return clampResponse(result);
    } finally {
      this.activeCount--;
    }
  }
}

// 后端单例
const browserBackend = new BrowserBackend();
const nativeBackend = new NativeBackend();

// 默认路由器实例
const router = new DialogRouter(selectBackend);

/**
 * 显示交互式对话框并等待用户响应。
 *
 * 按 `options.ui` 选择后端（默认 browser）；并发调用自动排队。
 *
 * @param options - 对话框配置选项
 * @returns 用户响应结果
 */
export function showDialog(options: DialogOptions): Promise<DialogResult> {
  return router.show(options);
}
