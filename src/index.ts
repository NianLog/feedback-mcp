#!/usr/bin/env node

/**
 * @fileoverview 交互式反馈 MCP 服务器
 *
 * 提供交互式用户反馈功能，通过对话框收集用户输入。支持 Markdown 渲染、主题切换、
 * 可选的浏览器/系统原生 UI 后端。
 *
 * 使用方式：在 MCP 客户端（Claude Desktop / Cursor 等）配置中添加此服务器。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { showDialog, type DialogOptions, type UIBackendType } from './dialog.js';
import type { ThemeMode } from './core/types.js';

/**
 * 从 package.json 读取版本号，确保 MCP 握手上报的版本与发布版本一致。
 * 路径基于当前模块位置（dist/index.js 或 src/index.ts）向上回到包根。
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgVersion = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')
).version as string;

/**
 * 服务器配置（从环境变量解析）
 */
interface ServerConfig {
  /** 对话框超时（毫秒，由 FEEDBACK_TIMEOUT 秒换算） */
  defaultTimeout: number;
  /** 界面语言（'zh' | 'en'） */
  language: string;
  /** UI 后端：browser（默认，富文本）/ native（系统对话框，省内存）/ auto */
  ui: UIBackendType;
  /** 主题：auto（跟随系统）/ light / dark */
  theme: ThemeMode;
}

/**
 * 解析服务器配置。
 *
 * 设计原则：不再用环境变量强制截断用户输入（FEEDBACK_MAX_TOKENS 已移除）——
 * 误伤正常的长日志/代码反而不利。token 控制交给 AI 协作（通过工具描述引导
 * AI 主动精简 message），比硬截断更合理。
 */
function parseConfig(): ServerConfig {
  // 超时（秒）：FEEDBACK_TIMEOUT 以秒为单位，默认 300s（5 分钟），最小 5s，非法回退 300s
  const rawTimeout = parseInt(process.env.FEEDBACK_TIMEOUT || '300', 10);
  const timeoutSec = Number.isFinite(rawTimeout) && rawTimeout >= 5 ? rawTimeout : 300;
  const defaultTimeout = timeoutSec * 1000;

  // 语言仅接受 'zh' | 'en'，非法值回退为 'zh'
  const rawLang = process.env.FEEDBACK_LANGUAGE || 'zh';
  const language = rawLang === 'en' || rawLang === 'zh' ? rawLang : 'zh';

  // UI 后端：browser（默认）/ native / auto
  const rawUi = process.env.FEEDBACK_UI || 'browser';
  const ui: UIBackendType = rawUi === 'auto' || rawUi === 'native' ? rawUi : 'browser';

  // 主题：auto（默认，跟随系统）/ light / dark
  const rawTheme = process.env.FEEDBACK_THEME || 'auto';
  const theme: ThemeMode = rawTheme === 'light' || rawTheme === 'dark' ? rawTheme : 'auto';

  return { defaultTimeout, language, ui, theme };
}

/**
 * 主函数 - 初始化并启动 MCP 服务器
 */
async function main() {
  const config = parseConfig();

  const server = new McpServer({
    name: 'feedback-mcp',
    version: pkgVersion,
  });

  console.error('[feedback-mcp] Server starting...');
  console.error(`[feedback-mcp] Timeout: ${config.defaultTimeout / 1000}s`);
  console.error(`[feedback-mcp] Language: ${config.language}`);
  console.error(`[feedback-mcp] UI backend: ${config.ui}`);
  console.error(`[feedback-mcp] Theme: ${config.theme}`);

  /**
   * 注册 interactive_feedback 工具。
   *
   * 工具描述刻意精简（节约 token），并提示 AI 控制 message 长度——
   * 这比用环境变量硬截断用户输入更合理（避免误伤正常的长日志/代码）。
   */
  server.registerTool(
    'interactive_feedback',
    {
      title: 'Interactive Feedback Dialog',
      description:
        'Show a dialog to the user with your message and wait for their response. ' +
        'Use this to ask questions, confirm decisions, or get input when blocked. ' +
        'Keep the message concise and readable — the user reads it, so summarize rather than dumping raw logs.',
      inputSchema: {
        message: z
          .string()
          .describe('Text to show the user (Markdown supported). Keep it focused and readable.'),
      },
      outputSchema: {
        submitted: z.boolean().describe('Whether the user submitted a response'),
        response: z.string().optional().describe('User response content'),
        timedOut: z.boolean().optional().describe('Whether the dialog timed out'),
      },
    },
    async ({ message }) => {
      console.error('[feedback-mcp] Tool called with message length:', message.length);

      const dialogOptions: DialogOptions = {
        message,
        timeout: config.defaultTimeout,
        language: config.language,
        ui: config.ui,
        theme: config.theme,
      };

      const result = await showDialog(dialogOptions);

      console.error('[feedback-mcp] Dialog result:', {
        submitted: result.submitted,
        responseLength: result.response?.length || 0,
        timedOut: result.timedOut,
      });

      const output = {
        submitted: result.submitted,
        response: result.response || '',
        timedOut: result.timedOut || false,
      };

      // 返回简洁的文本响应（节约 token）
      let textResponse: string;
      if (result.submitted && result.response) {
        textResponse = `User response: ${result.response}`;
      } else if (result.timedOut) {
        textResponse = 'User did not respond (timeout)';
      } else {
        textResponse = 'User cancelled';
      }

      return {
        content: [{ type: 'text', text: textResponse }],
        structuredContent: output,
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[feedback-mcp] Server started and connected via stdio');
}

// 错误处理
process.on('unhandledRejection', (error) => {
  console.error('[feedback-mcp] Unhandled rejection:', error);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.error('[feedback-mcp] Received SIGINT, shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('[feedback-mcp] Received SIGTERM, shutting down...');
  process.exit(0);
});

// 启动服务器
main().catch((error) => {
  console.error('[feedback-mcp] Fatal error:', error);
  process.exit(1);
});
