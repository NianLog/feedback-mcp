/**
 * @fileoverview 对话框路由层 —— 按 UI 后端配置选择实现。
 *
 * v2.0 引入可插拔后端架构：
 * - **browser**（默认）：富文本浏览器对话框（{@link BrowserBackend}），Markdown + 代码高亮，内存较高。
 * - **native**：系统原生对话框（{@link NativeBackend}，批次 3-4 实现），纯文本、内存 ~10MB。
 * - **auto**：优先 native，不可用则 fallback browser。
 *
 * 由 `options.ui`（来自 `FEEDBACK_UI` 环境变量）控制；未指定时默认 browser，保持向后兼容。
 */

import type { DialogOptions, DialogResult, UIBackend, UIBackendType } from './core/types.js';
import { BrowserBackend } from './backends/browser-backend.js';
import { NativeBackend } from './backends/native-backend.js';

/** 向后兼容：re-export 核心类型（index.ts 等从此处导入） */
export type { DialogOptions, DialogResult, UIBackendType } from './core/types.js';

// 后端单例
const browserBackend = new BrowserBackend();
const nativeBackend = new NativeBackend();

/**
 * 按 UI 后端配置选择后端实例。
 *
 * @param ui - 后端类型；未指定（undefined）时默认 browser，保持富文本体验
 */
async function selectBackend(ui: UIBackendType | undefined): Promise<UIBackend> {
  const choice = ui ?? 'browser';
  if (choice === 'native') return nativeBackend;
  if (choice === 'browser') return browserBackend;
  // auto：优先 native，不可用则 fallback browser
  if (await nativeBackend.isAvailable()) {
    return nativeBackend;
  }
  return browserBackend;
}

/**
 * 显示交互式对话框并等待用户响应。
 *
 * 按 `options.ui` 选择后端（默认 browser）。各后端内部处理消息渲染、超时、结果收集。
 *
 * @param options - 对话框配置选项
 * @returns 用户响应结果
 */
export async function showDialog(options: DialogOptions): Promise<DialogResult> {
  const backend = await selectBackend(options.ui);
  return backend.show(options);
}
