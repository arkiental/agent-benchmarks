import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest, createServer } from 'node:http';
import type { ClientRequest, IncomingMessage } from 'node:http';
import express from 'express';
import sharp from 'sharp';
import { fromBufferPromise } from 'yauzl';
import { z } from 'zod';
import { readConfig } from '../server/config.js';
import { Store, HttpError } from '../server/db.js';
import { mediaService } from '../server/media.js';
import { registerReferenceRoutes } from '../server/references.js';
import { postSchema, referenceSchema } from '../shared/schema.js';
import type { Media, Post, PostInput } from '../shared/schema.js';
import { fixtureVideo } from './fixtures.js';

type Fixture = { store: Store; origin: string; dataDir: string; image: (name?: string) => Promise<Media>; video: () => Promise<Media>; post: (cover: Media, changes?: Partial<PostInput>) => Post; request: (route: string, init?: RequestInit) => Promise<Response> };
async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const root = path.resolve('.local'); await fs.mkdir(root, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(root, 'reference-test-'));
  const config = readConfig({ PUBLIC_URL: 'http://127.0.0.1:3000', DATA_DIR: dataDir, UPLOAD_MAX_MB: '1', VIDEO_MAX_MB: '1' });
  const store = new Store(dataDir);
  const media = mediaService(store, config);
  const app = express(); app.set('trust proxy', false);
  app.use((req, _res, next) => { if (req.headers.host !== new URL(config.publicUrl).host) return next(new HttpError(421, 'Invalid host.')); next(); });
  registerReferenceRoutes(app, store, config);
  app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(error);
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'Invalid reference.' });
    res.status(500).json({ error: 'Request failed.' });
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`; config.publicUrl = origin;
  const image = async (name = 'reference.png') => media.upload(await sharp({ create: { width: 60, height: 40, channels: 3, background: '#fff' } }).png().toBuffer(), name, 'image/png');
  const video = async () => media.uploadVideo(await fixtureVideo(path.join(dataDir, 'video-input')), 'reference-timelapse.mp4');
  const post = (cover: Media, changes: Partial<PostInput> = {}) => store.save(postSchema.parse({ title: 'Reference fixture', slug: 'reference-fixture', summary: '', category: 'Code', prompt: 'An isolated test prompt.\nSecond line.', body: '', status: 'published', isDemo: true, coverId: cover.id, showcaseMediaIds: [], references: [], runs: [], progress: [], ...changes }));
  try { await run({ store, origin, dataDir, image, video, post, request: (route, init = {}) => fetch(`${origin}${route}`, init) }); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    assert.equal(path.dirname(dataDir), root); assert.ok(path.basename(dataDir).startsWith('reference-test-'));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function unzip(buffer: Buffer) {
  const zip = await fromBufferPromise(buffer, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
  const files = new Map<string, Buffer>();
  try {
    for await (const entry of zip.eachEntry()) {
      const chunks: Buffer[] = [];
      for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(Buffer.from(chunk));
      const data = Buffer.concat(chunks); assert.equal(data.length, entry.uncompressedSize); files.set(entry.fileName, data);
    }
  } finally { zip.close(); }
  return files;
}

test('published reference downloads preserve ordering, exact prompt, processed image/video bytes and external URLs', async () => withFixture(async fixture => {
  const cover = await fixture.image('cover.png');
  const image = await fixture.image('../../unsafe\r\nname".png'); const video = await fixture.video();
  const prompt = 'Keep all of this prompt exactly.\nUnicode: café, 世界.\n'.repeat(1000);
  const link = 'https://example.invalid/reference?q=recorded#section';
  const post = fixture.post(cover, { prompt, references: [{ kind: 'media', mediaId: video.id, label: 'Timelapse reference' }, { kind: 'link', url: link, label: 'Recorded link' }, { kind: 'media', mediaId: image.id, label: 'Image reference' }] });
  const response = await fixture.request(`/api/posts/${post.slug}/bundle`);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="reference-fixture-prompt-references.zip"'); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const files = await unzip(Buffer.from(await response.arrayBuffer()));
  assert.deepEqual([...files.keys()], ['prompt.txt', 'references.json', 'references/01-reference-timelapse.mp4', 'references/03-unsafename.webp']);
  assert.equal(files.get('prompt.txt')!.toString(), prompt);
  const manifest = JSON.parse(files.get('references.json')!.toString());
  assert.equal(manifest.version, 1); assert.equal(manifest.post.id, post.id); assert.equal(manifest.externalLinksFetched, false);
  assert.deepEqual(manifest.references.map((reference: { position: number; kind: string }) => [reference.position, reference.kind]), [[1, 'media'], [2, 'link'], [3, 'media']]);
  assert.equal(manifest.references[1].url, link); assert.equal(manifest.references[0].format, 'video/mp4'); assert.equal(manifest.references[2].format, 'image/webp');
  for (const [index, media, archiveName] of [[0, video, 'references/01-reference-timelapse.mp4'], [2, image, 'references/03-unsafename.webp']] as const) {
    const download = await fixture.request(`/api/posts/${post.slug}/references/${index}/download`);
    assert.equal(download.status, 200); assert.equal(download.headers.get('cache-control'), 'private, no-store');
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff'); assert.match(download.headers.get('content-disposition')!, /^attachment; filename="[a-zA-Z0-9_-]+\.(mp4|webp)"$/);
    const bytes = Buffer.from(await download.arrayBuffer()); assert.deepEqual(bytes, files.get(archiveName));
    assert.deepEqual(bytes, await fs.readFile(path.join(fixture.store.uploads, fixture.store.getMedia(media.id)!.filename)));
    assert.equal(manifest.references[index].downloadUrl, `${fixture.origin}/api/posts/${post.slug}/references/${index}/download`);
  }
}));

test('drafts and unpublished posts have no bundle or individual download access; reference indices cannot expose other media', async () => withFixture(async fixture => {
  const cover = await fixture.image('cover.png'), reference = await fixture.image(), privateMedia = await fixture.image('private.png');
  const draft = fixture.post(cover, { status: 'draft', references: [{ kind: 'media', mediaId: reference.id, label: '' }] });
  assert.equal((await fixture.request(`/api/posts/${draft.slug}/bundle`)).status, 404);
  assert.equal((await fixture.request(`/api/posts/${draft.slug}/references/0/download`)).status, 404);
  fixture.store.db.prepare("UPDATE posts SET status='published',revision=revision+1 WHERE id=?").run(draft.id);
  const published = fixture.store.post(fixture.store.getPost(draft.id)!);
  for (const index of ['1', '50', '-1', '00', '0.0', privateMedia.id, encodeURIComponent('../0')]) assert.equal((await fixture.request(`/api/posts/${published.slug}/references/${index}/download`)).status, 404);
  assert.equal((await fixture.request(`/api/posts/${published.slug}/references/0/download`)).status, 200);
  fixture.store.db.prepare("UPDATE posts SET status='draft', revision=revision+1 WHERE id=?").run(published.id);
  assert.equal((await fixture.request(`/api/posts/${published.slug}/bundle`)).status, 404);
  assert.equal((await fixture.request(`/api/posts/${published.slug}/references/0/download`)).status, 404);
}));

test('reference URL manifests never trigger server fetches, and link downloads do not proxy external resources', async () => withFixture(async fixture => {
  let requests = 0;
  const canary = createServer((_req, res) => { requests++; res.end('Must not be fetched.'); });
  canary.listen(0, '127.0.0.1'); await once(canary, 'listening');
  try {
    const url = `http://127.0.0.1:${(canary.address() as { port: number }).port}/private-resource`;
    const post = fixture.post(await fixture.image(), { references: [{ kind: 'link', url, label: 'Local fixture URL' }] });
    const bundle = await fixture.request(`/api/posts/${post.slug}/bundle`); assert.equal(bundle.status, 200);
    const files = await unzip(Buffer.from(await bundle.arrayBuffer())); assert.deepEqual([...files.keys()], ['prompt.txt', 'references.json']);
    assert.equal(JSON.parse(files.get('references.json')!.toString()).references[0].url, url);
    assert.equal((await fixture.request(`/api/posts/${post.slug}/references/0/download`)).status, 404); assert.equal(requests, 0);
    for (const invalid of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.invalid/file', 'https://user:secret@example.invalid/']) assert.equal(referenceSchema.safeParse({ kind: 'link', url: invalid, label: '' }).success, false);
  } finally { await new Promise<void>((resolve, reject) => canary.close(error => error ? reject(error) : resolve())); }
}));

