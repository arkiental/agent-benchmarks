import fs from 'node:fs/promises';
import path from 'node:path';
import { passwordHash } from '../server/auth.js';

function hidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Run this command in an interactive local terminal. Password input is never accepted in command arguments.');
  return new Promise((resolve,reject) => {
    process.stdout.write(question);
    let input = '';
    process.stdin.setRawMode(true); process.stdin.resume();
    function finish() { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.removeListener('data',onData); process.stdout.write('\n'); }
    function onData(chunk: Buffer) {
      for (const character of chunk.toString('utf8')) {
        if (character==='\u0003') { finish(); reject(new Error('Cancelled.')); return; }
        if (character==='\r' || character==='\n') { finish(); resolve(input); return; }
        if (character==='\u007f' || character==='\b') input=input.slice(0,-1);
        else if (character>=' ' && input.length<256) input+=character;
      }
    }
    process.stdin.on('data',onData);
  });
}
try {
  const target = path.resolve('.env');
  const first = await hidden('Owner password (16+ characters; hidden): ');
  const second = await hidden('Repeat password (hidden): ');
  if (first!==second) throw new Error('Passwords did not match. No changes made.');
  const hash = await passwordHash(first);
  let env: string;
  try { env=await fs.readFile(target,'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; env=await fs.readFile('.env.example','utf8'); }
  const line = `ADMIN_PASSWORD_HASH='${hash}'`;
  const next = /^ADMIN_PASSWORD_HASH=.*$/m.test(env) ? env.replace(/^ADMIN_PASSWORD_HASH=.*$/m,line) : `${env.trimEnd()}\n${line}\n`;
  await fs.writeFile(target,next,{ mode: 0o600 });
  console.log('Owner password configured in local .env. Restart the server. Existing owner sessions will expire.');
} catch (error) { console.error((error as Error).message); process.exitCode=1; }
