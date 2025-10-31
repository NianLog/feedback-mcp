# feedback-mcp-server

A lightweight MCP (Model Context Protocol) server that provides interactive user feedback functionality through browser dialogs with complete Markdown rendering and syntax highlighting.

<p align="center">
  <img alt="Open Source License" src="https://img.shields.io/npm/l/feedback-mcp-server">
  <img alt="Current Version" src="https://img.shields.io/npm/v/feedback-mcp-server">
  <img alt="Downloads" src="https://img.shields.io/npm/dm/feedback-mcp-server">
</p>

## 🌟 Features

<p align="center">
  <img src="https://raw.githubusercontent.com/NianLog/feedback-mcp/main/assets/1.png" alt="MCP Tool Runtime Demo" width="800">
</p>

### 🚀 Core Features

- ✅ **Lightweight Browser Window**: Chrome/Edge App mode, no address bar, low resource usage
- ✅ **Markdown Rendering**: Complete Markdown support with syntax highlighting
- ✅ **Smart Copy**: Support for copying as plain text or Markdown format
- ✅ **Multi-language Interface**: Switch between Chinese and English interfaces
- ✅ **Timeout Control**: Configurable timeout with auto-close
- ✅ **Cross-platform Support**: Windows, macOS, and Linux
- ✅ **Secure & Reliable**: Listens only on localhost, not exposed to public internet

## 📦 Installation

### Method 1: Using npx (Recommended)

No installation required, use directly in Claude Desktop:

```json
{
  "mcpServers": {
    "feedback": {
      "command": "npx",
      "args": ["-y", "feedback-mcp-server@latest"],
      "env": {
        "FEEDBACK_TIMEOUT": "300000",
        "FEEDBACK_MAX_TOKENS": "2000",
        "FEEDBACK_LANGUAGE": "en"
      }
    }
  }
}
```

### Method 2: Global Installation

```bash
npm install -g feedback-mcp-server@latest
```

Configuration:

```json
{
  "mcpServers": {
    "feedback": {
      "command": "feedback-mcp-server",
      "env": {
        "FEEDBACK_TIMEOUT": "300000",
        "FEEDBACK_MAX_TOKENS": "2000",
        "FEEDBACK_LANGUAGE": "en"
      }
    }
  }
}
```

## ⚙️ Configuration

### Environment Variables

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `FEEDBACK_TIMEOUT` | Timeout in milliseconds | 300000 (5 min) |
| `FEEDBACK_MAX_TOKENS` | Maximum output tokens | Unlimited |
| `FEEDBACK_LANGUAGE` | Interface language | en (zh/en available) |

**Recommended Configuration:**
```json
{
  "env": {
    "FEEDBACK_TIMEOUT": "300000",
    "FEEDBACK_MAX_TOKENS": "2000",
    "FEEDBACK_LANGUAGE": "en"
  }
}
```

## 🎯 Usage

AI automatically calls the `interactive_feedback` tool, and the browser opens a dialog to display the message content.

### Tool Parameters

- `message` (required): Message content to display to users, supports full Markdown format

### Return Value

```json
{
  "submitted": boolean,   // Whether user submitted a response
  "response": string,     // User's input content
  "timedOut": boolean     // Whether timeout occurred
}
```

## 🎨 Interface Features

- **Markdown Rendering**: Complete support for code highlighting, tables, lists, etc.
- **Smart Copy**: Support for copying as plain text or Markdown format
- **Keyboard Shortcuts**: `Ctrl + Enter` to submit, `Esc` to cancel
- **Multi-language Interface**: Switch between Chinese and English

## 📝 Usage Examples

### Simple Confirmation

```json
{
  "message": "Do you want to continue with the delete operation? This action is irreversible."
}
```

### Code Review Results

```json
{
  "message": "## Code Review Results\\n\\nFound the following issues:\\n\\n1. **Type Error**\\n   ```typescript\\n   const x: string = 123; // Type mismatch\\n   ```\\n\\n2. **Performance Issues**\\n   - No caching used\\n   - Repeated calculations\\n\\nPlease confirm if you want to fix these issues?"
}
```

## 🛠️ Tech Stack

- **Node.js** + **TypeScript**
- **MCP SDK**: @modelcontextprotocol/sdk
- **Markdown Rendering**: marked + Prism.js

## 📋 System Requirements

- **Node.js** >= 18.0.0
- **Operating System**: Windows 10+ / macOS 10.15+ / Linux
- **Browser**: Chrome or Edge (recommended)

## 🐛 Troubleshooting

**Browser doesn't open**
- Check if Chrome or Edge is installed

**Dialog cannot submit**
- Check network connection and firewall settings

---

<div align="center">
  <sub>
    <p>Made with ❤️ by <a href="https://github.com/NianLog/feedback-mcp">NianLog</a></p>
  </sub>
</div>