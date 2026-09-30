import type { Express, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { pipeline, Readable } from 'node:stream';
import type { ReadStream } from 'node:fs';
import { ZipFile } from 'yazl';
import { idSchema, referenceSchema } from '../shared/schema.js';
import type { Post, Reference } from '../shared/schema.js';
import { HttpError, Store } from './db.js';
import type { MediaRow, PostRow } from './db.js';
import type { Config } from './config.js';

const maxBundleBytes = 200 * 1024 * 1024;
const maxReferences = 50;
type ReferenceFile = { row: MediaRow; filename: string; fullPath: string; size: number; ino: number; dev: number };

function publishedPost(store: Store, value: unknown): Post {
  if (typeof value !== 'string' || value.length > 180 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new HttpError(404, 'Post not found.');
  const row = store.db.prepare("SELECT * FROM posts WHERE slug=? AND status='published'").get(value) as PostRow | undefined;
  if (!row) throw new HttpError(404, 'Post not found.');
  const post = store.post(row);
  if (post.prompt.length > 100000) throw new HttpError(413, 'The prompt exceeds the download limit.');
  post.references = referenceSchema.array().max(maxReferences).parse(post.references);
  return post;
}

function currentPublication(store: Store, post: Post) {
  const row = store.getPost(post.id);
  if (!row || row.status !== 'published') throw new HttpError(404, 'Post not found.');
  if (row.revision !== post.revision) throw new HttpError(409, 'This post changed. Reload it before downloading.');
}

function downloadName(name: string, kind: MediaRow['kind']) {
  const basename = path.posix.basename(name.replace(/\\/g, '/')).replace(/\.[^.]*$/, '');
  const stem = basename.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 80) || 'reference';
  return `${stem}.${kind === 'video' ? 'mp4' : 'webp'}`;
}

function contentType(kind: MediaRow['kind']) { return kind === 'video' ? 'video/mp4' : 'image/webp'; }

async function referenceFile(store: Store, post: Post, reference: Reference): Promise<ReferenceFile> {
  if (reference.kind !== 'media' || !post.media[reference.mediaId]) throw new HttpError(404, 'Reference not found.');
  const row = store.getMedia(reference.mediaId);
  if (!row || !idSchema.safeParse(row.id).success || !['image', 'video'].includes(row.kind)) throw new HttpError(404, 'Reference not found.');
  const extension = row.kind === 'video' ? 'mp4' : 'webp';
  if (row.filename !== `${row.id}.${extension}`) throw new HttpError(404, 'Reference file is unavailable.');
  try {
    const rootStat = await fsp.lstat(store.uploads);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new HttpError(404, 'Reference file is unavailable.');
    const root = await fsp.realpath(store.uploads);
    const fullPath = path.join(root, row.filename);
    const stat = await fsp.lstat(fullPath);
    const realPath = await fsp.realpath(fullPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || path.dirname(realPath) !== root || path.basename(realPath) !== row.filename) throw new HttpError(404, 'Reference file is unavailable.');
    return { row, filename: downloadName(row.name, row.kind), fullPath, size: stat.size, ino: stat.ino, dev: stat.dev };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, 'Reference file is unavailable.');
  }
}

async function openReference(file: ReferenceFile): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  try {
    const before = await fsp.lstat(file.fullPath);
    if (!before.isFile() || before.isSymbolicLink() || before.ino !== file.ino || before.dev !== file.dev || before.size !== file.size) throw new HttpError(404, 'Reference file changed. Reload before downloading.');
    handle = await fsp.open(file.fullPath, fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW));
    const after = await handle.stat();
    if (!after.isFile() || after.ino !== file.ino || after.dev !== file.dev || after.size !== file.size) throw new HttpError(404, 'Reference file changed. Reload before downloading.');
    return handle;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, 'Reference file is unavailable.');
  }
}

