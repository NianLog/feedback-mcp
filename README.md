# feedback-mcp-server v2.2.0

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
- ✅ **可插拔 UI 后端**：默认浏览器富文本；设 `FEEDBACK_UI=native` 改用系统原生对话框（约 10MB 内存，纯文本）
- ✅ **安全防护**：HTML 净化（sanitize-html）+ CSP 防 XSS、脚本块注入转义、会话令牌 + Host 校验防跨站伪造与 DNS rebinding、仅监听 127.0.0.1 不暴露网络
- ✅ **并发安全**：多个对话框调用自动排队串行展示，互不冲突
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
        "FEEDBACK_TIMEOUT": "300",
        "FEEDBACK_LANGUAGE": "zh",
        "FEEDBACK_THEME": "auto"
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
        "FEEDBACK_TIMEOUT": "300",
        "FEEDBACK_LANGUAGE": "zh",
        "FEEDBACK_THEME": "auto"
      }
    }
  }
}
```

## ⚙️ 配置

### 环境变量

| 环境变量 | 描述 | 默认值 |
|---------|------|--------|
| `FEEDBACK_TIMEOUT` | 对话框超时（秒），非法回退 300，合法值钳制到 [5, 86400]（1 天） | 300 (5 min) |
| `FEEDBACK_LANGUAGE` | 界面语言（仅支持 `zh` / `en`，非法值回退 `zh`） | zh |
| `FEEDBACK_UI` | UI 后端（选填）：`browser`（富文本）/ `native`（系统对话框，约10MB）/ `auto`（优先 native，不可用回退 browser） | browser |
| `FEEDBACK_THEME` | 主题（选填）：`auto`（跟随系统）/ `light` / `dark`；手动切换会记忆覆盖 | auto |
| `FEEDBACK_PORT` | browser 后端监听端口（选填）：`0` 随机（默认）；设固定端口（如 `17841`）可让主题偏好跨会话记忆 | 0（随机） |

**推荐配置：**
```json
{
  "env": {
    "FEEDBACK_TIMEOUT": "300",
    "FEEDBACK_LANGUAGE": "zh",
    "FEEDBACK_THEME": "auto"
  }
}
```

## 🎯 使用方式

AI 会自动调用 `interactive_feedback` 工具，浏览器会打开对话框显示消息内容。

### 工具参数

- `message` (必填): 要显示给用户的消息内容，支持完整的 Markdown 格式；非空，上限 1,000,000 字符（超限会收到明确的校验错误而非弹窗）

### 返回值

```json
{
  "submitted": boolean,   // 用户是否提交了响应
  "response": string,     // 用户输入的内容
  "timedOut": boolean,    // 是否超时（与主动取消区分）
  "error": string         // 对话框未能展示时的错误说明（如浏览器启动失败），同时以 isError 返回
}
```

> 语义约定：`submitted=false` 且无 `error` 表示用户主动取消或超时；带 `error` 表示对话框本身出现故障（AI 不应将其误读为用户取消）。

## 🔒 边界与安全

- **输入边界**：`message` 非空且 ≤ 1M 字符；HTTP 提交体 ≤ 1MB；用户响应 ≤ 1M 字符（超出截断并附明确标记）
- **超时边界**：钳制在 [5s, 86400s]，杜绝超长定时器溢出导致的"秒退"
- **XSS 纵深防御**：sanitize-html 白名单净化 + CSP + nosniff + `X-Frame-Options: DENY` + 内嵌 JSON 的 `</script>` 转义
- **本地服务加固**：仅绑定 `127.0.0.1`；`/submit` `/cancel` `/timeout` 需携带页面持有的随机会话令牌（防本机其他网页跨站伪造）；Host 头白名单（防 DNS rebinding）；Prism 静态资源路径遍历防护
- **进程稳定性**：子进程 stdin/stdout 异常全部兜底（用户秒关对话框不再可能击穿服务器）；HTTP 服务结束后彻底销毁连接，无端口/句柄泄漏
- **窗口生命周期**：对话框结束（提交/取消/超时）后窗口自动关闭；因浏览器冷启动慢而"晚到"的窗口会收到"会话已结束"收尾页并自行关闭，不会停留在加载失败错误页
- **并发**：并发的工具调用按 FIFO 排队，一次只展示一个对话框

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

## 🧪 开发与测试

```bash
npm install
npm run build      # TypeScript 编译到 dist/
npm test           # 单元 + 集成测试（71 项，含 HTTP 协议/安全/资源释放）
npm run test:e2e   # 端到端冒烟（真实 MCP 握手 + 真实窗口，会短暂弹窗）
```

## 📋 系统要求

- **Node.js** >= 18.2.0
- **操作系统**：Windows 10+ / macOS 10.15+ / Linux
- **浏览器**：Chrome 或 Edge（推荐，App 模式）；Firefox / Safari 亦支持（普通窗口模式）
- **native 后端**：Windows 需 PowerShell（系统自带）；Linux 需 zenity；macOS 使用系统自带 osascript

## 🐛 故障排除

**浏览器没有打开**
- 检查是否安装了 Chrome、Edge、Firefox 或 Safari
- 此时工具会返回带 `error` 的结果（`isError: true`），AI 可据此改用纯文本方式询问

**Firefox / Safari 下窗口带有地址栏**
- 这两种浏览器不支持 App 模式，会以普通窗口打开，属预期行为

**对话框无法提交**
- 检查本机 127.0.0.1 回环是否被防火墙/安全软件拦截

**窗口没有自动关闭**
- Chrome/Edge 的 App 窗口会自行关闭；Firefox/Safari 普通窗口可能拒绝脚本关闭，此时窗口会停留在"会话已结束"提示页，手动关闭即可（属浏览器安全策略，非故障）

**native 模式长消息显示不全**
- v2.2.0 起消息区为可滚动多行文本框，可拉伸窗口；消息经 stdin 传输，不再受命令行 ~32K 字符限制

**中文乱码（Windows native 模式）**
- v2.2.0 起脚本输出走 Base64 信封，与系统代码页无关；如仍出现请升级到最新版

## 📋 更新日志

### v2.2.0
- 🔒 **安全加固（browser 后端）**：`/submit` `/cancel` `/timeout` 增加随机会话令牌校验（防本机恶意网页 no-cors 跨站伪造）；Host 头白名单防 DNS rebinding；显式绑定 `127.0.0.1`；修复消息含 `</script>` 时内嵌 JSON 可逃逸脚本块的注入点（`\u003c` 转义）；CSP 增加 `frame-ancestors 'none'` 与 `X-Frame-Options: DENY`
- 🐛 **修复中文响应被截断损坏**：HTTP 提交体改按 Buffer 收集再一次性 UTF-8 解码（原字符串拼接在多字节字符跨 chunk 时产生乱码，>64KB 中文回复会损坏）；native 后端 stdout 同样修复
- 🐛 **修复 Windows native 长消息失败**：消息改经 stdin 传入（原 argv 传参超 ~32K 字符 spawn 失败）；PowerShell 输出改 Base64 信封，修复中文代码页（CP936 等）乱码
- 🐛 **修复 macOS native 响应丢失**：AppleScript `return` 为 CR（`\r`），原按 `\n` 切分导致提交内容恒为空
- 🛡️ **进程稳定性**：子进程 stdin 挂 error 处理（用户秒关对话框不再可能以 EPIPE 击穿整个服务器）；Windows native 增加 Node 侧看门狗（脚本挂起不再永久卡死工具调用）；HTTP 服务结束后强制销毁全部连接（修 keep-alive 句柄/端口泄漏累积）
- ⚙️ **边界控制**：`FEEDBACK_TIMEOUT` 钳制到 [5, 86400] 秒（防超长定时器溢出立即触发）；`message` 增加非空 + 1M 字符上限校验；用户响应 1M 字符截断保护；请求头/请求体超时约束
- 🚦 **并发串行化**：并发的 `interactive_feedback` 调用自动排队（FIFO），一次只弹一个对话框，各自超时独立计算
- 🧹 **纯文本轻量化修复**：`file_name_here` 等下划线标识符不再被斜体规则吞字；`x < 3 and y > 2` 不再被当 HTML 标签删除；代码块内容经占位符保护不被二次处理；Windows native 消息区改为可滚动多行框（支持超长消息）
- 🪟 **窗口自动关闭与晚到窗口收尾**：对话框结束（提交/取消/超时）后窗口自动尝试自行关闭（Chrome/Edge App 窗口实测生效）；本地服务在结束后延迟关停——浏览器冷启动慢或脚本方秒速提交时，"晚到"的窗口会拿到"会话已结束"收尾页并自行关闭，不再停留在"无法访问此网站"错误页且永不关闭；超时/取消同样显示收尾画面
- ✨ **其他**：浏览器启动失败显式报错（不再伪装成"用户取消"误导 AI）；倒计时改绝对时间计算（修后台标签页节流漂移）；中文输入法组词时 Esc/Ctrl+Enter 不再误触发；新增 `FEEDBACK_PORT` 固定端口选项（主题偏好跨会话记忆）；测试套件 71 项 + 真实 E2E 冒烟脚本

### v2.1.0
- 🐛 **修复 browser 提交大文本失败**：去除响应长度 10000 字符硬限制（保留 1MB 防滥用），修复提交 5-10KB 日志报 HTTP 400
- ⏱️ **FEEDBACK_TIMEOUT 改秒单位**：默认 300s（5 分钟），更直观（原为毫秒）
- 🗑️ **移除 FEEDBACK_MAX_TOKENS**：硬截断输入不利正常使用，改由工具描述引导 AI 控制 message 长度
- 🎨 **主题跟随系统**：新增 `FEEDBACK_THEME`（`auto` 默认跟随系统 / `light` / `dark`），手动切换仍可记忆覆盖
- 🔧 **工具描述精简**：减少 token 占用

### v2.0.0
- 🏗️ **可插拔 UI 后端架构**：拆分 `dialog.ts` 为 `core/`（types、markdown、html-template）+ `backends/`（browser-backend、native-backend），统一 `UIBackend` 接口
- ⚡ **native 后端（省内存）**：新增 `FEEDBACK_UI=native`，调用系统原生对话框（Linux zenity / macOS osascript / Windows PowerShell WinForms），内存从约 300MB 降到约 10MB
- 📝 **Markdown 轻量化**：native 后端自动将 Markdown 转可读纯文本（不支持富文本渲染）
- 🔧 **配置**：新增 `FEEDBACK_UI` 环境变量（选填，默认 `browser`，完全向后兼容）
- 📦 **资源**：Windows native 脚本 `assets/native/win-feedback.ps1` 随包分发

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
