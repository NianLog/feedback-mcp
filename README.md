# feedback-mcp-server v1.2.0

一个轻量级的 MCP (Model Context Protocol) 服务器，提供基于浏览器的交互式用户反馈功能，支持完整的 Markdown 渲染和语法高亮。

<p align="center">
  <img alt="开源许可协议" src="https://img.shields.io/npm/l/feedback-mcp-server">
  <img alt="当前版本" src="https://img.shields.io/npm/v/feedback-mcp-server">
  <img alt="下载量" src="https://img.shields.io/npm/dm/feedback-mcp-server">
</p>

## 🌟 功能特性

<p align="center">
  <img src="./assets/1.png" alt="MCP工具运行效果页面" width="800">
</p>

### 🚀 核心功能

- ✅ **轻量级浏览器窗口**：Chrome/Edge App 模式，无地址栏，资源占用低
- ✅ **Markdown 渲染**：完整的 Markdown 支持和语法高亮
- ✅ **完全离线运行**：代码高亮（Prism）本地化打包，无需网络或 CDN 即可工作
- ✅ **安全防护**：HTML 净化（sanitize-html）防止 XSS、CSP 安全响应头、仅监听 localhost 不暴露公网
- ✅ **智能复制**：支持复制为纯文本或 Markdown 格式
- ✅ **多语言界面**：中文和英文界面切换
- ✅ **超时控制**：可配置超时时间，自动关闭；超时与主动取消语义分离，便于 AI 准确判断
- ✅ **多浏览器支持**：Chrome / Edge（App 模式）、Firefox / Safari（普通窗口）
- ✅ **跨平台支持**：Windows、macOS 和 Linux

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
| `FEEDBACK_TIMEOUT` | 超时时间（ms），最小 5000，低于则回退默认 | 300000 (5 min) |
| `FEEDBACK_MAX_TOKENS` | 最大输出token数 | 无限制 |
| `FEEDBACK_LANGUAGE` | 界面语言（仅支持 `zh` / `en`，非法值回退 `zh`） | zh |

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
  "timedOut": boolean     // 是否超时（与主动取消区分）
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
- **Markdown 渲染**：marked + Prism.js（本地化，离线可用）
- **安全净化**：sanitize-html（剥离脚本/事件属性，防止 XSS）

## 📋 系统要求

- **Node.js** >= 18.0.0
- **操作系统**：Windows 10+ / macOS 10.15+ / Linux
- **浏览器**：Chrome 或 Edge（推荐，App 模式）；Firefox / Safari 亦支持（普通窗口模式）

## 🐛 故障排除

**浏览器没有打开**
- 检查是否安装了 Chrome、Edge、Firefox 或 Safari

**Firefox / Safari 下窗口带有地址栏**
- 这两种浏览器不支持 App 模式，会以普通窗口打开，属预期行为

**对话框无法提交**
- 检查网络连接和防火墙设置

## 📋 更新日志

### v1.2.0
- 🎨 **界面重设计**：移除蓝紫渐变与 emoji，采用石墨极简风格（中性灰 + 墨绿强调）；暗色主题改为中性石墨深灰
- 🔒 **安全加固**：引入 sanitize-html 净化 Markdown 渲染输出，防止 XSS；错误提示改用 textContent；新增 CSP / nosniff / Referrer-Policy 安全响应头
- 🐛 **正确性修复**：HTTP 响应统一收口，消除重复写入竞态；超时改为独立端点，修正 `timedOut` 标志丢失；修复 Firefox 下复制按钮失效；submit/cancel 防重入
- 🛠️ **可靠性**：移除不可靠的 Windows `start chrome` 路径，统一浏览器探测；修复 `path`/`process` 变量遮蔽；MCP 握手版本号改为从 package.json 注入
- 📦 **完全离线**：Prism 代码高亮本地化打包（精选常用语言），移除所有 CDN 依赖，无网环境正常工作
- 🌐 **工程化**：补全"提交中/处理中"文案 i18n；`FEEDBACK_TIMEOUT` 下界校验、`FEEDBACK_LANGUAGE` 收紧为 zh/en；升级依赖修复 7 个安全漏洞

### v1.1.2
- 增强错误处理与重试机制
- 新增主题切换、窗口位置记忆、快捷键提示
- 增强浏览器兼容性（Safari/Firefox 支持）

---

<div align="center">
  <sub>
    <p>Made with ❤️ by <a href="https://github.com/NianLog/feedback-mcp">NianLog</a></p>
  </sub>
</div>