function downloadHeaders(res: Response, filename: string, type: string) {
  res.set({ 'Content-Type': type, 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
}

export function registerReferenceRoutes(app: Express, store: Store, config: Config): void {
  const downloadLimit = rateLimit({ windowMs: 60000, limit: 60, validate: { xForwardedForHeader: config.trustedProxies.length > 0 }, standardHeaders: 'draft-8', legacyHeaders: false, handler: (_req, res) => res.status(429).json({ error: 'Download limit reached. Try again in a minute.' }) });
  app.get('/api/posts/:slug/references/:index/download', downloadLimit, async (req, res) => {
    const post = publishedPost(store, req.params.slug);
    const index = req.params.index;
    if (typeof index !== 'string' || !/^(?:0|[1-9][0-9]?)$/.test(index) || Number(index) >= post.references.length) throw new HttpError(404, 'Reference not found.');
    const file = await referenceFile(store, post, post.references[Number(index)]);
    const handle = await openReference(file);
    try { currentPublication(store, post); }
    catch (error) { await handle.close(); throw error; }
    if (res.destroyed) { await handle.close(); return; }
    downloadHeaders(res, file.filename, contentType(file.row.kind));
    res.set('Content-Length', String(file.size));
    const stream = handle.createReadStream({ end: file.size - 1 });
    pipeline(stream, res, error => { if (error && !res.destroyed) res.destroy(); });
  });

  let activeArchives = 0;
  const bundleLimit = rateLimit({ windowMs: 60000, limit: 10, validate: { xForwardedForHeader: config.trustedProxies.length > 0 }, standardHeaders: 'draft-8', legacyHeaders: false, handler: (_req, res) => res.status(429).json({ error: 'Bundle download limit reached. Try again in a minute.' }) });
  app.get('/api/posts/:slug/bundle', bundleLimit, async (req: Request, res: Response) => {
    if (activeArchives >= 2) throw new HttpError(429, 'Two bundles are downloading. Try again shortly.');
    activeArchives++;
    let released = false;
    const release = () => { if (!released) { released = true; activeArchives--; } };
    res.once('finish', release); res.once('close', release);
    try {
      const post = publishedPost(store, req.params.slug);
      const files: (ReferenceFile & { archivePath: string })[] = [];
      const references = [];
      let totalBytes = 0;
      for (let index = 0; index < post.references.length; index++) {
        const reference = post.references[index];
        if (reference.kind === 'link') { references.push({ position: index + 1, kind: 'link', label: reference.label, url: reference.url }); continue; }
        const file = await referenceFile(store, post, reference);
        totalBytes += file.size;
        if (totalBytes > maxBundleBytes) throw new HttpError(413, 'This bundle exceeds 200 MiB. Download references individually.');
        const archivePath = `references/${String(index + 1).padStart(2, '0')}-${file.filename}`;
        files.push({ ...file, archivePath });
        references.push({ position: index + 1, kind: 'media', mediaId: reference.mediaId, label: reference.label, name: file.row.name, format: contentType(file.row.kind), file: archivePath, downloadUrl: `${config.publicUrl}/api/posts/${post.slug}/references/${index}/download` });
      }
      const prompt = Buffer.from(post.prompt, 'utf8');
      const manifest = Buffer.from(JSON.stringify({ version: 1, post: { id: post.id, title: post.title, revision: post.revision, url: `${config.publicUrl}/posts/${post.slug}` }, prompt: 'prompt.txt', mediaFormats: { images: 'Processed WebP', videos: 'Processed MP4' }, externalLinksFetched: false, references }, null, 2) + '\n', 'utf8');
      // Include a conservative allowance for ZIP headers before any response bytes are written.
      totalBytes += prompt.length + manifest.length + (files.length + 2) * 512;
      if (totalBytes > maxBundleBytes) throw new HttpError(413, 'This bundle exceeds 200 MiB. Download references individually.');
      currentPublication(store, post);
      if (res.destroyed) { release(); return; }
      const zip = new ZipFile();
      const output = zip.outputStream as Readable;
      const streams = new Set<ReadStream>();
      const destroyStreams = () => { for (const stream of streams) stream.destroy(); streams.clear(); };
      const abort = () => { destroyStreams(); output.destroy(); };
      res.once('close', abort);
      zip.on('error', () => { abort(); if (!res.destroyed) res.destroy(); });
      output.on('error', () => { destroyStreams(); if (!res.destroyed) res.destroy(); });
      zip.addBuffer(prompt, 'prompt.txt', { compress: false, mode: 0o100600 });
      zip.addBuffer(manifest, 'references.json', { compress: false, mode: 0o100600 });
      for (const file of files) zip.addReadStreamLazy(file.archivePath, { compress: false, size: file.size, mode: 0o100600 }, callback => {
        if (res.destroyed) { callback(new Error('Download closed.'), Readable.from([])); return; }
        openReference(file).then(handle => {
          if (res.destroyed) { void handle.close().catch(() => {}); callback(new Error('Download closed.'), Readable.from([])); return; }
          const stream = handle.createReadStream({ end: file.size - 1 });
          streams.add(stream); stream.once('close', () => streams.delete(stream));
          callback(null, stream);
        }, () => callback(new Error('Reference file is unavailable.'), Readable.from([])));
      });
      downloadHeaders(res, `${post.slug}-prompt-references.zip`, 'application/zip');
      zip.end();
      pipeline(output, res, error => { destroyStreams(); if (error && !res.destroyed) res.destroy(); });
    } catch (error) { release(); throw error; }
  });
}
