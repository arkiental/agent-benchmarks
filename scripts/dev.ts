import { spawn } from 'node:child_process';
import path from 'node:path';

const api = spawn(process.execPath,['--import','tsx','--watch','server/index.ts'],{
  stdio: 'inherit', env: { ...process.env, PUBLIC_URL: 'http://localhost:5173', HOST: '127.0.0.1', PORT: '8787' },
});
const client = spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'),'--host','127.0.0.1'],{ stdio: 'inherit' });
function stop() { api.kill(); client.kill(); }
process.on('SIGINT',stop);
process.on('SIGTERM',stop);
api.on('exit',stop);
client.on('exit',stop);