test('reference files must belong to the selected post and use immutable UUID paths', async () => withFixture(async fixture => {
  const cover = await fixture.image(), reference = await fixture.image('reference-2.png'), privateMedia = await fixture.image('private.png');
  const post = fixture.post(cover, { references: [{ kind: 'media', mediaId: reference.id, label: '' }] });
  fixture.store.db.prepare('UPDATE posts SET references_json=? WHERE id=?').run(JSON.stringify([{ kind: 'media', mediaId: privateMedia.id, label: '' }]), post.id);
  assert.equal((await fixture.request(`/api/posts/${post.slug}/references/0/download`)).status, 404); assert.equal((await fixture.request(`/api/posts/${post.slug}/bundle`)).status, 404);
  fixture.store.db.prepare('UPDATE posts SET references_json=? WHERE id=?').run(JSON.stringify([{ kind: 'media', mediaId: reference.id, label: '' }]), post.id);
  fixture.store.db.prepare('UPDATE media SET filename=? WHERE id=?').run('../private.txt', reference.id);
  await fs.writeFile(path.join(fixture.dataDir, 'private.txt'), 'Private fixture marker.');
  const download = await fixture.request(`/api/posts/${post.slug}/references/0/download`);
  assert.equal(download.status, 404); assert.doesNotMatch(await download.text(), /Private fixture marker/);
  assert.equal((await fixture.request(`/api/posts/${post.slug}/bundle`)).status, 404);
}));

