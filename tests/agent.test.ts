import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { passwordHash } from '../server/auth.js';
import { Store } from '../server/db.js';
import type { Post, PostInput, Media, ComparisonGroup } from '../shared/schema.js';
import { authoringSchema } from '../server/agent-api.js';

const execute = promisify(execFile);
const fixturePassword = 'isolated-agent-owner-passphrase-42';
type Scope = 'posts:read' | 'posts:write' | 'publish' | 'media:write' | 'groups:write';
type Token = { id: string; secret: string };
type Fixture = { store: Store; origin: string; dataDir: string; owner: (route: string, init?: RequestInit, csrf?: boolean) => Promise<Response>; agent: (route: string, token?: string, init?: RequestInit, key?: string) => Promise<Response>; issue: (scopes?: Scope[]) => Promise<Token>; upload: (token: string, key?: string, content?: Buffer, name?: string, mime?: string) => Promise<Response> };
async function fixture(run: (value: Fixture) => Promise<void>) {
  const root = path.resolve('.local'); await fs.mkdir(root, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(root, 'agent-test-'));
  const config = readConfig({ PUBLIC_URL: 'http://127.0.0.1:3000', DATA_DIR: dataDir, ADMIN_PASSWORD_HASH: await passwordHash(fixturePassword), UPLOAD_MAX_MB: '1', VIDEO_MAX_MB: '1' });
  const store = new Store(dataDir), { app } = createApp(config, store, path.resolve('.local/no-client'));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`; config.publicUrl = origin;
  const login = await fetch(origin + '/api/admin/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: fixturePassword }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().at(-1)!.split(';')[0], csrf = (await login.json() as { csrf: string }).csrf;
  const owner: Fixture['owner'] = (route, init = {}, enabled = true) => {
    const headers = new Headers(init.headers); headers.set('Cookie', cookie); headers.set('Origin', origin);
    if (enabled) headers.set('X-CSRF-Token', csrf);
    if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    return fetch(origin + route, { ...init, headers });
  };
  const agent: Fixture['agent'] = (route, token, init = {}, key = randomUUID()) => {
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', 'Bearer ' + token);
    if (init.method && !['GET', 'HEAD'].includes(init.method)) headers.set('Idempotency-Key', key);
    if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    return fetch(origin + route, { ...init, headers });
  };
  const issue: Fixture['issue'] = async (scopes = ['posts:read', 'posts:write', 'media:write', 'groups:write']) => {
    const response = await owner('/api/admin/agent-tokens', { method: 'POST', body: JSON.stringify({ name: 'Isolated fixture', scopes, expiresInDays: 1 }) });
    assert.equal(response.status, 201, await response.clone().text());
    const value = await response.json() as { token: { id: string }; secret: string };
    return { id: value.token.id, secret: value.secret };
  };
  const upload: Fixture['upload'] = async (token, key = randomUUID(), content, name = 'isolated.png', mime = 'image/png') => {
    const buffer = content || await sharp({ create: { width: 24, height: 16, channels: 3, background: '#fff' } }).png().toBuffer();
    const form = new FormData(); form.append('image', new Blob([new Uint8Array(buffer)], { type: mime }), name);
    return agent('/api/v1/media', token, { method: 'POST', body: form }, key);
  };
  try { await run({ store, origin, dataDir, owner, agent, issue, upload }); }
  finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (store.db.open) store.close();
    assert.ok(dataDir.startsWith(root + path.sep)); await fs.rm(dataDir, { recursive: true, force: true });
  }
}
const input = (changes: Partial<PostInput> = {}): PostInput => ({ title: 'Isolated agent draft', slug: 'isolated-agent-draft', summary: 'Automated isolated fixture.', category: 'Code', prompt: 'Fixture prompt only.', body: '', status: 'draft', isDemo: true, coverId: null, showcaseMediaIds: [], references: [], groupId: null, runs: [], progress: [], ...changes });

test('owner-only credential setup retains only a digest and never leaks secrets through reads', async () => fixture(async f => {
  const body = JSON.stringify({ name: 'Test only', scopes: ['posts:read'], expiresInDays: 1 });
  assert.equal((await f.agent('/api/admin/agent-tokens', undefined, { method: 'POST', body })).status, 401);
  assert.equal((await f.owner('/api/admin/agent-tokens', { method: 'POST', body }, false)).status, 403);
  const token = await f.issue(['posts:read']);
  assert.match(token.secret, /^abt_[a-f0-9]{64}$/);
  const stored = f.store.db.prepare('SELECT * FROM agent_tokens WHERE id=?').get(token.id) as { token_hash: string; scopes_json: string; expires_at: number };
  assert.equal(stored.token_hash, createHash('sha256').update(token.secret).digest('hex'));
  assert.equal(JSON.stringify(stored).includes(token.secret), false);
  const list = await (await f.owner('/api/admin/agent-tokens')).text();
  assert.equal(list.includes(token.secret), false); assert.equal(list.includes('token_hash'), false);
  const me = await (await f.agent('/api/v1/me', token.secret)).text();
  assert.equal(me.includes(token.secret), false); assert.equal(me.includes('token_hash'), false);
  assert.equal((await f.agent('/api/admin/posts', token.secret)).status, 401, 'bearer cannot authenticate browser owner routes');
  assert.equal((await f.owner('/api/admin/agent-tokens', { method: 'POST', body: JSON.stringify({ name: 'Invalid', scopes: ['publish'], expiresInDays: 91 }) })).status, 400);
}));

test('bearer scopes, expiry and revocation reject writes before mutating isolated data', async () => fixture(async f => {
  const token = await f.issue(['posts:read']);
  for (const secret of [undefined, 'bad-value', token.secret]) {
    assert.equal((await f.agent('/api/v1/posts', secret, { method: 'POST', body: JSON.stringify(input()) })).status, secret === token.secret ? 403 : 401);
  }
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n, 0);
  f.store.db.prepare('UPDATE agent_tokens SET expires_at=? WHERE id=?').run(Date.now() - 1, token.id);
  assert.equal((await f.agent('/api/v1/posts', token.secret)).status, 401);
  const writer = await f.issue();
  const draft = await f.agent('/api/v1/posts', writer.secret, { method: 'POST', body: JSON.stringify(input()) }); assert.equal(draft.status, 201);
  assert.equal((await f.owner('/api/admin/agent-tokens/' + writer.id, { method: 'DELETE' })).status, 204);
  assert.equal((await f.agent('/api/v1/posts', writer.secret)).status, 401);
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM idempotency WHERE credential_id=?').get(writer.id) as { n: number }).n, 0);
}));

test('full draft authoring preserves provider/free reasoning/references and atomic JSON replay/revisions', async () => fixture(async f => {
  const token = await f.issue(), uploaded = await f.upload(token.secret); assert.equal(uploaded.status, 201);
  const media = await uploaded.json() as Media;
  const request = input({ coverId: media.id, showcaseMediaIds: [media.id], references: [{ kind: 'media', mediaId: media.id, label: 'Fixture source' }, { kind: 'link', url: 'https://example.com/reference', label: 'Fixture URL' }], progress: [{ mediaId: media.id, label: 'Step one', elapsedSeconds: null }], runs: [{ model: 'Free text fixture model', provider: 'Other', customProvider: 'Fixture lab', harness: '', author: '', elapsedSeconds: null, reasoningEffort: 'Any owner-provided reasoning text', tokens: null, estimatedCostUsd: null, outcome: 'Partial', notes: '', conditions: '', resultMediaIds: [media.id] }] });
  const key = 'draft-create-replay-fixture-0001';
  const first = await f.agent('/api/v1/posts', token.secret, { method: 'POST', body: JSON.stringify(request) }, key); assert.equal(first.status, 201);
  const post = await first.json() as Post;
  const reorder = Object.fromEntries(Object.entries(request).reverse());
  const repeat = await f.agent('/api/v1/posts', token.secret, { method: 'POST', body: JSON.stringify(reorder) }, key); assert.equal(repeat.status, 201); assert.equal(repeat.headers.get('Idempotency-Replayed'), 'true'); assert.deepEqual(await repeat.json(), post);
  assert.equal((await f.agent('/api/v1/posts', token.secret, { method: 'POST', body: JSON.stringify({ ...request, title: 'Changed request' }) }, key)).status, 409);
  assert.equal((await f.agent('/api/v1/posts', token.secret, { method: 'POST', body: JSON.stringify({ ...request, slug: 'other-slug' }) }, '')).status, 400);
  assert.equal(post.runs[0].provider, 'Other'); assert.equal(post.runs[0].customProvider, 'Fixture lab'); assert.equal(post.runs[0].reasoningEffort, request.runs[0].reasoningEffort); assert.deepEqual(post.references, request.references);
  assert.equal((await f.agent('/api/posts/' + post.slug)).status, 404); assert.equal((await f.agent('/media/' + media.id)).status, 404);
  const draftRead = await f.agent('/api/v1/posts/' + post.id, token.secret); assert.equal(draftRead.status, 200);
  const update = { ...request, revision: post.revision, title: 'Updated isolated draft' };
  assert.equal((await f.agent('/api/v1/posts/' + post.id, token.secret, { method: 'PUT', body: JSON.stringify(update) }, 'draft-update-replay-fixture-0001')).status, 200);
  const replay = await f.agent('/api/v1/posts/' + post.id, token.secret, { method: 'PUT', body: JSON.stringify(update) }, 'draft-update-replay-fixture-0001'); assert.equal(replay.status, 200); assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
  assert.equal((await f.agent('/api/v1/posts/' + post.id, token.secret, { method: 'PUT', body: JSON.stringify(update) })).status, 409);
  assert.equal((await f.agent('/api/v1/posts/' + post.id, token.secret, { method: 'PUT', body: JSON.stringify(request) })).status, 400);
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n, 1);
}));

test('draft scope cannot publish, edit/unpublish a published post or change its group', async () => fixture(async f => {
  const draftToken = await f.issue(), publisher = await f.issue(['posts:read', 'posts:write', 'media:write', 'groups:write', 'publish']);
  const media = await (await f.upload(publisher.secret)).json() as Media;
  const body = input({ status: 'published', coverId: media.id });
  assert.equal((await f.agent('/api/v1/posts', draftToken.secret, { method: 'POST', body: JSON.stringify(body) })).status, 403);
  const published = await (await f.agent('/api/v1/posts', publisher.secret, { method: 'POST', body: JSON.stringify(body) })).json() as Post;
  for (const status of ['draft', 'published'] as const) assert.equal((await f.agent('/api/v1/posts/' + published.id, draftToken.secret, { method: 'PUT', body: JSON.stringify({ ...body, status, revision: published.revision }) })).status, 403);
  const group = { title: 'Published group fixture', allowSideBySide: true, postIds: [published.id] };
  assert.equal((await f.agent('/api/v1/groups', draftToken.secret, { method: 'POST', body: JSON.stringify(group) })).status, 403);
  const response = await f.agent('/api/v1/groups', publisher.secret, { method: 'POST', body: JSON.stringify(group) }); assert.equal(response.status, 201);
  const created = await response.json() as ComparisonGroup;
  assert.equal((await f.agent('/api/v1/groups/' + created.id, draftToken.secret, { method: 'DELETE', body: JSON.stringify({ revision: created.revision }) })).status, 403);
  assert.equal((await f.agent('/api/v1/groups/' + created.id, draftToken.secret, { method: 'PUT', body: JSON.stringify({ ...group, postIds: [], revision: created.revision }) })).status, 403);
  assert.equal((await f.agent('/api/v1/posts/' + published.id, publisher.secret)).status, 200);
}));

test('multipart replay hashes actual bytes and cleans failed/replayed incoming files', async () => fixture(async f => {
  const token = await f.issue(), key = 'media-upload-replay-fixture-0001';
  const first = await f.upload(token.secret, key); assert.equal(first.status, 201); const media = await first.json() as Media;
  const repeat = await f.upload(token.secret, key); assert.equal(repeat.status, 201); assert.equal(repeat.headers.get('Idempotency-Replayed'), 'true'); assert.equal((await repeat.json() as Media).id, media.id);
  const changed = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#000' } }).png().toBuffer();
  assert.equal((await f.upload(token.secret, key, changed)).status, 409);
  assert.equal((await f.upload(token.secret, key, undefined, 'different-name.png')).status, 409);
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM media').get() as { n: number }).n, 1);
  assert.equal((await f.upload(token.secret, 'invalid-upload-fixture-0001', Buffer.from('not an image'))).status, 415);
  assert.equal((await f.upload(token.secret, 'invalid-upload-fixture-0001')).status, 201, 'failed request releases its reservation');
  assert.equal((await f.agent('/api/v1/media/' + media.id, token.secret)).status, 200);
  assert.equal((await f.agent('/api/v1/media/' + media.id + '/thumb', token.secret)).status, 200);
  assert.equal((await f.agent('/api/v1/media/' + encodeURIComponent('../../.env'), token.secret)).status, 400);
  assert.equal((await fs.readdir(f.store.uploads)).some(name => name.startsWith('.incoming-')), false);
  const duplicateKey = 'parallel-media-fixture-0001';
  const parallel = await Promise.all([f.upload(token.secret, duplicateKey), f.upload(token.secret, duplicateKey)]);
  assert.ok(parallel.every(response => [201, 409].includes(response.status)));
  assert.ok(parallel.some(response => response.status === 201));
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM media').get() as { n: number }).n, 3);
}));

test('revoking an in-flight upload rejects its result and removes the new unused media', async () => fixture(async f => {
  const token = await f.issue(), key = 'inflight-revoke-fixture-0001';
  const image = await sharp({ create: { width: 2400, height: 2400, channels: 3, background: '#fff' } }).png().toBuffer();
  const pending = f.upload(token.secret, key, image);
  const deadline = Date.now() + 5000;
  let reserved = false;
  while (Date.now() < deadline) {
    if (f.store.db.prepare('SELECT 1 FROM idempotency WHERE credential_id=? AND key=? AND status=0').get(token.id, key)) { reserved = true; break; }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.equal(reserved, true, 'test observes its own isolated upload processing reservation');
  assert.equal((await f.owner('/api/admin/agent-tokens/' + token.id, { method: 'DELETE' })).status, 204);
  const response = await pending; assert.equal(response.status, 401);
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM media').get() as { n: number }).n, 0);
  assert.deepEqual(await fs.readdir(f.store.uploads), []);
}));

test('group authoring enforces revisions and draft membership without exposing public drafts', async () => fixture(async f => {
  const token = await f.issue();
  const draftResponse = await f.agent('/api/v1/posts', token.secret, { method: 'POST', body: JSON.stringify(input()) }); const draft = await draftResponse.json() as Post;
  const body = { title: 'Draft comparison fixture', allowSideBySide: false, postIds: [draft.id] }, key = 'draft-group-create-fixture-0001';
  const first = await f.agent('/api/v1/groups', token.secret, { method: 'POST', body: JSON.stringify(body) }, key); assert.equal(first.status, 201); const group = await first.json() as ComparisonGroup; assert.equal(group.posts[0].id, draft.id);
  const repeat = await f.agent('/api/v1/groups', token.secret, { method: 'POST', body: JSON.stringify(body) }, key); assert.equal(repeat.status, 201); assert.deepEqual(await repeat.json(), group);
  assert.equal((await f.agent('/api/groups/' + group.id)).status, 404);
  const updated = await f.agent('/api/v1/groups/' + group.id, token.secret, { method: 'PUT', body: JSON.stringify({ ...body, allowSideBySide: true, revision: group.revision }) }); assert.equal(updated.status, 200); const current = await updated.json() as ComparisonGroup;
  assert.equal((await f.agent('/api/v1/groups/' + group.id, token.secret, { method: 'PUT', body: JSON.stringify({ ...body, revision: group.revision }) })).status, 409);
  const unscoped = await f.issue(['posts:write']);
  const grouped = f.store.post(f.store.getPost(draft.id)!, true);
  assert.equal((await f.agent('/api/v1/posts/' + draft.id, unscoped.secret, { method: 'PUT', body: JSON.stringify(input({ revision: grouped.revision, title: 'No group transfer' })) })).status, 403);
  const preserved = { ...input({ revision: grouped.revision, title: 'Group preserved without assignment' }) }; delete preserved.groupId;
  assert.equal((await f.agent('/api/v1/posts/' + draft.id, unscoped.secret, { method: 'PUT', body: JSON.stringify(preserved) })).status, 200);
  const deletionKey = 'draft-group-delete-fixture-0001';
  assert.equal((await f.agent('/api/v1/groups/' + group.id, token.secret, { method: 'DELETE', body: JSON.stringify({ revision: current.revision }) }, deletionKey)).status, 204);
  const deletedAgain = await f.agent('/api/v1/groups/' + group.id, token.secret, { method: 'DELETE', body: JSON.stringify({ revision: current.revision }) }, deletionKey); assert.equal(deletedAgain.status, 204); assert.equal(deletedAgain.headers.get('Idempotency-Replayed'), 'true');
  assert.equal(f.store.getPost(draft.id)!.group_id, null);
}));

test('CLI authors only an explicit isolated sample file and refuses file overwrite', async () => fixture(async f => {
  const token = await f.issue(), imageFile = path.join(f.dataDir, 'explicit-source.png'), jsonFile = path.join(f.dataDir, 'explicit-draft.json');
  await fs.writeFile(imageFile, await sharp({ create: { width: 20, height: 20, channels: 3, background: '#fff' } }).png().toBuffer());
  const cli = fileURLToPath(new URL('../scripts/agent.js', import.meta.url));
  const env = { ...process.env, ADMIN_PASSWORD_HASH: '', BENCH_URL: f.origin, BENCH_TOKEN: token.secret };
  const invoke = (args: string[]) => execute(process.execPath, [cli, ...args], { env, timeout: 15000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  const uploaded = await invoke(['media', 'upload', imageFile, '--key', 'isolated-cli-upload-fixture-0001']); const media = JSON.parse(uploaded.stdout) as Media;
  assert.equal(uploaded.stdout.includes(token.secret), false); assert.equal(uploaded.stderr.includes(token.secret), false);
  await fs.writeFile(jsonFile, JSON.stringify(input({ coverId: media.id, references: [{ kind: 'media', mediaId: media.id, label: 'Explicit fixture file' }] })));
  const creation = await invoke(['post', 'create', jsonFile, '--key', 'isolated-cli-create-fixture-0001']); const post = JSON.parse(creation.stdout) as Post; assert.equal(post.status, 'draft'); assert.equal(post.references[0].kind, 'media');
  const download = path.join(f.dataDir, 'explicit-download.webp'); await invoke(['media', 'download', media.id, download]); const original = await fs.readFile(download);
  await assert.rejects(invoke(['media', 'download', media.id, download])); assert.deepEqual(await fs.readFile(download), original);
  await assert.rejects(invoke(['media', 'upload', f.dataDir]));
  const schema = JSON.parse((await invoke(['schema'])).stdout) as typeof authoringSchema; assert.equal(schema['x-api-version'], 1); assert.ok(schema.$defs.Post);
  assert.deepEqual(schema, JSON.parse(await fs.readFile(path.resolve('docs/authoring.schema.json'), 'utf8')));
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n, 1);
}));
