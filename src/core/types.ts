/**
 * @fileoverview 核心类型定义：对话框选项、返回结果、UI 后端接口。
 *
 * v2.0 引入可插拔 UI 后端架构，不同实现（浏览器 / 系统原生对话框）
 * 统一实现 {@link UIBackend} 接口，由路由层（dialog.ts）按配置选择。
 */

/** UI 后端类型（由 FEEDBACK_UI 环境变量控制） */
export type UIBackendType = 'auto' | 'browser' | 'native';

/** 主题模式：auto 跟随系统 / light / dark */
export type ThemeMode = 'auto' | 'light' | 'dark';

/** 对话框配置选项 */
export interface DialogOptions {
  /** 消息内容（支持 Markdown 格式） */
  message: string;
  /** 超时时间（毫秒），默认 300000ms（5 分钟） */
  timeout?: number;
  /** 界面语言（'zh' | 'en'） */
  language: string;
  /** UI 后端选择，默认 browser（富文本）；native 为系统对话框（纯文本，省内存） */
  ui?: UIBackendType;
  /** 主题模式，默认 auto（跟随系统 prefers-color-scheme） */
  theme?: ThemeMode;
}

/** 对话框返回结果 */
export interface DialogResult {
  /** 用户是否提交了响应（false 表示超时或取消） */
  submitted: boolean;
  /** 用户输入的内容 */
  response?: string;
  /** 是否因超时而结束 */
  timedOut?: boolean;
}

/**
 * UI 后端统一接口。
 *
 * 实现方需提供 `show`（展示对话框并等待结果）与 `isAvailable`
 * （当前环境是否可用，供 auto 路由探测）。
 */
export interface UIBackend {
  /** 显示对话框，返回用户结果 */
  show(options: DialogOptions): Promise<DialogResult>;
  /** 当前环境是否可用（auto 路由据此选择后端） */
  isAvailable(): Promise<boolean>;
}
