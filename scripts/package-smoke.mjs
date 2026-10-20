import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMcpSession } from '../test/fixtures/mcp-session.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const checkOnly = process.argv.includes('--check');
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run through npm run test:package or npm pack');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-mcp-package-'));
function npm(args, cwd = root) {
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 180000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
try {
  assert.equal(
    fs.readFileSync(path.join(root, 'assets/prism/prism.js'), 'utf8').replace(/\r\n/g, '\n'),
    fs.readFileSync(path.join(root, 'node_modules/prismjs/prism.js'), 'utf8').replace(/\r\n/g, '\n'),
    'Bundled Prism must match the locked dependency; update the offline asset when updating Prism'
  );
  const [packed] = JSON.parse(npm(['pack', '--ignore-scripts', '--json',
    ...(checkOnly ? ['--dry-run'] : ['--pack-destination', temporary])]));
  const files = new Set(packed.files.map(file => file.path));
  for (const required of ['dist/index.js', 'dist/core/markdown-render.js', 'dist/core/markdown-worker.mjs',
    'dist/core/markdown-renderer.mjs', 'dist/core/markdown-plain.mjs', 'assets/native/win-feedback.ps1', 'assets/prism/prism.js',
    'assets/prism/prism-tomorrow.min.css', 'assets/prism/components/prism-typescript.js', 'LICENSE']) {
    assert.ok(files.has(required), `Package is missing ${required}`);
  }
  assert.ok(![...files].some(file => /^(?:src|test|\.github|\.agents)\//.test(file)), 'Package must contain runtime files only');
  console.log(`Package contents verified: ${files.size} files`);
  if (!checkOnly) {
    const consumer = path.join(temporary, 'consumer');
    fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temporary, packed.filename)], consumer);
    const entry = path.join(consumer, 'node_modules', 'feedback-mcp-server', 'dist', 'index.js');
    assert.ok(!fs.existsSync(path.join(consumer, 'node_modules', '@modelcontextprotocol', 'sdk')), 'v1 SDK must stay out of runtime dependencies');
    for (const modern of [false, true]) {
      const session = await startMcpSession(entry, { modern });
      try {
        const tools = await session.client.listTools();
        const tool = tools.tools.find(tool => tool.name === 'interactive_feedback');
        assert.ok(tool);
        if (!modern) {
          assert.equal(session.client.getServerVersion()?.version, JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
        }
        assert.equal(tool.inputSchema.properties.message.maxLength, 1000000);
        const invalid = await session.client.callTool({ name: tool.name, arguments: { message: '' } });
        assert.equal(invalid.isError, true);
        const tooLong = await session.client.callTool({ name: tool.name, arguments: { message: 'x'.repeat(1000001) } });
        assert.equal(tooLong.isError, true);
        const call = session.client.callTool({ name: tool.name, arguments: { message: '# Package smoke\n\n**离线资源**' } });
        const dialog = await session.dialog();
        assert.ok(dialog.html.includes('<strong>离线资源</strong>'), 'Installed Worker must render Markdown successfully');
        const assets = [...dialog.html.matchAll(/(?:src|href)="(\/prism\/[^\"]+)"/g)].map(match => match[1]);
        assert.ok(assets.length >= 17);
        for (const asset of assets) {
          const response = await fetch(dialog.url + asset);
          assert.equal(response.status, 200, asset);
          await response.arrayBuffer();
        }
        const reply = 'Package smoke: 中文\nsecond line ✓';
        const submitted = await fetch(dialog.url + '/submit', {
          method: 'POST', headers: { 'X-Feedback-Token': dialog.token }, body: JSON.stringify({ response: reply }),
        });
        assert.equal(submitted.status, 200);
        assert.deepEqual((await call).structuredContent, { submitted: true, response: reply, timedOut: false });
        console.log(`Installed tarball verified (${modern ? 'v2 modern' : 'v1 legacy'}): Worker, MCP, input bounds, all Prism assets, UTF-8 feedback`);
      } finally { await session.close(); }
      const native = await startMcpSession(entry, { modern, env: { FEEDBACK_UI: 'native', FEEDBACK_TEST_NATIVE_ECHO: '1' } });
      try {
        const result = await native.callTool({ name: 'interactive_feedback', arguments: { message: '**原生中文 ✓**' } });
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.response, '原生中文 ✓');
        console.log(`Installed tarball verified (${modern ? 'v2 modern' : 'v1 legacy'}): native Worker and UTF-8 feedback`);
      } finally { await native.close(); }
    }
    assert.equal(path.basename(packed.filename), packed.filename);
    const archive = path.join(root, 'tmp', 'feedback-release');
    fs.mkdirSync(archive, { recursive: true });
    fs.copyFileSync(path.join(temporary, packed.filename), path.join(archive, packed.filename));
    console.log(`Verified tarball saved: ${path.join(archive, packed.filename)}`);
  }
} finally {
  const target = fs.realpathSync(temporary);
  assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('feedback-mcp-package-'));
  fs.rmSync(target, { recursive: true, force: true });
}
