import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { passwordHash } from '../server/auth.js';
import { Store } from '../server/db.js';
import type { Config } from '../server/config.js';
import type { Media, Post, PostInput } from '../shared/schema.js';
import { fixtureVideo } from './fixtures.js';

const fixturePassword='isolated-test-passphrase-42';
type Fixture = { config: Config; store: Store; origin: string; dataDir: string; server: Server; request: (route: string, init?: RequestInit, owner?: boolean) => Promise<Response>; signIn: () => Promise<void>; upload: (mime?: string,content?: Buffer) => Promise<Media> };
async function withFixture(run: (fixture: Fixture) => Promise<void>, enabled = true) {
  const root=path.resolve('.local'); await fs.mkdir(root,{ recursive:true });
  const dataDir=await fs.mkdtemp(path.join(root,'api-test-'));
  const config=readConfig({ PUBLIC_URL:'http://127.0.0.1:3000',DATA_DIR:dataDir,ADMIN_PASSWORD_HASH:enabled ? await passwordHash(fixturePassword) : '',UPLOAD_MAX_MB:'1',VIDEO_MAX_MB:'1' });
  let store=new Store(dataDir);
  const { app }=createApp(config,store,path.resolve('dist/client'));
  const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
  const origin=`http://127.0.0.1:${(server.address() as { port:number }).port}`; config.publicUrl=origin;
  let cookie='',csrf='';
  const request=async (route: string,init: RequestInit={},owner=false) => {
    const headers=new Headers(init.headers);
    if (init.method && init.method!=='GET') headers.set('Origin',headers.get('Origin') || origin);
    if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type','application/json');
    if (owner) { headers.set('Cookie',cookie); if (!headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token',csrf); }
    return fetch(`${origin}${route}`,{ ...init,headers });
  };
  const signIn=async () => {
    const response=await request('/api/admin/login',{ method:'POST',body:JSON.stringify({ password:fixturePassword }) });
    assert.equal(response.status,200); cookie=response.headers.getSetCookie().at(-1)!.split(';')[0]; csrf=(await response.json() as { csrf:string }).csrf;
    assert.match(response.headers.get('set-cookie')!,/HttpOnly/); assert.match(response.headers.get('set-cookie')!,/SameSite=Strict/);
  };
  const upload=async (mime='image/png',content?:Buffer) => {
    const buffer=content || await sharp({ create:{ width:60,height:40,channels:3,background:'#ffffff' } }).png().toBuffer();
    const form=new FormData(); form.append('image',new Blob([new Uint8Array(buffer)],{ type:mime }),'../../example.png');
    const response=await request('/api/admin/media',{ method:'POST',body:form },true); assert.equal(response.status,201,await response.clone().text()); return response.json() as Promise<Media>;
  };
  try { await run({ config,store,origin,dataDir,server,request,signIn,upload }); }
  finally {
    await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
    if (store.db.open) store.close();
    assert.ok(dataDir.startsWith(root+path.sep)); await fs.rm(dataDir,{ recursive:true,force:true });
  }
}
function input(image: Media,changes: Partial<PostInput>={}): PostInput {
  return { title:'Workflow test post',slug:'workflow-test-post',summary:'A clearly labeled test fixture.',category:'Code',prompt:'Create the fixture used by this automated test.',body:'Fixture only.',status:'draft',isDemo:true,coverId:image.id,runs:[],progress:[],...changes };
}
async function create(fixture: Fixture,image: Media,changes: Partial<PostInput>={}) {
  const response=await fixture.request('/api/admin/posts',{ method:'POST',body:JSON.stringify(input(image,changes)) },true);
  assert.equal(response.status,201,await response.clone().text()); return response.json() as Promise<Post>;
}

test('administration is disabled without user-supplied configuration',async () => withFixture(async fixture => {
  assert.deepEqual(await (await fixture.request('/api/admin/session')).json(),{ configured:false,authenticated:false,csrf:null });
  assert.equal((await fixture.request('/api/admin/login',{ method:'POST',body:JSON.stringify({ password:fixturePassword }) })).status,503);
  assert.equal((await fixture.request('/api/admin/posts')).status,401);
},false));

test('unauthenticated writes, foreign origins and invalid CSRF tokens are rejected',async () => withFixture(async fixture => {
  assert.equal((await fixture.request('/api/admin/posts',{ method:'POST',body:'{}' })).status,401);
  assert.equal((await fixture.request('/api/admin/login',{ method:'POST',headers:{ Origin:'https://unrelated.example' },body:JSON.stringify({ password:fixturePassword }) })).status,403);
  await fixture.signIn();
  for (const token of ['', 'a'.repeat(48), 'é'.repeat(48)]) assert.equal((await fixture.request('/api/admin/posts',{ method:'POST',headers:{ 'X-CSRF-Token':token },body:'{}' },true)).status,403);
  const session=await (await fixture.request('/api/admin/session',{},true)).json() as { authenticated:boolean }; assert.equal(session.authenticated,true);
}));

test('draft post and its images remain private; publication and revocation change access',async () => withFixture(async fixture => {
  await fixture.signIn(); const image=await fixture.upload(); const draft=await create(fixture,image);
  assert.equal((await fixture.request(`/api/posts/${draft.slug}`)).status,404);
  assert.equal((await fixture.request(`/media/${image.id}`)).status,404);
  assert.equal((await fixture.request(`/media/${image.id}`,{},true)).status,200);
  const publishedResponse=await fixture.request(`/api/admin/posts/${draft.id}`,{ method:'PUT',body:JSON.stringify(input(image,{ status:'published',revision:draft.revision })) },true);
  assert.equal(publishedResponse.status,200); const published=await publishedResponse.json() as Post;
  assert.equal((await fixture.request(`/api/posts/${draft.slug}`)).status,200);
  const media=await fixture.request(`/media/${image.id}`); assert.equal(media.status,200); assert.equal(media.headers.get('content-type'),'image/webp'); assert.match(media.headers.get('cache-control')!,/must-revalidate/);
  const revoked=await fixture.request(`/api/admin/posts/${draft.id}`,{ method:'PUT',body:JSON.stringify(input(image,{ revision:published.revision })) },true); assert.equal(revoked.status,200);
  assert.equal((await fixture.request(`/media/${image.id}`)).status,404); assert.equal((await fixture.request(`/api/posts/${draft.slug}`)).status,404);
}));

test('editing detects stale revisions and duplicate slugs; deletion retains removable media',async () => withFixture(async fixture => {
  await fixture.signIn(); const image=await fixture.upload(); const post=await create(fixture,image);
  assert.equal((await fixture.request(`/api/admin/posts/${post.id}`,{ method:'PUT',body:JSON.stringify(input(image,{ title:'Updated title',revision:post.revision })) },true)).status,200);
  assert.equal((await fixture.request(`/api/admin/posts/${post.id}`,{ method:'PUT',body:JSON.stringify(input(image,{ revision:post.revision })) },true)).status,409);
  assert.equal((await fixture.request('/api/admin/posts',{ method:'POST',body:JSON.stringify(input(image)) },true)).status,409);
  assert.equal((await fixture.request(`/api/admin/posts/${post.id}`,{ method:'DELETE',body:JSON.stringify({ revision:1 }) },true)).status,409);
  assert.equal((await fixture.request(`/api/admin/media/${image.id}`,{ method:'DELETE' },true)).status,409);
  assert.equal((await fixture.request(`/api/admin/posts/${post.id}`,{ method:'DELETE',body:JSON.stringify({ revision:2 }) },true)).status,204);
  assert.equal((await fixture.request(`/api/admin/media/${image.id}`,{ method:'DELETE' },true)).status,204);
  assert.equal((await fixture.request(`/media/${image.id}`,{},true)).status,404);
  assert.deepEqual(await fs.readdir(fixture.store.uploads),[]);
}));

test('run records, ordering, comparison facets, search and filters reflect authored content',async () => withFixture(async fixture => {
  await fixture.signIn(); const image=await fixture.upload();
  const run={ model:'Test model A (fixture)',harness:'Test harness',author:'Automated fixture',elapsedSeconds:73,outcome:'Completed' as const,notes:'Test data.',conditions:'Isolated test environment.',resultMediaIds:[image.id] };
  const post=await create(fixture,image,{ status:'published',runs:[run,{ ...run,model:'Test model B (fixture)',elapsedSeconds:null,outcome:'Partial' }],progress:[{ mediaId:image.id,label:'Fixture progress',elapsedSeconds:10 }] });
  assert.equal(post.runs.length,2); assert.equal(post.progress[0].label,'Fixture progress');
  const comparison=await (await fixture.request('/api/compare?model='+encodeURIComponent(run.model))).json() as { total:number; runs:{ model:string; elapsedSeconds:number; resultImages:Media[] }[] }; assert.equal(comparison.total,1); assert.equal(comparison.runs[0].elapsedSeconds,73); assert.equal(comparison.runs[0].resultImages[0].id,image.id);
  const partial=await (await fixture.request('/api/compare?outcome=Partial')).json() as { total:number }; assert.equal(partial.total,1);
  const category=await (await fixture.request('/api/posts?category=Design')).json() as { total:number }; assert.equal(category.total,0);
  const search=await (await fixture.request('/api/posts?q=Workflow')).json() as { total:number }; assert.equal(search.total,1);
  const wrongSearch=await (await fixture.request('/api/posts?q=unmatched')).json() as { total:number }; assert.equal(wrongSearch.total,0);
  const catalog=await (await fixture.request('/api/catalog')).json() as { models:string[] }; assert.deepEqual(catalog.models,[run.model,'Test model B (fixture)']);
}));

test('uploads validate file content, MIME, size and paths, and strip metadata',async () => withFixture(async fixture => {
  await fixture.signIn(); const image=await fixture.upload(); assert.equal(image.name,'example.png'); assert.equal(image.width,60); assert.equal(image.height,40);
  const buffer=await (await fixture.request(image.url,{},true)).arrayBuffer(); const metadata=await sharp(Buffer.from(buffer)).metadata(); assert.equal(metadata.format,'webp'); assert.equal(metadata.exif,undefined);
  for (const [mime,content,expected] of [['image/svg+xml',Buffer.from('<svg/>'),415],['image/png',Buffer.from('not an image'),415],['image/jpeg',await sharp({ create:{ width:10,height:10,channels:3,background:'#fff' } }).png().toBuffer(),415],['image/png',Buffer.alloc(1024*1024+1),413]] as const) {
    const form=new FormData(); form.append('image',new Blob([new Uint8Array(content)],{ type:mime }),'unsafe.png');
    assert.equal((await fixture.request('/api/admin/media',{ method:'POST',body:form },true)).status,expected);
  }
  assert.equal((await fixture.request('/media/'+encodeURIComponent('../../.env'))).status,400);
  assert.equal((await fixture.request(`/media/${image.id}/other`,{},true)).status,404);
  assert.equal((await fixture.request('/api/admin/media',{ method:'POST' },true)).status,400);
}));

test('schemas reject malformed posts and prevent orphan media and cross-post run corruption',async () => withFixture(async fixture => {
  await fixture.signIn(); const image=await fixture.upload();
  assert.equal((await fixture.request('/api/admin/posts',{ method:'POST',body:JSON.stringify(input(image,{ status:'published',coverId:null })) },true)).status,400);
  assert.equal((await fixture.request('/api/admin/posts',{ method:'POST',body:JSON.stringify(input(image,{ coverId:randomUUID() })) },true)).status,400);
  assert.equal((await fixture.request('/api/admin/posts',{ method:'POST',body:JSON.stringify({ ...input(image),secret:'unexpected' }) },true)).status,400);
  const run={ model:'Fixture model',harness:'',author:'',elapsedSeconds:null,outcome:'Completed' as const,notes:'',conditions:'',resultMediaIds:[] };
  const first=await create(fixture,image,{ runs:[run] });
  assert.equal((await fixture.request('/api/admin/posts',{ method:'POST',body:JSON.stringify(input(image,{ slug:'another-fixture',runs:first.runs })) },true)).status,400);
  const existing=await (await fixture.request(`/api/admin/posts/${first.id}`,{},true)).json() as Post; assert.equal(existing.runs.length,1);
  assert.equal((await fixture.request('/api/posts?limit=100000')).status,400);
}));

test('logout revokes the session; changing the password invalidates existing sessions',async () => withFixture(async fixture => {
  await fixture.signIn(); assert.equal((await fixture.request('/api/admin/logout',{ method:'POST' },true)).status,204);
  assert.equal((await fixture.request('/api/admin/posts',{},true)).status,401);
  await fixture.signIn(); fixture.config.passwordHash=await passwordHash('changed-test-passphrase-84');
  assert.equal((await fixture.request('/api/admin/posts',{},true)).status,401);
}));

test('login rate limits apply and forged forwarded headers cannot bypass them',async () => withFixture(async fixture => {
  for (let index=0;index<8;index++) assert.equal((await fixture.request('/api/admin/login',{ method:'POST',headers:{ 'X-Forwarded-For':`192.0.2.${index+1}` },body:JSON.stringify({ password:'wrong' }) })).status,401);
  const limited=await fixture.request('/api/admin/login',{ method:'POST',headers:{ 'X-Forwarded-For':'198.51.100.2' },body:JSON.stringify({ password:'wrong' }) }); assert.equal(limited.status,429); assert.ok(limited.headers.get('retry-after'));
}));

test('host validation, security headers and origin configuration reject unsafe defaults',async () => withFixture(async fixture => {
  const response=await fixture.request('/api/site'); assert.match(response.headers.get('content-security-policy')!,/frame-ancestors 'none'/); assert.equal(response.headers.get('x-content-type-options'),'nosniff'); assert.equal(response.headers.get('x-powered-by'),null);
  assert.equal(response.headers.get('x-robots-tag'),'noindex, nofollow'); assert.equal(response.headers.get('cache-control'),'no-store');
  const wrongHost=await new Promise<number>(resolve => { const request=httpRequest(`${fixture.origin}/api/site`,{ headers:{ Host:'unrelated.example' } },response => { response.resume(); resolve(response.statusCode!); }); request.end(); });
  assert.equal(wrongHost,421);
  assert.throws(() => readConfig({ PUBLIC_URL:'http://public.example' })); assert.throws(() => readConfig({ PUBLIC_URL:'https://public.example/path' })); assert.throws(() => readConfig({ TRUSTED_PROXY_CIDRS:'0.0.0.0/0' })); assert.throws(() => readConfig({ ADMIN_PASSWORD_HASH:'plaintext' }));
}));

test('posts and structured runs survive closing and reopening the database',async () => withFixture(async fixture => {
  await fixture.signIn(); const image=await fixture.upload(); const post=await create(fixture,image,{ runs:[{ model:'Persistence fixture',harness:'',author:'',elapsedSeconds:0,outcome:'Completed',notes:'',conditions:'',resultMediaIds:[] }] });
  fixture.store.close(); const reopened=new Store(fixture.dataDir);
  try { const saved=reopened.post(reopened.getPost(post.id)!); assert.equal(saved.title,post.title); assert.equal(saved.runs[0].elapsedSeconds,0); assert.equal(saved.media[image.id].name,'example.png'); }
  finally { reopened.close(); }
}));

test('crawler metadata is escaped, bounded and limited to published posts and recorded metrics',async () => withFixture(async fixture=>{
  await fixture.signIn();const cover=await fixture.upload();
  const prompt='SECRET_PROMPT_CONTENT_'+'x'.repeat(50000);
  const run={ model:'Fixture <model> & "quoted"',harness:'',author:'',elapsedSeconds:73,reasoningEffort:'High',tokens:12345,estimatedCostUsd:0.025,outcome:'Completed' as const,notes:'',conditions:'',resultMediaIds:[] };
  const changes={ title:'Fixture <title> & "quoted"',summary:'Summary '.repeat(35),prompt,runs:[run],showcaseMediaIds:[cover.id] };
  const draft=await create(fixture,cover,changes);
  const privateHtml=await fixture.request(`/posts/${draft.slug}`);assert.equal(privateHtml.status,404);assert.ok(!(await privateHtml.text()).includes('og:title'));
  const published=await fixture.request(`/api/admin/posts/${draft.id}`,{ method:'PUT',body:JSON.stringify(input(cover,{ ...changes,revision:draft.revision,status:'published' })) },true);assert.equal(published.status,200);
  const crawler=await fixture.request(`/posts/${draft.slug}`,{ headers:{ 'User-Agent':'Discordbot/2.0' } });const html=await crawler.text();
  assert.equal(crawler.status,200);assert.match(html,/og:title" content="Fixture &lt;title&gt; &amp; &quot;quoted&quot;/);assert.ok(html.includes(`content="${fixture.origin}/media/${cover.id}"`));
  assert.match(html,/Reasoning: High/);assert.match(html,/1m 13s/);assert.match(html,/Tokens: 12,345/);assert.match(html,/Cost: \$0.025 USD/);assert.match(html,/twitter:card/);
  assert.ok(!html.includes('SECRET_PROMPT_CONTENT'));assert.ok(html.length<4000);
  const description=html.match(/og:description" content="([^"]*)"/)![1];assert.ok(description.replace(/&[^;]+;/g,'x').length<=300);
  const post=await (await fixture.request(`/api/posts/${draft.slug}`)).json() as Post;assert.equal(post.prompt,prompt);assert.equal(post.runs[0].tokens,12345);
  const invalid=await fixture.request(`/api/admin/posts/${draft.id}`,{ method:'PUT',body:JSON.stringify(input(cover,{ revision:post.revision,runs:[{...run,tokens:-1}] })) },true);assert.equal(invalid.status,400);
  const revoked=await fixture.request(`/api/admin/posts/${draft.id}`,{ method:'PUT',body:JSON.stringify(input(cover,{ revision:post.revision })) },true);assert.equal(revoked.status,200);
  const gone=await fixture.request(`/posts/${draft.slug}`);assert.equal(gone.status,404);assert.ok(!(await gone.text()).includes('og:image'));
}));

test('MP4 validation, thumbnail generation, range playback and draft access are enforced',async () => withFixture(async fixture=>{
  await fixture.signIn();const cover=await fixture.upload(),file=await fixtureVideo(fixture.dataDir);
  const video=await fixture.upload('video/mp4',await fs.readFile(file));assert.equal(video.kind,'video');assert.equal(video.durationSeconds,1);
  assert.equal((await fixture.request(video.url)).status,404);assert.equal((await fixture.request(video.thumbnailUrl)).status,404);
  const draft=await create(fixture,cover,{ showcaseMediaIds:[video.id],progress:[{mediaId:video.id,label:'Fixture timelapse',elapsedSeconds:null}] });
  const published=await fixture.request(`/api/admin/posts/${draft.id}`,{method:'PUT',body:JSON.stringify(input(cover,{ status:'published',revision:draft.revision,showcaseMediaIds:[video.id],progress:draft.progress }))},true);assert.equal(published.status,200);
  const playback=await fixture.request(video.url,{headers:{Range:'bytes=0-31'}});assert.equal(playback.status,206);assert.equal(playback.headers.get('content-type'),'video/mp4');assert.match(playback.headers.get('content-range')!,/^bytes 0-31\//);assert.equal((await playback.arrayBuffer()).byteLength,32);
  const thumb=await fixture.request(video.thumbnailUrl);assert.equal(thumb.headers.get('content-type'),'image/webp');assert.equal((await sharp(Buffer.from(await thumb.arrayBuffer())).metadata()).width,160);
  const bytes=Buffer.from(await (await fixture.request(video.url)).arrayBuffer());assert.ok(!bytes.includes(Buffer.from('REMOVE_THIS_PRIVATE_FIXTURE_METADATA')));
  const invalidCover=await fixture.request('/api/admin/posts',{method:'POST',body:JSON.stringify(input(cover,{slug:'invalid-video-cover',coverId:video.id,status:'published'}))},true);assert.equal(invalidCover.status,400);
  assert.equal((await fixture.request(`/api/admin/media/${video.id}`,{method:'DELETE'},true)).status,409);
  for (const content of [Buffer.from('not an MP4'),Buffer.alloc(1024*1024+1)]) {
    const form=new FormData();form.append('image',new Blob([new Uint8Array(content)],{type:'video/mp4'}),'invalid.mp4');assert.equal((await fixture.request('/api/admin/media',{method:'POST',body:form},true)).status,content.length>1024*1024?413:415);
  }
  assert.ok(!(await fs.readdir(fixture.store.uploads)).some(name=>name.startsWith('.incoming-')));
}));

test('50 progress items retain their order and remain separate from the final showcase',async () => withFixture(async fixture=>{
  await fixture.signIn();const images:Media[]=[];for(let i=0;i<50;i++)images.push(await fixture.upload());
  const progress=images.map((image,index)=>({mediaId:image.id,label:`Step ${index+1}`,elapsedSeconds:null}));
  const post=await create(fixture,images[0],{showcaseMediaIds:images.slice(0,5).map(image=>image.id),progress});
  assert.equal(post.progress.length,50);assert.equal(post.showcaseMediaIds.length,5);
  const reversed=[...progress].reverse();const changed=await fixture.request(`/api/admin/posts/${post.id}`,{method:'PUT',body:JSON.stringify(input(images[0],{revision:post.revision,showcaseMediaIds:post.showcaseMediaIds,progress:reversed}))},true);assert.equal(changed.status,200);
  const saved=await changed.json() as Post;assert.equal(saved.progress[0].label,'Step 50');assert.deepEqual(saved.showcaseMediaIds,post.showcaseMediaIds);assert.equal(Object.keys(saved.media).length,50);
  const excessive=await fixture.request(`/api/admin/posts/${post.id}`,{method:'PUT',body:JSON.stringify(input(images[0],{revision:saved.revision,progress:[...progress,progress[0]]}))},true);assert.equal(excessive.status,400);
  const duplicate=await fixture.request(`/api/admin/posts/${post.id}`,{method:'PUT',body:JSON.stringify(input(images[0],{revision:saved.revision,showcaseMediaIds:[images[0].id,images[0].id]}))},true);assert.equal(duplicate.status,400);
}));

test('providers and full-post groups preserve draft privacy, membership revisions and owner comparison control',async()=>withFixture(async fixture=>{
  await fixture.signIn();const image=await fixture.upload();
  const run={model:'Any free-text model name',provider:'Other' as const,customProvider:'Independent fixture provider',harness:'',author:'',elapsedSeconds:13,reasoningEffort:'A free-text reasoning level',tokens:null,estimatedCostUsd:null,outcome:'Completed' as const,notes:'',conditions:'',resultMediaIds:[]};
  const first=await create(fixture,image,{slug:'group-first-fixture',status:'published',prompt:'First unique prompt.',runs:[run]});
  const second=await create(fixture,image,{slug:'group-second-fixture',status:'published',prompt:'Second unique prompt.',runs:[{...run,provider:'Google',customProvider:'',model:'Second free-text model'}]});
  const draft=await create(fixture,image,{slug:'group-private-fixture',title:'Private group member title',prompt:'Private group member prompt.'});
  const response=await fixture.request('/api/admin/groups',{method:'POST',body:JSON.stringify({title:'Fixture group',allowSideBySide:false,postIds:[first.id,second.id,draft.id]})},true);assert.equal(response.status,201,await response.clone().text());const group=await response.json() as {id:string;revision:number;posts:Post[]};assert.equal(group.posts.length,3);
  assert.equal((await fixture.request(`/api/admin/posts/${first.id}`,{method:'PUT',body:JSON.stringify(input(image,{slug:first.slug,revision:first.revision}))},true)).status,409);
  const publicResponse=await fixture.request(`/api/posts/${first.slug}`);const publicText=await publicResponse.text();assert.ok(!publicText.includes(draft.title));assert.ok(!publicText.includes(draft.prompt));const publicPost=JSON.parse(publicText) as Post;assert.equal(publicPost.group?.posts.length,2);assert.equal(publicPost.runs[0].provider,'Other');assert.equal(publicPost.runs[0].customProvider,run.customProvider);
  const html=await(await fixture.request(`/posts/${first.slug}`)).text();assert.ok(html.includes('Independent fixture provider'));assert.ok(!html.includes(draft.title));assert.ok(!html.includes('First unique prompt.'));
  assert.equal((await fixture.request(`/api/compare?groupId=${group.id}`)).status,403);
  const global=await(await fixture.request('/api/compare')).json() as {runs:{canCompare:boolean}[]};assert.ok(global.runs.every(item=>!item.canCompare));
  assert.equal((await fixture.request(`/api/admin/groups/${group.id}`,{method:'PUT',body:JSON.stringify({title:'Fixture group',allowSideBySide:true,postIds:[first.id,second.id,draft.id],revision:group.revision})},true)).status,200);
  const compareResponse=await fixture.request(`/api/compare?groupId=${group.id}`);assert.equal(compareResponse.status,200);const compare=await compareResponse.json() as {posts:Post[];group:{revision:number};runs:{canCompare:boolean}[]};assert.deepEqual(compare.posts.map(post=>post.prompt),['First unique prompt.','Second unique prompt.']);assert.ok(compare.runs.every(item=>item.canCompare));
  assert.equal((await fixture.request(`/api/admin/groups/${group.id}`,{method:'PUT',body:JSON.stringify({title:'Stale edit',allowSideBySide:false,postIds:[],revision:group.revision})},true)).status,409);
  const other=await fixture.request('/api/admin/groups',{method:'POST',body:JSON.stringify({title:'Other fixture',allowSideBySide:true,postIds:[first.id]})},true);assert.equal(other.status,409);
  assert.equal((await fixture.request(`/api/admin/groups/${group.id}`,{method:'DELETE',body:JSON.stringify({revision:compare.group.revision})},true)).status,204);
  const detached=await(await fixture.request(`/api/posts/${first.slug}`)).json() as Post;assert.equal(detached.groupId,null);assert.equal(detached.group,null);assert.equal(detached.prompt,'First unique prompt.');
}));

test('reference URLs, bounds and custom provider validation reject unsafe authoring input',async()=>withFixture(async fixture=>{
  await fixture.signIn();const image=await fixture.upload();
  const base=input(image,{references:[{kind:'media',mediaId:image.id,label:'Uploaded reference'}]});
  for(const url of ['file:///private/file','javascript:alert(1)','https://name:password@example.com/'])assert.equal((await fixture.request('/api/admin/posts',{method:'POST',body:JSON.stringify({...base,references:[{kind:'link',url,label:'Unsafe link'}]})},true)).status,400);
  assert.equal((await fixture.request('/api/admin/posts',{method:'POST',body:JSON.stringify({...base,references:Array.from({length:51},()=>base.references![0])})},true)).status,400);
  assert.equal((await fixture.request('/api/admin/posts',{method:'POST',body:JSON.stringify({...base,references:[{kind:'media',mediaId:randomUUID(),label:''}]})},true)).status,400);
  const run={model:'Free-text fixture',provider:'Other',customProvider:'',harness:'',author:'',elapsedSeconds:null,outcome:'Completed',notes:'',conditions:'',resultMediaIds:[]};
  assert.equal((await fixture.request('/api/admin/posts',{method:'POST',body:JSON.stringify({...base,runs:[run]})},true)).status,400);
}));

test('search combines actual provider, model and reasoning values from the same published run',async()=>withFixture(async fixture=>{
  await fixture.signIn();const image=await fixture.upload();
  const run={model:'Model one',provider:'OpenAI' as const,customProvider:'',harness:'',author:'',elapsedSeconds:null,reasoningEffort:'Custom deep effort',outcome:'Completed' as const,notes:'',conditions:'',resultMediaIds:[]};
  const mixed=await create(fixture,image,{title:'Search fixture alpha',slug:'search-alpha',summary:'Recorded project',status:'published',runs:[run,{...run,model:'Model two',provider:'Other',customProvider:'Local provider',reasoningEffort:'Quick effort'}]});
  await create(fixture,image,{title:'Search fixture beta',slug:'search-beta',status:'published',runs:[{...run,model:'Model one',provider:'Other',customProvider:'Local provider'}]});
  await create(fixture,image,{slug:'search-private',runs:[{...run,model:'Private model',reasoningEffort:'Private effort'}]});
  const query=new URLSearchParams({q:'alpha',provider:'OpenAI',model:'Model one',reasoning:'Custom deep effort',category:'Code'});
  const matched=await(await fixture.request(`/api/posts?${query}`)).json() as {total:number;posts:Post[]};assert.equal(matched.total,1);assert.equal(matched.posts[0].id,mixed.id);
  query.set('provider','Local provider');assert.equal((await(await fixture.request(`/api/posts?${query}`)).json() as {total:number}).total,0);
  query.delete('model');query.delete('reasoning');assert.equal((await(await fixture.request(`/api/posts?${query}`)).json() as {total:number}).total,1);
  const catalog=await(await fixture.request('/api/catalog')).json() as {providers:string[];models:string[];reasoningEfforts:string[]};assert.deepEqual(catalog.providers,['Local provider','OpenAI']);assert.ok(!catalog.models.includes('Private model'));assert.ok(!catalog.reasoningEfforts.includes('Private effort'));
  const cards=await(await fixture.request('/api/posts')).json() as {posts:{providers:string[];reasoningEfforts:string[]}[]};assert.ok(cards.posts.every(post=>post.providers.length>0));assert.ok(cards.posts.every(post=>post.reasoningEfforts.length>0));
}));

test('authenticated bulk traffic has a bounded bucket separate from visitors and forged credentials',async()=>withFixture(async fixture=>{
  await fixture.signIn();
  for(let index=0;index<245;index++)assert.equal((await fixture.request('/api/site',{},true)).status,200);
  assert.equal((await fixture.request('/api/site')).status,200);
  let visitorLimited=false;
  for(let index=0;index<240;index++){
    const response=await fixture.request('/api/site');
    if(response.status===429){visitorLimited=true;assert.ok(response.headers.get('retry-after'));break;}
    assert.equal(response.status,200);
  }
  assert.ok(visitorLimited);
  assert.equal((await fixture.request('/api/site',{headers:{Authorization:'Bearer abt_'+'0'.repeat(64),'X-Forwarded-For':'198.51.100.4'}})).status,429);
  assert.equal((await fixture.request('/api/site',{},true)).status,200);
  let ownerLimited=false;
  for(let index=0;index<360;index++){
    const response=await fixture.request('/api/site',{},true);
    if(response.status===429){ownerLimited=true;break;}
    assert.equal(response.status,200);
  }
  assert.ok(ownerLimited);
}));
