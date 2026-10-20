import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const spawn = childProcess.spawn;
childProcess.spawn = (command, args = [], options) => {
  if (process.env.FEEDBACK_TEST_NATIVE_ECHO === '1' &&
      (['zenity', 'osascript'].includes(command) || args.some(arg => String(arg).endsWith('win-feedback.ps1')))) {
    console.error('[feedback-mcp-test] Native process started');
    const format = command === 'zenity' ? 'linux' : command === 'osascript' ? 'mac' : 'windows';
    const script = `const chunks=[];process.stdin.on('data',chunk=>chunks.push(chunk));process.stdin.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');process.stdout.write(${JSON.stringify(format)}==='windows'?'B64:'+Buffer.from(JSON.stringify({status:'submitted',response:text})).toString('base64'):${JSON.stringify(format)}==='mac'?'submitted\\r'+text:text);});`;
    return spawn(process.execPath, ['-e', script], options);
  }
  const encoded = args.indexOf('-EncodedCommand');
  const text = encoded >= 0 ? Buffer.from(args[encoded + 1], 'base64').toString('utf16le') : args.join(' ');
  if (text.includes('http://127.0.0.1:')) {
    if (process.env.FEEDBACK_TEST_FAIL_LAUNCH === '1') throw new Error('controlled launcher failure');
    if (process.env.FEEDBACK_TEST_FAIL_LAUNCH === 'async') {
      return spawn(fileURLToPath(new URL('./missing-browser-launcher', import.meta.url)), [], options);
    }
    const child = new EventEmitter();
    child.pid = 1;
    child.unref = () => {}; child.kill = () => true;
    queueMicrotask(() => child.emit('spawn'));
    return child;
  }
  return spawn(command, args, options);
};
syncBuiltinESMExports();
