# feedback-mcp-server

一个轻量级的 MCP (Model Context Protocol) 服务器，提供基于浏览器的交互式用户反馈功能，支持完整的 Markdown 渲染和语法高亮。

<p align="center">
  <img alt="开源许可协议" src="https://img.shields.io/npm/l/feedback-mcp-server">
  <img alt="当前版本" src="https://img.shields.io/npm/v/feedback-mcp-server">
  <img alt="下载量" src="https://img.shields.io/npm/dm/feedback-mcp-server">
</p>

## 🌟 功能特性

<p align="center">
  <img src="https://raw.githubusercontent.com/NianLog/feedback-mcp/main/assets/1.png" alt="MCP工具运行效果页面" width="800">
</p>

### 🚀 核心功能

- ✅ **轻量级浏览器窗口**：Chrome/Edge App 模式，无地址栏，资源占用低
- ✅ **Markdown 渲染**：完整的 Markdown 支持和语法高亮
- ✅ **智能复制**：支持复制为纯文本或 Markdown 格式
- ✅ **多语言界面**：中文和英文界面切换
- ✅ **超时控制**：可配置超时时间，自动关闭
- ✅ **跨平台支持**：Windows、macOS 和 Linux
- ✅ **安全可靠**：仅监听 localhost，不暴露到公网

## 📦 安装

### 方式 1：使用 npx（推荐）

无需安装，直接在 Claude Desktop 中使用：

```json
{
  "mcpServers": {
    "feedback": {
      "command": "npx",
      "args": ["-y", "feedback-mcp-server@latest"],
      "env": {
        "FEEDBACK_TIMEOUT": "300000",
        "FEEDBACK_MAX_TOKENS": "2000",
        "FEEDBACK_LANGUAGE": "zh"
      }
    }
  }
}
```

### 方式 2：全局安装

```bash
npm install -g feedback-mcp-server@latest
```

配置：

```json
{
  "mcpServers": {
    "feedback": {
      "command": "feedback-mcp-server",
      "env": {
        "FEEDBACK_TIMEOUT": "300000",
        "FEEDBACK_MAX_TOKENS": "2000",
        "FEEDBACK_LANGUAGE": "zh"
      }
    }
  }
}
```

## ⚙️ 配置

### 环境变量

| 环境变量 | 描述 | 默认值 |
|---------|------|--------|
| `FEEDBACK_TIMEOUT` | 超时时间（ms） | 300000 (5 min) |
| `FEEDBACK_MAX_TOKENS` | 最大输出token数 | 无限制 |
| `FEEDBACK_LANGUAGE` | 界面语言 | zh（可选zh/en） |

**推荐配置：**
```json
{
  "env": {
    "FEEDBACK_TIMEOUT": "300000",
    "FEEDBACK_MAX_TOKENS": "2000",
    "FEEDBACK_LANGUAGE": "zh"
  }
}
```

## 🎯 使用方式

AI 会自动调用 `interactive_feedback` 工具，浏览器会打开对话框显示消息内容。

### 工具参数

- `message` (必填): 要显示给用户的消息内容，支持完整的 Markdown 格式

### 返回值

```json
{
  "submitted": boolean,   // 用户是否提交了响应
  "response": string,     // 用户输入的内容
  "timedOut": boolean     // 是否超时
}
```

## 🎨 界面特性

- **Markdown 渲染**：完整支持代码高亮、表格、列表等
- **智能复制**：支持复制为纯文本或 Markdown 格式
- **快捷键**：`Ctrl + Enter` 提交，`Esc` 取消
- **多语言界面**：中文和英文切换

## 📝 使用示例

### 简单确认

```json
{
  "message": "是否继续执行删除操作？此操作不可逆。"
}
```

### 代码审查结果

```json
{
  "message": "## 代码审查结果\n\n发现以下问题：\n\n1. **类型错误**\n   ```typescript\n   const x: string = 123; // 类型不匹配\n   ```\n\n2. **性能问题**\n   - 未使用缓存\n   - 重复计算\n\n请确认是否修复？"
}
```

## 🛠️ 技术栈

- **Node.js** + **TypeScript**
- **MCP SDK**：@modelcontextprotocol/sdk
- **Markdown 渲染**：marked + Prism.js

## 📋 系统要求

- **Node.js** >= 18.0.0
- **操作系统**：Windows 10+ / macOS 10.15+ / Linux
- **浏览器**：Chrome 或 Edge（推荐）

## 🐛 故障排除

**浏览器没有打开**
- 检查是否安装了 Chrome 或 Edge

**对话框无法提交**
- 检查网络连接和防火墙设置

---

<div align="center">
  <sub>
    <p>Made with ❤️ by <a href="https://github.com/NianLog/feedback-mcp">NianLog</a></p>
  </sub>
</div>
