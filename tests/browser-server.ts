import fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { passwordHash } from '../server/auth.js';

const scope=path.resolve('.local');await fs.mkdir(scope,{recursive:true});
const dataDir=await fs.mkdtemp(path.join(scope,'browser-test-'));
const port=Number(process.env.BROWSER_TEST_PORT || 8788);
const config=readConfig({ PUBLIC_URL:`http://127.0.0.1:${port}`,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:dataDir,ADMIN_PASSWORD_HASH:await passwordHash('isolated-browser-test-passphrase') });
const {app,store}=createApp(config,undefined,path.resolve(process.env.BROWSER_TEST_CLIENT_DIR || 'dist/client'));
const server=app.listen(port,'127.0.0.1',()=>console.log(`Isolated browser fixture ready on port ${port}.`));
let closing=false;
async function close() { if(closing)return;closing=true;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();if(path.dirname(dataDir)!==scope||!path.basename(dataDir).startsWith('browser-test-'))throw new Error('Unsafe fixture cleanup path.');await fs.rm(dataDir,{recursive:true,force:true}); }
process.on('SIGINT',()=>void close().finally(()=>process.exit(0)));process.on('SIGTERM',()=>void close().finally(()=>process.exit(0)));
server.on('error',error=>{console.error(error.message);void close().finally(()=>{process.exitCode=1;});});