test('bundle size limits use on-disk bytes and reject oversize downloads before sending ZIP headers', async () => withFixture(async fixture => {
  const image = await fixture.image(), post = fixture.post(image, { references: [{ kind: 'media', mediaId: image.id, label: '' }] });
  const filename = path.join(fixture.store.uploads, fixture.store.getMedia(image.id)!.filename);
  if (process.platform === 'win32') {
    assert.equal(path.dirname(filename), path.join(fixture.dataDir, 'uploads'));
    execFileSync('fsutil.exe', ['sparse', 'setflag', filename], { windowsHide: true, timeout: 10000, stdio: 'pipe' });
  }
  await fs.truncate(filename, 200 * 1024 * 1024 + 1);
  fixture.store.db.prepare('UPDATE media SET bytes=1 WHERE id=?').run(image.id);
  const response = await fixture.request(`/api/posts/${post.slug}/bundle`);
  assert.equal(response.status, 413); assert.match(response.headers.get('content-type')!, /application\/json/); assert.equal(response.headers.get('content-disposition'), null);
  assert.match((await response.json() as { error: string }).error, /200 MiB/);
  fixture.store.db.prepare('UPDATE posts SET references_json=? WHERE id=?').run(JSON.stringify(Array.from({ length: 51 }, () => ({ kind: 'media', mediaId: image.id, label: '' }))), post.id);
  assert.equal((await fixture.request(`/api/posts/${post.slug}/bundle`)).status, 400);
}));

test('only two streaming archives run at once and aborting them releases capacity', async () => withFixture(async fixture => {
  const image = await fixture.image(), post = fixture.post(image, { references: [{ kind: 'media', mediaId: image.id, label: '' }] });
  const filename = path.join(fixture.store.uploads, fixture.store.getMedia(image.id)!.filename);
  const originalSize = (await fs.stat(filename)).size;
  await fs.truncate(filename, 16 * 1024 * 1024);
  const held: { req: ClientRequest; res: IncomingMessage }[] = [];
  const hold = async () => {
    const response = await new Promise<{ req: ClientRequest; res: IncomingMessage }>((resolve, reject) => {
      const req = httpRequest(`${fixture.origin}/api/posts/${post.slug}/bundle`, res => { res.pause(); resolve({ req, res }); });
      req.on('error', reject); req.end();
    });
    held.push(response); assert.equal(response.res.statusCode, 200);
  };
  try {
    await hold(); await hold();
    const limited = await fixture.request(`/api/posts/${post.slug}/bundle`); assert.equal(limited.status, 429); assert.match(await limited.text(), /Two bundles/);
    for (const item of held) { item.res.destroy(); item.req.destroy(); }
    await fs.truncate(filename, originalSize);
    let retry: Response | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      retry = await fixture.request(`/api/posts/${post.slug}/bundle`);
      if (retry.status !== 429) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(retry!.status, 200); await retry!.arrayBuffer();
  } finally { for (const item of held) { item.res.destroy(); item.req.destroy(); } }
}));

test('untrusted forwarded addresses cannot bypass per-IP bundle rate limits', async () => withFixture(async fixture => {
  for (let index = 0; index < 10; index++) assert.equal((await fixture.request('/api/posts/missing-post/bundle', { headers: { 'X-Forwarded-For': `192.0.2.${index + 1}` } })).status, 404);
  const limited = await fixture.request('/api/posts/missing-post/bundle', { headers: { 'X-Forwarded-For': '198.51.100.2' } });
  assert.equal(limited.status, 429); assert.ok(limited.headers.get('retry-after'));
}));

test('reference downloads reject symlinked files', { skip: process.platform === 'win32' ? 'Windows symbolic-link creation requires privileges; exercised in Linux CI.' : false }, async () => withFixture(async fixture => {
  const image = await fixture.image(), post = fixture.post(image, { references: [{ kind: 'media', mediaId: image.id, label: '' }] });
  const filename = path.join(fixture.store.uploads, fixture.store.getMedia(image.id)!.filename);
  const outside = path.join(fixture.dataDir, 'outside.txt'); await fs.writeFile(outside, 'Private fixture marker.');
  await fs.unlink(filename); await fs.symlink(outside, filename);
  assert.equal((await fixture.request(`/api/posts/${post.slug}/references/0/download`)).status, 404); assert.equal((await fixture.request(`/api/posts/${post.slug}/bundle`)).status, 404);
}));
