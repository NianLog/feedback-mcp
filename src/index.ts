#!/usr/bin/env node

/**
 * @fileoverview 交互式反馈 MCP 服务器
 *
 * 提供交互式用户反馈功能，通过对话框收集用户输入。支持 Markdown 渲染、主题切换、
 * 可选的浏览器/系统原生 UI 后端。
 *
 * 使用方式：在 MCP 客户端（Claude Desktop / Cursor 等）配置中添加此服务器。
 */

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { showDialog } from './dialog.js';
import { parseConfig, MAX_MESSAGE_CHARS } from './core/config.js';
import type { Language } from './core/types.js';

/**
 * 从 package.json 读取版本号，确保 MCP 握手上报的版本与发布版本一致。
 * 路径基于当前模块位置（dist/index.js 或 src/index.ts）向上回到包根。
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgVersion = (() => {
  try {
    return (JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')) as {
      version?: string;
    }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/**
 * 主函数 - 初始化并启动 MCP 服务器
 */
async function main() {
  const config = parseConfig();
  const lifetime = new AbortController();
  const handle = serveStdio(() => {
    const server = new McpServer({
      name: 'feedback-mcp',
      version: pkgVersion,
    });

    console.error(`[feedback-mcp] Server starting (v${pkgVersion})...`);
    console.error(`[feedback-mcp] Timeout: ${config.defaultTimeoutMs / 1000}s`);
    console.error(`[feedback-mcp] Language: ${config.language}`);
    console.error(`[feedback-mcp] UI backend: ${config.ui}`);
    console.error(`[feedback-mcp] Theme: ${config.theme}`);
    console.error(`[feedback-mcp] Port: ${config.port === 0 ? 'random' : config.port}`);

    /**
     * 注册 interactive_feedback 工具。
     *
     * 工具描述刻意精简（节约 token），并提示 AI 控制 message 长度——
     * 这比用环境变量硬截断用户输入更合理（避免误伤正常的长日志/代码）。
     * message 仅有非空 + 字符数上界的硬校验（防病态超长输入拖垮渲染）。
     */
    server.registerTool(
      'interactive_feedback',
      {
        title: 'Interactive Feedback Dialog',
        description:
          'Show a dialog to the user with your message and wait for their response. ' +
          'Use this to ask questions, confirm decisions, or get input when blocked. ' +
          'A timeout or cancellation is not user approval. Resume a still-running wrapper until this call completes; do not open a duplicate dialog. ' +
          'Keep the message concise and readable — the user reads it, so summarize rather than dumping raw logs.',
        inputSchema: {
          message: z
            .string()
            .min(1, 'message must not be empty')
            .max(
              MAX_MESSAGE_CHARS,
              `message exceeds ${MAX_MESSAGE_CHARS} characters; summarize it or split into multiple turns`
            )
            .describe('Text to show the user (Markdown supported). Keep it focused and readable.'),
        },
        outputSchema: {
          submitted: z.boolean().describe('Whether the user submitted a response'),
          response: z.string().optional().describe('User response content'),
          timedOut: z.boolean().optional().describe('Whether the dialog timed out'),
          error: z.string().optional().describe('Error message when the dialog could not be shown'),
        },
      },
      async ({ message }, extra) => {
        console.error('[feedback-mcp] Tool called with message length:', message.length);

        const result = await showDialog({
          message,
          timeout: config.defaultTimeoutMs,
          language: config.language as Language,
          ui: config.ui,
          theme: config.theme,
          port: config.port,
          signal: AbortSignal.any([extra.mcpReq.signal, lifetime.signal]),
        });

        console.error('[feedback-mcp] Dialog result:', {
          submitted: result.submitted,
          responseLength: result.response?.length || 0,
          timedOut: result.timedOut,
          error: result.error,
        });

        const output = {
          submitted: result.submitted,
          response: result.response || '',
          timedOut: result.timedOut || false,
          ...(result.error ? { error: result.error } : {}),
        };

        // 对话框未能展示（浏览器启动失败/原生工具缺失）必须以错误语义告知 AI，
        // 而不是伪装成"用户取消"误导其后续决策。
        let textResponse: string;
        let isError = false;
        if (result.error) {
          isError = true;
          textResponse = `Dialog error: ${result.error}`;
        } else if (result.submitted) {
          textResponse = `User response: ${result.response ?? ''}`;
        } else if (result.timedOut) {
          textResponse = 'User did not respond (timeout)';
        } else {
          textResponse = 'User cancelled';
        }

        return {
          content: [{ type: 'text' as const, text: textResponse }],
          structuredContent: output,
          isError,
        };
      }
    );

    return server;
  }, { legacy: 'serve', onerror: (error) => console.error('[feedback-mcp] Transport error:', error.message) });

  const shutdown = async () => {
    lifetime.abort();
    await handle.close();
  };
  process.stdin.once('end', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });

  console.error('[feedback-mcp] Server started and connected via stdio');
}

// 错误处理
process.on('unhandledRejection', (error) => {
  console.error('[feedback-mcp] Unhandled rejection:', error);
  process.exit(1);
});

// 启动服务器
main().catch((error) => {
  console.error('[feedback-mcp] Fatal error:', error);
  process.exit(1);
});
