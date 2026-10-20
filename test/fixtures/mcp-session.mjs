import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

function sessionTransport(entry, TransportClass, env = {}) {
  const transport = new TransportClass({
    command: process.execPath,
    args: ['--import', new URL('./launcher-stub.mjs', import.meta.url).href,
      ...(entry.endsWith('.ts') ? ['--import', 'tsx'] : []), entry],
    env: { ...getDefaultEnvironment(), FEEDBACK_UI: 'browser', FEEDBACK_TIMEOUT: '10', FEEDBACK_PORT: '0', ...env },
    stderr: 'pipe',
  });
  let logs = '';
  transport.stderr.on('data', chunk => { logs += chunk.toString(); });
  const urls = () => [...logs.matchAll(/Dialog opened at (http:\/\/127\.0\.0\.1:\d+)/g)].map(match => match[1]);
  async function waitFor(pattern) {
    const started = Date.now();
    while (!pattern.test(logs)) {
      if (Date.now() - started > 5000) throw new Error(`Missing server log: ${pattern}\n${logs}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  return { transport, urls, waitFor, logs: () => logs,
    async dialog(index = 0) {
      const started = Date.now();
      while (!urls()[index]) {
        if (Date.now() - started > 5000) throw new Error('Missing dialog URL\n' + logs);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const url = urls()[index];
      const html = await (await fetch(url)).text();
      const token = html.match(/const FEEDBACK_TOKEN = "([^"]+)";/)?.[1];
      if (!token) throw new Error('Active dialog token missing');
      return { url, token, html };
    },
  };
}

export async function startMcpSession(entry, options = {}) {
  const ClientClass = options.modern ? (await import('@modelcontextprotocol/client')).Client : Client;
  const TransportClass = options.modern ? (await import('@modelcontextprotocol/client/stdio')).StdioClientTransport : StdioClientTransport;
  const session = sessionTransport(entry, TransportClass, options.env);
  const client = new ClientClass({ name: 'regression-test', version: '1.0.0' }, {
    capabilities: {}, ...(options.modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}),
  });
  try { await client.connect(session.transport); }
  catch (error) { await client.close(); throw new Error(`${error.message}\n${session.logs()}`); }
  return { ...session, client, close: () => client.close(),
    callTool: (params, requestOptions) => (options.modern
      ? client.callTool(params, requestOptions) : client.callTool(params, undefined, requestOptions)
    ).catch(error => { error.message += '\n' + session.logs(); throw error; }),
  };
}

export async function startRawMcpSession(entry, revision, probeModern = false) {
  const session = sessionTransport(entry, StdioClientTransport);
  const pending = new Map();
  let nextId = 0;
  session.transport.onmessage = message => pending.get(message.id)?.(message);
  const request = async (method, params = {}) => {
    const id = ++nextId;
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Raw request timeout: ' + method + '\n' + session.logs())); }, 5000);
      pending.set(id, message => { clearTimeout(timer); pending.delete(id); resolve(message); });
    });
    await session.transport.send({ jsonrpc: '2.0', id, method, params });
    return reply;
  };
  await session.transport.start();
  if (probeModern) await request('server/discover', { _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'legacy-wire-test', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {},
  } });
  const initialized = await request('initialize', { protocolVersion: revision, capabilities: {}, clientInfo: { name: 'legacy-wire-test', version: '1' } });
  await session.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return { ...session, initialized, request, close: () => session.transport.close() };
}
