/**
 * @fileoverview 服务器配置解析：环境变量 → 带边界钳制的结构化配置。
 *
 * 所有环境变量输入都在此集中校验并钳制到安全区间，保证：
 * - 非法/越界值回退默认值而不是抛异常（MCP 服务器必须能启动）；
 * - 超时上界受控（Node `setTimeout` 超过 2^31-1ms 会立即触发，必须钳制）；
 * - 端口区间合法（0 = 随机端口）。
 */

import type { ThemeMode, UIBackendType } from './types.js';

/** 服务器配置（由 {@link parseConfig} 从环境变量解析） */
export interface ServerConfig {
  /** 对话框超时（毫秒） */
  defaultTimeoutMs: number;
  /** 界面语言 */
  language: 'zh' | 'en';
  /** UI 后端：browser（默认，富文本）/ native（系统对话框，省内存）/ auto */
  ui: UIBackendType;
  /** 主题：auto（跟随系统）/ light / dark */
  theme: ThemeMode;
  /** 浏览器后端监听端口，0 表示随机（默认）。固定端口可让主题偏好跨会话记忆 */
  port: number;
}

/** 默认超时（秒） */
export const DEFAULT_TIMEOUT_SEC = 300;
/** 超时下界（秒）：过短的对话框没有实际交互意义 */
export const MIN_TIMEOUT_SEC = 5;
/** 超时上界（秒）：1 天；同时远低于 Node 定时器 2^31-1ms 上限，防止溢出立即触发 */
export const MAX_TIMEOUT_SEC = 86400;

/** message 输入长度上界（字符）：防止病态超长输入拖垮渲染与浏览器 */
export const MAX_MESSAGE_CHARS = 1_000_000;
/** 用户响应长度上界（字符），超出部分截断并追加标记 */
export const MAX_RESPONSE_CHARS = 1_000_000;
/** 响应截断时追加的标记 */
export const RESPONSE_TRUNCATION_MARKER =
  '\n[feedback-mcp] Response truncated at 1,000,000 characters.';

/** 解析十进制整数；非法（NaN）返回 null */
function toInt(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** 钳制到 [min, max] */
function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/**
 * 解析服务器配置。
 *
 * @param env - 环境变量（默认 process.env，测试可注入）
 */
export function parseConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  // 超时（秒）：非法回退 300；合法值钳制到 [5, 86400]
  const parsedTimeoutSec = toInt(env.FEEDBACK_TIMEOUT);
  const timeoutSec = clamp(parsedTimeoutSec ?? DEFAULT_TIMEOUT_SEC, MIN_TIMEOUT_SEC, MAX_TIMEOUT_SEC);
  if (env.FEEDBACK_TIMEOUT !== undefined && parsedTimeoutSec !== timeoutSec) {
    console.error(`[feedback-mcp] FEEDBACK_TIMEOUT uses seconds (5-86400); effective timeout: ${timeoutSec}s. Use 600 for 10 minutes.`);
  }
  if (env.FEEDBACK_MAX_TOKENS !== undefined) {
    console.error('[feedback-mcp] FEEDBACK_MAX_TOKENS was removed in v2.1 and is ignored; message limit is 1,000,000 characters.');
  }

  // 语言仅接受 'zh' | 'en'，非法值回退为 'zh'
  const language: 'zh' | 'en' = env.FEEDBACK_LANGUAGE === 'en' ? 'en' : 'zh';

  // UI 后端：browser（默认）/ native / auto
  const rawUi = env.FEEDBACK_UI;
  const ui: UIBackendType =
    rawUi === 'auto' || rawUi === 'native' || rawUi === 'browser' ? rawUi : 'browser';

  // 主题：auto（默认，跟随系统）/ light / dark
  const rawTheme = env.FEEDBACK_THEME;
  const theme: ThemeMode =
    rawTheme === 'light' || rawTheme === 'dark' ? rawTheme : 'auto';

  // 端口：0（随机，默认）或 1-65535；非法/越界回退 0（钳到边界端口反而意外）
  const rawPort = toInt(env.FEEDBACK_PORT);
  const port = rawPort !== null && rawPort >= 0 && rawPort <= 65535 ? rawPort : 0;

  return { defaultTimeoutMs: timeoutSec * 1000, language, ui, theme, port };
}
