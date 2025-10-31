#!/usr/bin/env node

/**
 * @fileoverview 交互式反馈MCP服务器
 *
 * 该MCP服务器提供交互式用户反馈功能，通过浏览器对话框收集用户输入。
 * 支持Markdown渲染、超时控制和配置管理。
 *
 * 使用方式：
 * 1. 在Claude Desktop的配置文件中添加此MCP服务器
 * 2. AI可以调用interactive_feedback工具来获取用户的交互式反馈
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { showDialog, type DialogOptions } from './dialog.js';

/**
 * 从环境变量或参数中获取配置
 */
interface ServerConfig {
  /** 默认超时时间（毫秒） */
  defaultTimeout: number;
  /** 最大输出token数 */
  maxTokens?: number;
  /** 界面语言 ('zh' | 'en') */
  language: string;
}

/**
 * 解析服务器配置
 *
 * 配置优先级：环境变量 > 默认值
 */
function parseConfig(): ServerConfig {
  return {
    defaultTimeout: parseInt(process.env.FEEDBACK_TIMEOUT || '300000', 10),
    maxTokens: process.env.FEEDBACK_MAX_TOKENS
      ? parseInt(process.env.FEEDBACK_MAX_TOKENS, 10)
      : undefined,
    language: process.env.FEEDBACK_LANGUAGE || 'zh',
  };
}

/**
 * 主函数 - 初始化并启动MCP服务器
 */
async function main() {
  const config = parseConfig();

  // 创建MCP服务器实例
  const server = new McpServer({
    name: 'feedback-mcp',
    version: '1.0.0',
  });

  console.error('[feedback-mcp] Server starting...');
  console.error(`[feedback-mcp] Default timeout: ${config.defaultTimeout}ms`);
  console.error(`[feedback-mcp] Language: ${config.language}`);
  if (config.maxTokens) {
    console.error(`[feedback-mcp] Max tokens: ${config.maxTokens}`);
  }

  /**
   * 注册interactive_feedback工具
   *
   * 该工具接收消息内容，通过浏览器对话框展示并等待用户响应。
   * 支持Markdown格式内容，自动处理渲染失败的情况。
   */
  server.registerTool(
    'interactive_feedback',
    {
      title: 'Interactive Feedback Dialog',
      description:
        'Request interactive feedback from the user via a lightweight browser dialog. ' +
        'Displays content with full Markdown support and syntax highlighting. ' +
        'Timeout and token limits are configured via environment variables in MCP server settings.',
      inputSchema: {
        message: z
          .string()
          .describe('The message to display to the user (supports Markdown format with syntax highlighting for code blocks)'),
      },
      outputSchema: {
        submitted: z.boolean().describe('Whether the user submitted a response'),
        response: z.string().optional().describe('User response content'),
        timedOut: z.boolean().optional().describe('Whether the dialog timed out'),
      },
    },
    async ({ message }) => {
      console.error('[feedback-mcp] Tool called with message length:', message.length);

      // 准备对话框选项（使用环境变量配置）
      const dialogOptions: DialogOptions = {
        message,
        timeout: config.defaultTimeout,
        maxTokens: config.maxTokens,
        language: config.language,
      };

      // 显示对话框并等待响应
      const result = await showDialog(dialogOptions);

      console.error('[feedback-mcp] Dialog result:', {
        submitted: result.submitted,
        responseLength: result.response?.length || 0,
        timedOut: result.timedOut,
      });

      // 构造输出结果
      const output = {
        submitted: result.submitted,
        response: result.response || '',
        timedOut: result.timedOut || false,
      };

      // 返回简洁的文本响应（节约token）
      let textResponse: string;
      if (result.submitted && result.response) {
        textResponse = `User response: ${result.response}`;
      } else if (result.timedOut) {
        textResponse = 'User did not respond (timeout)';
      } else {
        textResponse = 'User cancelled';
      }

      return {
        content: [
          {
            type: 'text',
            text: textResponse,
          },
        ],
        structuredContent: output,
      };
    }
  );

  // 创建标准输入/输出传输层
  const transport = new StdioServerTransport();

  // 连接服务器到传输层
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
