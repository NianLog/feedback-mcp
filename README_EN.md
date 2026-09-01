# feedback-mcp-server v2.2.0

A lightweight MCP (Model Context Protocol) server that provides interactive user feedback functionality through browser dialogs with complete Markdown rendering and syntax highlighting.

<p align="center">
  <img alt="Open Source License" src="https://img.shields.io/npm/l/feedback-mcp-server">
  <img alt="Current Version" src="https://img.shields.io/npm/v/feedback-mcp-server">
  <img alt="Downloads" src="https://img.shields.io/npm/dm/feedback-mcp-server">
</p>

## 🌟 Features

<p align="center">
  <img src="./assets/1.png" alt="MCP Tool Runtime Demo" width="800">
</p>

### 🚀 Core Features

- ✅ **Lightweight Browser Window**: Chrome/Edge App mode, no address bar, low resource usage
- ✅ **Markdown Rendering**: Complete Markdown support with syntax highlighting
- ✅ **Fully Offline**: Prism syntax highlighting bundled locally; works without network or CDN
- ✅ **Pluggable UI Backend**: rich-text browser by default; set `FEEDBACK_UI=native` to use the system native dialog (~10MB RAM, plain text)
- ✅ **Security Hardening**: HTML sanitization (sanitize-html) + CSP against XSS, inline-JSON script-breakout escaping, per-session token + Host validation against cross-site forgery and DNS rebinding, loopback-only listener (127.0.0.1)
- ✅ **Concurrency Safe**: concurrent dialog calls are queued and shown one at a time
- ✅ **Smart Copy**: Support for copying as plain text or Markdown format
- ✅ **Multi-language Interface**: Switch between Chinese and English interfaces
- ✅ **Timeout Control**: Configurable timeout with auto-close; timeout and cancellation are semantically separated for accurate AI judgment
- ✅ **Auto-close Window**: The dialog window closes itself after submit/cancel/timeout; a "late" window (slow browser cold start) receives a "Session ended" page and closes itself instead of being stuck on a load-error page
- ✅ **Multi-browser Support**: Chrome / Edge (App mode), Firefox / Safari (regular window)
- ✅ **Cross-platform Support**: Windows, macOS, and Linux

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
        "FEEDBACK_TIMEOUT": "300",
        "FEEDBACK_LANGUAGE": "en",
        "FEEDBACK_THEME": "auto"
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
        "FEEDBACK_TIMEOUT": "300",
        "FEEDBACK_LANGUAGE": "en",
        "FEEDBACK_THEME": "auto"
      }
    }
  }
}
```

## ⚙️ Configuration

### Environment Variables

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `FEEDBACK_TIMEOUT` | Dialog timeout in seconds (invalid → 300; valid values clamped to [5, 86400] = 1 day) | 300 (5 min) |
| `FEEDBACK_LANGUAGE` | Interface language (only `zh` / `en`; invalid values fall back to `zh`) | zh |
| `FEEDBACK_UI` | UI backend (optional): `browser` (rich text) / `native` (system dialog, ~10MB) / `auto` (prefer native, fall back to browser) | browser |
| `FEEDBACK_THEME` | Theme (optional): `auto` (follow system) / `light` / `dark`; manual toggle is remembered | auto |
| `FEEDBACK_PORT` | Browser backend port (optional): `0` = random (default); a fixed port makes the theme preference persist across sessions | 0 (random) |

**Recommended Configuration:**
```json
{
  "env": {
    "FEEDBACK_TIMEOUT": "300",
    "FEEDBACK_LANGUAGE": "en",
    "FEEDBACK_THEME": "auto"
  }
}
```

## 🎯 Usage

AI automatically calls the `interactive_feedback` tool, and the browser opens a dialog to display the message content.

### Tool Parameters

- `message` (required): Message content to display to users, supports full Markdown format; must be non-empty and ≤ 1,000,000 characters (oversized input gets a clear validation error instead of a dialog)

### Return Value

```json
{
  "submitted": boolean,   // Whether user submitted a response
  "response": string,     // User's input content
  "timedOut": boolean,    // Whether timeout occurred (distinct from cancellation)
  "error": string         // Error description when the dialog could not be shown (e.g. browser launch failure); also returned with isError
}
```

> Semantics: `submitted=false` without `error` means the user cancelled or it timed out; an `error` field means the dialog itself failed (AI must not misread it as a user cancellation).

## 🔒 Boundaries & Security

- **Input limits**: `message` non-empty and ≤ 1M chars; HTTP submit body ≤ 1MB; user responses capped at 1M chars (truncated with an explicit marker)
- **Timeout bounds**: clamped to [5s, 86400s], eliminating timer-overflow instant-fires
- **XSS defense in depth**: sanitize-html allowlist + CSP + nosniff + `X-Frame-Options: DENY` + `</script>` escaping for embedded JSON
- **Local server hardening**: binds `127.0.0.1` only; `/submit` `/cancel` `/timeout` require the per-session token held by the page (blocks cross-site forgery from other local web pages); Host header allowlist (blocks DNS rebinding); path-traversal protection for Prism assets
- **Process stability**: all child stdin/stdout errors are handled (instantly closing the dialog can no longer crash the server); the HTTP server destroys all connections after completion (no port/handle leaks)
- **Window lifecycle**: the window closes itself when the dialog ends (submit/cancel/timeout); a window that arrives "late" (slow browser cold start) is served a "Session ended" page and closes itself instead of lingering on a load-error page
- **Concurrency**: concurrent tool calls are FIFO-queued; only one dialog is shown at a time

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
- **Markdown Rendering**: marked + Prism.js (bundled locally, offline-capable)
- **Security Sanitization**: sanitize-html (strips scripts/event handlers, prevents XSS)

## 🧪 Development & Testing

```bash
npm install
npm run build      # compile TypeScript to dist/
npm test           # unit + integration tests (71 cases: HTTP protocol, security, resource release)
npm run test:e2e   # end-to-end smoke (real MCP handshake + real windows, briefly shows dialogs)
```

## 📋 System Requirements

- **Node.js** >= 18.2.0
- **Operating System**: Windows 10+ / macOS 10.15+ / Linux
- **Browser**: Chrome or Edge (recommended, App mode); Firefox / Safari also supported (regular window mode)
- **Native backend**: Windows requires PowerShell (built-in); Linux requires zenity; macOS uses the built-in osascript

## 🐛 Troubleshooting

**Browser doesn't open**
- Check if Chrome, Edge, Firefox, or Safari is installed
- The tool returns a result with `error` (and `isError: true`); the AI can fall back to asking in plain text

**Firefox / Safari window shows an address bar**
- These browsers do not support App mode and open as a regular window; this is expected

**Dialog cannot submit**
- Check whether loopback 127.0.0.1 is blocked by a firewall/security software

**Window doesn't close automatically**
- Chrome/Edge app windows close themselves; Firefox/Safari regular windows may refuse script-initiated close — the window then stays on a "Session ended" hint page; close it manually (browser security policy, not a bug)

**Long messages clipped in native mode**
- Since v2.2.0 the message area is a scrollable multiline box and the window is resizable; messages travel via stdin and are no longer limited by the ~32K command-line length

**Mojibake in Chinese (Windows native mode)**
- Since v2.2.0 the script output uses a Base64 envelope, independent of the system codepage; if you still see it, upgrade to the latest version

## 📋 Changelog

### v2.2.0
- 🪟 **Auto-close & late-window finalization**: the window attempts to close itself when the dialog ends (verified in Chrome/Edge app windows); the local server shuts down with a delay after the session ends — if the browser was still cold-starting (or a script submitted instantly), the late-loading window receives a "Session ended" page and closes itself instead of being stuck forever on a connection-refused error page; timeout/cancel also show a final screen
- 🔒 **Security hardening (browser backend)**: `/submit` `/cancel` `/timeout` now require a random per-session token (blocks no-cors cross-site forgery from other local web pages); Host header allowlist blocks DNS rebinding; explicit `127.0.0.1` binding; fixed a script-block breakout where a message containing `</script>` could escape the embedded JSON (`\u003c` escaping); CSP gains `frame-ancestors 'none'` and `X-Frame-Options: DENY`
- 🐛 **Fixed corrupted CJK responses**: HTTP submit bodies are now collected as Buffers and decoded once as UTF-8 (the old per-chunk string concat corrupted multibyte characters across chunk boundaries, breaking Chinese replies >64KB); native backend stdout fixed the same way
- 🐛 **Fixed Windows native failure on long messages**: messages now travel via stdin (argv passing failed beyond ~32K chars); PowerShell output switched to a Base64 envelope, fixing mojibake on CJK codepages (CP936 etc.)
- 🐛 **Fixed macOS native responses being lost**: AppleScript `return` is CR (`\r`); the old `\n`-based splitting always yielded an empty response
- 🛡️ **Process stability**: child stdin error handlers (instantly closing the dialog can no longer crash the whole server via EPIPE); Node-side watchdog for the Windows native dialog (a hung script no longer blocks the tool call forever); the HTTP server force-destroys all connections after completion (fixes keep-alive handle/port leak accumulation)
- ⚙️ **Boundary controls**: `FEEDBACK_TIMEOUT` clamped to [5, 86400] seconds (prevents timer-overflow instant fires); `message` validated non-empty and ≤ 1M chars; responses capped at 1M chars; request header/body timeouts
- 🚦 **Concurrency serialization**: concurrent `interactive_feedback` calls are FIFO-queued — one dialog at a time, each with its own independent timeout
- 🧹 **Plain-text flattening fixes**: underscore identifiers like `file_name_here` are no longer eaten by emphasis rules; `x < 3 and y > 2` is no longer deleted as an HTML tag; code-block content is placeholder-protected from re-processing; the Windows native message area is now a scrollable multiline box
- ✨ **Others**: browser launch failures now surface as explicit errors (no longer disguised as "user cancelled"); the countdown is deadline-based (fixes background-tab throttling drift); Esc/Ctrl+Enter no longer fire during IME composition; new `FEEDBACK_PORT` option for a fixed port (persistent theme preference); 71-case test suite + real E2E smoke script

### v2.1.0
- 🐛 **Fixed browser submit with large text**: removed the 10000-char response length cap (kept 1MB abuse limit) — submitting 5-10KB logs no longer fails with HTTP 400
- ⏱️ **FEEDBACK_TIMEOUT now in seconds**: default 300s (5 min), more intuitive (was milliseconds)
- 🗑️ **Removed FEEDBACK_MAX_TOKENS**: hard input truncation hurt normal usage; AI now controls message length via tool description
- 🎨 **Theme follows system**: added `FEEDBACK_THEME` (`auto` default follows system / `light` / `dark`); manual toggle still remembered
- 🔧 **Leaner tool description**: reduced token usage

### v2.0.0
- 🏗️ **Pluggable UI backend architecture**: split `dialog.ts` into `core/` (types, markdown, html-template) + `backends/` (browser-backend, native-backend) behind a unified `UIBackend` interface
- ⚡ **Native backend (low memory)**: new `FEEDBACK_UI=native` invokes the system native dialog (Linux zenity / macOS osascript / Windows PowerShell WinForms), cutting memory from ~300MB to ~10MB
- 📝 **Markdown flattening**: the native backend auto-converts Markdown to readable plain text (no rich-text rendering)
- 🔧 **Config**: new `FEEDBACK_UI` env var (optional, defaults to `browser`, fully backward compatible)
- 📦 **Assets**: Windows native script `assets/native/win-feedback.ps1` bundled

### v1.2.0
- 🎨 **UI Redesign**: Removed blue-purple gradients and emojis; adopted a graphite-minimal style (neutral gray + green accent); dark theme switched to neutral graphite
- 🔒 **Security Hardening**: Added sanitize-html to sanitize Markdown output against XSS; error messages switched to textContent; added CSP / nosniff / Referrer-Policy security headers
- 🐛 **Correctness Fixes**: Unified HTTP response handling to eliminate duplicate-write races; timeout now uses a dedicated endpoint, fixing the lost `timedOut` flag; fixed broken copy buttons in Firefox; submit/cancel reentrancy guards
- 🛠️ **Reliability**: Removed the unreliable Windows `start chrome` path and unified browser detection; fixed `path`/`process` variable shadowing; version now injected from package.json
- 📦 **Fully Offline**: Prism syntax highlighting bundled locally (curated common languages); removed all CDN dependencies; works without network
- 🌐 **Engineering**: Completed "submitting/processing" i18n; `FEEDBACK_TIMEOUT` lower-bound validation, `FEEDBACK_LANGUAGE` restricted to zh/en; upgraded dependencies to fix 7 security vulnerabilities

### v1.1.2
- Enhanced error handling and retry mechanism
- Added theme switching, window position memory, shortcut hints
- Enhanced browser compatibility (Safari/Firefox support)

---

<div align="center">
  <sub>
    <p>Made with ❤️ by <a href="https://github.com/NianLog/feedback-mcp">NianLog</a></p>
  </sub>
</div>
