// Tiny stdio MCP client: node scripts/call.mjs <tool> '<json args>'  (no args = list tools)
import { spawn } from 'node:child_process';
const [tool, args = '{}'] = process.argv.slice(2);
const p = spawn('node', [new URL('../server.ts', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'inherit'] });
const send = m => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
let buf = '';
p.stdout.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (msg.id === 1) { send({ method: 'notifications/initialized' }); send(tool ? { id: 2, method: 'tools/call', params: { name: tool, arguments: JSON.parse(args) } } : { id: 2, method: 'tools/list' }); }
    if (msg.id === 2) {
      const r = msg.result;
      console.log(r?.tools ? r.tools.map(t => `${t.name}${t.annotations?.readOnlyHint ? ' (ro)' : ''}: ${Object.keys(t.inputSchema.properties || {}).join(',')}`).join('\n') : (r?.isError ? 'ERROR: ' : '') + (r?.content?.[0]?.text ?? JSON.stringify(msg.error)));
      p.kill();
    }
  }
});
send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
