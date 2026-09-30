import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import net from 'node:net';
import assert from 'node:assert/strict';

const label='agent-benchmarks-smoke-'+randomUUID().slice(0,8),container=label+'-app',data=label+'-data',backups=label+'-backups';
const image=process.env.DOCKER_TEST_IMAGE || 'agent-benchmarks:local';
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',maxBuffer:4*1024*1024,timeout:120000,windowsHide:true});
const port=await new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});});
const origin=`http://127.0.0.1:${port}`,mounts=['-v',`${data}:/app/storage`,'-v',`${backups}:/app/backups`];
const oneOff=(...command)=>docker('run','--rm','--label',`fixture=${label}`,...mounts,image,...command);
async function ready(){for(let i=0;i<40;i++){try{const response=await fetch(origin+'/healthz');if(response.ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,250));}throw new Error('Docker health check did not become ready.');}
const digest=buffer=>createHash('sha256').update(buffer).digest('hex');
function removeOwned(type,name){if(!name.startsWith(label+'-'))throw new Error('Unsafe fixture cleanup name.');const details=JSON.parse(docker(type==='container'?'inspect':'volume',...(type==='container'?[name]:['inspect',name])))[0];const labels=type==='container'?details.Config.Labels:details.Labels;if(labels?.fixture!==label)throw new Error('Fixture ownership label missing.');docker(type==='container'?'rm':'volume',...(type==='container'?['-f',name]:['rm',name]));}
let createdContainer=false,createdData=false,createdBackups=false;
try{
  docker('volume','create','--label',`fixture=${label}`,data);createdData=true;docker('volume','create','--label',`fixture=${label}`,backups);createdBackups=true;
  oneOff('node','dist/scripts/seed.js');
  oneOff('node','--input-type=module','-e',`import {execFileSync} from 'node:child_process';import fs from 'node:fs';import {Store} from './dist/server/db.js';import {readConfig} from './dist/server/config.js';import {mediaService} from './dist/server/media.js';const config=readConfig();const store=new Store(config.dataDir);const file='/app/storage/fixture.mp4';execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=white:s=160x120:r=10','-t','1','-c:v','libx264','-pix_fmt','yuv420p','-threads','1','-movflags','+faststart','-y',file]);try{const video=await mediaService(store,config).uploadVideo(file,'fixture-timelapse.mp4');const row=store.db.prepare('SELECT * FROM posts ORDER BY id LIMIT 1').get();const post=store.post(row);store.save({...post,showcaseMediaIds:[video.id],progress:[{mediaId:video.id,label:'Docker fixture timelapse',elapsedSeconds:null}]},post.id);console.log('Docker MP4 processing passed.');}finally{fs.unlinkSync(file);store.close();}`);
  docker('run','-d','--name',container,'--label',`fixture=${label}`,'--init','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=64m','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory','768m','--cpus','2','-e',`PUBLIC_URL=${origin}`,'-p',`127.0.0.1:${port}:8787`,...mounts,image);createdContainer=true;await ready();
  const listing=await(await fetch(origin+'/api/posts')).json();assert.equal(listing.total,3);const coverUrl=listing.posts[0].cover.url;
  const cover=await(await fetch(origin+coverUrl)).arrayBuffer(),coverHash=digest(Buffer.from(cover));
  docker('stop',container);const backupOutput=oneOff('node','dist/scripts/backup.js','/app/backups','--stopped');const snapshot=backupOutput.match(/\/app\/backups\/snapshot-[\w.-]+/)?.[0];assert.ok(snapshot,'Backup CLI returned a snapshot path.');
  oneOff('node','--input-type=module','-e',`import {Store} from './dist/server/db.js';const store=new Store(process.env.DATA_DIR);const post=store.db.prepare('SELECT * FROM posts ORDER BY id LIMIT 1').get();store.deletePost(post.id,post.revision);store.close();`);
  docker('start',container);await ready();assert.equal((await(await fetch(origin+'/api/posts')).json()).total,2);docker('stop',container);
  oneOff('node','dist/scripts/restore.js',snapshot,'--stopped');
  removeOwned('container',container);createdContainer=false;
  docker('run','-d','--name',container,'--label',`fixture=${label}`,'--init','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=64m','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory','768m','--cpus','2','-e',`PUBLIC_URL=${origin}`,'-p',`127.0.0.1:${port}:8787`,...mounts,image);createdContainer=true;await ready();
  const restored=await(await fetch(origin+'/api/posts')).json();assert.equal(restored.total,3);assert.equal(digest(Buffer.from(await(await fetch(origin+coverUrl)).arrayBuffer())),coverHash);
  let videoChecked=false;for(const post of restored.posts){const detail=await(await fetch(origin+'/api/posts/'+post.slug)).json();const video=Object.values(detail.media).find(item=>item.kind==='video');if(video){const playback=await fetch(origin+video.url,{headers:{Range:'bytes=0-31'}});assert.equal(playback.status,206);assert.equal(playback.headers.get('content-type'),'video/mp4');videoChecked=true;}}
  assert.ok(videoChecked,'The restored MP4 remains published and playable.');const status=JSON.parse(docker('inspect',container))[0];assert.equal(status.Config.User,'node');assert.equal(status.HostConfig.ReadonlyRootfs,true);
  console.log(JSON.stringify({docker:'passed',health:'ok',persistentPosts:3,mediaHashMatches:true,mp4ProcessingAndRestore:true,containerReplacement:true,nonRoot:true,readOnlyRoot:true,fixture:label}));
}finally{
  if(createdContainer)removeOwned('container',container);if(createdData)removeOwned('volume',data);if(createdBackups)removeOwned('volume',backups);
}
