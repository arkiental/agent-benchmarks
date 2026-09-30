import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { Store } from '../server/db.js';
import { readConfig } from '../server/config.js';
import { mediaService } from '../server/media.js';
import { createBackup,restoreBackup,verifyBackup } from '../server/maintenance.js';
import { fixtureVideo } from './fixtures.js';

async function fixture(run: (root:string,source:string) => Promise<void>) {
  const scope=path.resolve('.local'); await fs.mkdir(scope,{ recursive:true });
  const root=await fs.mkdtemp(path.join(scope,'backup-test-')),source=path.join(root,'source');
  const store=new Store(source),config=readConfig({ DATA_DIR:source });
  const image=await mediaService(store,config).upload(await sharp({ create:{ width:40,height:30,channels:3,background:'#fff' } }).png().toBuffer(),'fixture.png','image/png');
  store.save({ title:'Backup fixture',slug:'backup-fixture',summary:'',category:'Other',prompt:'Automated backup fixture.',body:'',status:'draft',isDemo:true,coverId:image.id,runs:[],progress:[] });
  store.db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run('fixture-token-hash','fixture-csrf',Date.now()+60000,'fixture-auth-revision'); store.close();
  try { await run(root,source); }
  finally { assert.ok(root.startsWith(scope+path.sep)); await fs.rm(root,{ recursive:true,force:true }); }
}
test('backup and restore preserve posts/images, exclude sessions and retain previous data',async () => fixture(async (root,source) => {
  const backup=await createBackup(source,path.join(root,'backups'),true); const manifest=await verifyBackup(backup.directory);
  assert.equal(manifest.posts,1); assert.equal(manifest.media,1); assert.equal(manifest.files.length,3);
  const target=path.join(root,'restored'); const old=new Store(target); old.close(); await fs.writeFile(path.join(target,'previous-marker'),'retained');
  const restored=await restoreBackup(backup.directory,target,true); assert.ok(restored.retained); assert.equal(await fs.readFile(path.join(restored.retained!,'previous-marker'),'utf8'),'retained');
  const store=new Store(target);
  try { assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM posts').get() as { count:number }).count,1); assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count:number }).count,0); assert.equal((await fs.readdir(store.uploads)).length,2); }
  finally { store.close(); }
}));
test('corrupt backups fail before modifying the restore target',async () => fixture(async (root,source) => {
  const backup=await createBackup(source,path.join(root,'backups'),true),target=path.join(root,'target');
  await fs.mkdir(target); await fs.writeFile(path.join(target,'marker'),'unchanged');
  const media=backup.manifest.files.find(file => file.path.startsWith('uploads/'))!; await fs.appendFile(path.join(backup.directory,media.path),'corrupt');
  await assert.rejects(restoreBackup(backup.directory,target,true),/verification failed/);
  assert.equal(await fs.readFile(path.join(target,'marker'),'utf8'),'unchanged');
}));
test('maintenance requires a stopped-server acknowledgment and rejects traversal manifests',async () => fixture(async (root,source) => {
  await assert.rejects(createBackup(source,path.join(root,'backups'),false),/Stop the application/);
  const backup=await createBackup(source,path.join(root,'backups'),true);
  await assert.rejects(restoreBackup(backup.directory,path.join(root,'target'),false),/Stop the application/);
  const manifest={ ...backup.manifest,files:[...backup.manifest.files,{ path:'../private.env',bytes:0,sha256:'0'.repeat(64) }] };
  await fs.writeFile(path.join(backup.directory,'manifest.json'),JSON.stringify(manifest)); await assert.rejects(verifyBackup(backup.directory),/Invalid backup file list/);
}));
test('unsupported database migrations are refused without modifying the database',async () => fixture(async (_root,source) => {
  const store=new Store(source); store.db.pragma('user_version = 5'); store.close(); assert.throws(() => new Store(source),/newer than this application/);
}));

test('MP4s, optional metrics and separate galleries survive a verified backup and restore',async()=>fixture(async(root,source)=>{
  const file=await fixtureVideo(root),store=new Store(source),config=readConfig({DATA_DIR:source});
  const video=await mediaService(store,config).uploadVideo(file,'fixture-timelapse.mp4');const row=store.db.prepare('SELECT * FROM posts LIMIT 1').get() as ReturnType<Store['getPost']>;
  const post=store.post(row!);store.save({...post,showcaseMediaIds:[video.id],progress:[{mediaId:video.id,label:'Fixture video',elapsedSeconds:null}],runs:[{model:'Fixture model',harness:'',author:'',elapsedSeconds:null,reasoningEffort:'High',tokens:42,estimatedCostUsd:0.01,outcome:'Completed',notes:'Fixture only.',conditions:'',resultMediaIds:[video.id]}]},post.id);store.close();
  const backup=await createBackup(source,path.join(root,'backups'),true);assert.equal(backup.manifest.media,2);assert.ok(backup.manifest.files.some(file=>file.path.endsWith('.mp4')));
  const target=path.join(root,'restored-video');await restoreBackup(backup.directory,target,true);const restored=new Store(target);
  try{const saved=restored.post(restored.getPost(post.id)!);assert.deepEqual(saved.showcaseMediaIds,[video.id]);assert.equal(saved.progress[0].label,'Fixture video');assert.equal(saved.runs[0].tokens,42);assert.equal(saved.media[video.id].kind,'video');assert.equal(saved.media[video.id].durationSeconds,1);}finally{restored.close();}
}));

test('version-one data and backups migrate without losing posts or images',async()=>fixture(async(root,source)=>{
  const legacy=new Store(source);legacy.db.exec('ALTER TABLE posts DROP COLUMN collections_json; DROP INDEX posts_group; ALTER TABLE posts DROP COLUMN group_id; ALTER TABLE posts DROP COLUMN references_json; ALTER TABLE runs DROP COLUMN provider; ALTER TABLE runs DROP COLUMN custom_provider; DROP TABLE comparison_groups; DROP TABLE idempotency; DROP TABLE agent_tokens; ALTER TABLE posts DROP COLUMN showcase_json; ALTER TABLE media DROP COLUMN kind; ALTER TABLE media DROP COLUMN duration_seconds; ALTER TABLE runs DROP COLUMN reasoning_effort; ALTER TABLE runs DROP COLUMN tokens; ALTER TABLE runs DROP COLUMN estimated_cost_usd; PRAGMA user_version = 1;');legacy.close();
  const backup=await createBackup(source,path.join(root,'backups'),true);assert.equal(backup.manifest.schemaVersion,1);
  const target=path.join(root,'restored-legacy');await restoreBackup(backup.directory,target,true);const migrated=new Store(target);
  try{assert.equal(migrated.db.pragma('user_version',{simple:true}),4);const post=migrated.post(migrated.db.prepare('SELECT * FROM posts LIMIT 1').get() as NonNullable<ReturnType<Store['getPost']>>);assert.equal(post.title,'Backup fixture');assert.deepEqual(post.showcaseMediaIds,[]);assert.deepEqual(post.references,[]);assert.equal(post.groupId,null);assert.equal(Object.values(post.media)[0].kind,'image');}finally{migrated.close();}
}));

test('version-two migration preserves references-ready data and version-three backups remove agent access',async()=>fixture(async(root,source)=>{
  const store=new Store(source);
  store.db.exec('ALTER TABLE posts DROP COLUMN collections_json; DROP INDEX posts_group; ALTER TABLE posts DROP COLUMN group_id; ALTER TABLE posts DROP COLUMN references_json; ALTER TABLE runs DROP COLUMN provider; ALTER TABLE runs DROP COLUMN custom_provider; DROP TABLE comparison_groups; DROP TABLE idempotency; DROP TABLE agent_tokens; PRAGMA user_version = 2;');store.close();
  const migrated=new Store(source);const row=migrated.db.prepare('SELECT * FROM posts LIMIT 1').get() as NonNullable<ReturnType<Store['getPost']>>;let post=migrated.post(row);
  const group=migrated.saveGroup({title:'Fixture comparison',allowSideBySide:true,postIds:[post.id]});post=migrated.post(migrated.getPost(post.id)!);
  const mediaId=post.coverId!;
  migrated.save({...post,references:[{kind:'link',url:'https://example.com/reference',label:'Reference link'},{kind:'media',mediaId,label:'Reference image'}],runs:[{model:'Unrestricted fixture model',provider:'Other',customProvider:'Fixture provider',harness:'',author:'',elapsedSeconds:null,reasoningEffort:'Custom fixture reasoning',outcome:'Completed',notes:'',conditions:'',resultMediaIds:[]}]},post.id);
  migrated.db.prepare('INSERT INTO agent_tokens (id,name,token_hash,scopes_json,created_at,expires_at) VALUES (?,?,?,?,?,?)').run('fixture-credential','Fixture credential','fixture-hash','["posts:read"]',new Date().toISOString(),Date.now()+60000);
  migrated.db.prepare('INSERT INTO idempotency VALUES (?,?,?,?,?,?)').run('fixture-credential','fixture-key','fixture-request','{}',201,Date.now());
  migrated.close();
  const backup=await createBackup(source,path.join(root,'backups'),true);assert.equal(backup.manifest.schemaVersion,4);await restoreBackup(backup.directory,path.join(root,'restored-v3'),true);
  const restored=new Store(path.join(root,'restored-v3'));
  try{const saved=restored.post(restored.getPost(post.id)!,true);assert.deepEqual(saved.references.map(ref=>ref.label),['Reference link','Reference image']);assert.equal(saved.runs[0].provider,'Other');assert.equal(saved.runs[0].customProvider,'Fixture provider');assert.equal(saved.group?.id,group.id);assert.equal(saved.group?.allowSideBySide,true);assert.equal((restored.db.prepare('SELECT COUNT(*) AS count FROM agent_tokens').get() as {count:number}).count,0);assert.equal((restored.db.prepare('SELECT COUNT(*) AS count FROM idempotency').get() as {count:number}).count,0);}finally{restored.close();}
}));
