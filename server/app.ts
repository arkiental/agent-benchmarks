import express from 'express';
import helmet from 'helmet';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { postSchema, idSchema, groupSchema } from '../shared/schema.js';
import type { Comparison } from '../shared/schema.js';
import { Store, HttpError } from './db.js';
import type { PostRow, MediaRow } from './db.js';
import type { Config } from './config.js';
import { auth, verifyPassword, digest } from './auth.js';
import { mediaService } from './media.js';
import { pageHtml } from './sharing.js';
import { registerReferenceRoutes } from './references.js';
import { registerAgentApi } from './agent-api.js';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';

const querySchema = z.object({
  q: z.string().max(160).default(''), model: z.string().max(120).default(''), category: z.string().max(40).default(''),
  provider: z.string().max(80).default(''), reasoning: z.string().max(80).default(''),
  outcome: z.string().max(20).default(''), postId: z.union([idSchema, z.literal('')]).default(''),
  groupId: z.union([idSchema, z.literal('')]).default(''),
  page: z.coerce.number().int().min(1).max(10000).default(1), limit: z.coerce.number().int().min(1).max(60).default(24),
}).strip();
const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');
export function createApp(config: Config, store = new Store(config.dataDir), clientDirectory = clientDir) {
  const app = express();
  const owner = auth(store, config);
  const images = mediaService(store, config);
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustedProxies.length ? config.trustedProxies : false);
  app.set('query parser', 'simple');
  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'blob:'], fontSrc: ["'self'"], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], formAction: ["'self'"], upgradeInsecureRequests: config.publicUrl.startsWith('https:') ? [] : null } },
    strictTransportSecurity: config.publicUrl.startsWith('https:') ? { maxAge: 31536000, includeSubDomains: false } : false,
    referrerPolicy: { policy: 'same-origin' },
  }));
  app.use((_req, res, next) => { res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()'); if (!config.allowIndexing) res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });
  app.get('/healthz', (_req, res) => {
    try { store.db.prepare('SELECT 1').get(); fs.accessSync(store.uploads, fs.constants.R_OK | fs.constants.W_OK); res.json({ status: 'ok' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });
  app.use((req, _res, next) => {
    if (req.headers.host !== new URL(config.publicUrl).host) return next(new HttpError(421, 'Request host does not match PUBLIC_URL.'));
    next();
  });
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '512kb', type: 'application/json' }));
  const mutations = [owner.requireOwner, owner.requireOrigin, owner.csrf];
  // Untrusted forwarded headers are intentionally ignored and must not create log spam.
  const rateValidation = { xForwardedForHeader: config.trustedProxies.length > 0 };
  const apiBucket = (req: express.Request) => {
    const session = owner.session(req);
    if (session) return { key: `owner:${session.token_hash}`, limit: 600 };
    const authorization = req.get('Authorization') || '';
    if (config.passwordHash && /^Bearer abt_[a-f0-9]{64}$/.test(authorization)) {
      const credential = store.db.prepare('SELECT id FROM agent_tokens WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?').get(digest(authorization.slice(7)),Date.now()) as { id: string } | undefined;
      if (credential) return { key: `agent:${credential.id}`, limit: 600 };
    }
    return { key: `visitor:${ipKeyGenerator(req.ip || req.socket.remoteAddress || '127.0.0.1')}`, limit: 240 };
  };
  const apiLimit = rateLimit({ windowMs: 60000, keyGenerator: req => apiBucket(req).key, limit: req => apiBucket(req).limit, validate: rateValidation, standardHeaders: 'draft-8', legacyHeaders: false, handler: (_req, res) => res.status(429).json({ error: 'Too many requests. Try again in a minute.' }) });
  app.use('/api', apiLimit);
  app.get('/api/site', (_req, res) => res.json({ name: config.siteName, publicUrl: config.publicUrl, uploadMaxBytes: config.uploadMaxBytes, videoMaxBytes: config.videoMaxBytes }));
  app.get('/api/catalog', (_req, res) => {
    const models = (store.db.prepare("SELECT DISTINCT runs.model FROM runs JOIN posts ON posts.id=runs.post_id WHERE posts.status='published' ORDER BY runs.model").all() as { model: string }[]).map(row => row.model);
    const categories = (store.db.prepare("SELECT DISTINCT category FROM posts WHERE status='published' ORDER BY category").all() as { category: string }[]).map(row => row.category);
    const providers = (store.db.prepare("SELECT DISTINCT CASE WHEN provider='Other' THEN custom_provider ELSE provider END AS provider_name FROM runs JOIN posts ON posts.id=runs.post_id WHERE posts.status='published' AND COALESCE(provider,'')<>'' AND CASE WHEN provider='Other' THEN custom_provider ELSE provider END <>'' ORDER BY provider_name").all() as { provider_name: string }[]).map(row => row.provider_name);
    const reasoningEfforts = (store.db.prepare("SELECT DISTINCT reasoning_effort FROM runs JOIN posts ON posts.id=runs.post_id WHERE posts.status='published' AND reasoning_effort<>'' ORDER BY reasoning_effort").all() as { reasoning_effort: string }[]).map(row => row.reasoning_effort);
    res.json({ models, categories, providers, reasoningEfforts });
  });
  app.get('/api/posts', (req, res) => {
    const query = querySchema.parse(req.query);
    const params = [query.q, `%${query.q}%`, `%${query.q}%`, query.category, query.category, query.model, query.provider, query.reasoning, query.model, query.model, query.provider, query.provider, query.reasoning, query.reasoning];
    const where = "posts.status='published' AND (?='' OR title LIKE ? OR summary LIKE ?) AND (?='' OR category=?) AND ((?='' AND ?='' AND ?='') OR EXISTS(SELECT 1 FROM runs WHERE runs.post_id=posts.id AND (?='' OR model=?) AND (?='' OR CASE WHEN provider='Other' THEN custom_provider ELSE provider END=?) AND (?='' OR reasoning_effort=?)))";
    const total = (store.db.prepare(`SELECT COUNT(*) AS total FROM posts WHERE ${where}`).get(...params) as { total: number }).total;
    const rows = store.db.prepare(`SELECT * FROM posts WHERE ${where} ORDER BY published_at DESC,id LIMIT ? OFFSET ?`).all(...params,query.limit,(query.page-1)*query.limit) as PostRow[];
    res.json({ posts: rows.map(row => store.summary(row)), total, page: query.page, pages: Math.ceil(total/query.limit) });
  });
  app.get('/api/posts/:slug', (req, res) => {
    const slug = z.string().max(180).parse(req.params.slug);
    const row = store.db.prepare("SELECT * FROM posts WHERE slug=? AND status='published'").get(slug) as PostRow | undefined;
    if (!row) throw new HttpError(404, 'Post not found.');
    res.json(store.post(row));
  });
  app.get('/api/compare', (req, res) => {
    const query = querySchema.parse(req.query);
    const group = query.groupId ? store.group(query.groupId) : undefined;
    if (query.groupId && !group) throw new HttpError(404, 'Group not found.');
    if (group && !group.allowSideBySide) throw new HttpError(403, 'Side-by-side comparison is disabled for this group.');
    const params = [query.model,query.model,query.category,query.category,query.outcome,query.outcome,query.postId,query.postId,query.groupId,query.groupId,query.provider,query.provider,query.reasoning,query.reasoning];
    const where = "posts.status='published' AND (?='' OR runs.model=?) AND (?='' OR posts.category=?) AND (?='' OR runs.outcome=?) AND (?='' OR posts.id=?) AND (?='' OR posts.group_id=?) AND (?='' OR CASE WHEN runs.provider='Other' THEN runs.custom_provider ELSE runs.provider END=?) AND (?='' OR runs.reasoning_effort=?)";
    const total = (store.db.prepare(`SELECT COUNT(*) AS total FROM runs JOIN posts ON posts.id=runs.post_id WHERE ${where}`).get(...params) as { total: number }).total;
    const rows = store.db.prepare(`SELECT runs.id AS run_id,posts.* FROM runs JOIN posts ON posts.id=runs.post_id WHERE ${where} ORDER BY posts.published_at DESC,runs.position LIMIT ? OFFSET ?`).all(...params,query.limit,(query.page-1)*query.limit) as (PostRow & { run_id: string })[];
    const runs: Comparison[] = rows.map(row => {
      const post = store.post(row);
      const run = post.runs.find(run => run.id === row.run_id)!;
      const cover = post.coverId ? post.media[post.coverId] : null;
      return { ...run, postId: post.id, postTitle: post.title, slug: post.slug, category: post.category, isDemo: post.isDemo, cover, resultImages: run.resultMediaIds.map(id => post.media[id]).filter(Boolean), groupId: post.groupId, canCompare: !post.group || post.group.allowSideBySide };
    });
    res.json({ runs, total, page: query.page, pages: Math.ceil(total/query.limit), group: group || null, posts: group ? group.posts.map(post => store.post(store.getPost(post.id)!)) : [] });
  });
  app.get('/api/admin/session', (req, res) => {
    const session = owner.session(req);
    res.json({ configured: Boolean(config.passwordHash), authenticated: Boolean(session), csrf: session?.csrf || null });
  });
  const loginLimit = rateLimit({ windowMs: 15 * 60000, limit: 8, validate: rateValidation, standardHeaders: 'draft-8', legacyHeaders: false, skipSuccessfulRequests: true, handler: (_req, res) => res.status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' }) });
  app.post('/api/admin/login', owner.requireOrigin, loginLimit, async (req, res) => {
    if (!config.passwordHash) throw new HttpError(503, 'Owner sign-in has not been configured.');
    const { password } = z.object({ password: z.string().min(1).max(256) }).strict().parse(req.body);
    if (!await verifyPassword(password, config.passwordHash)) throw new HttpError(401, 'Password is incorrect.');
    owner.revoke(req, res);
    const csrf = owner.issue(res);
    res.json({ authenticated: true, csrf });
  });
  app.post('/api/admin/logout', ...mutations, (req, res) => { owner.revoke(req, res); res.status(204).end(); });
  app.get('/api/admin/groups', owner.requireOwner, (_req, res) => {
    const rows = store.db.prepare('SELECT id FROM comparison_groups ORDER BY updated_at DESC LIMIT 200').all() as { id: string }[];
    res.json({ groups: rows.map(row => store.group(row.id,true)) });
  });
  app.post('/api/admin/groups', ...mutations, (req,res) => {
    if ((store.db.prepare('SELECT COUNT(*) AS count FROM comparison_groups').get() as { count: number }).count >= 200) throw new HttpError(400, 'The journal supports up to 200 comparison groups.');
    res.status(201).json(store.saveGroup(groupSchema.parse(req.body)));
  });
  app.put('/api/admin/groups/:id', ...mutations, (req,res) => {
    const id = idSchema.parse(req.params.id);
    if (!store.getGroup(id)) throw new HttpError(404,'Group not found.');
    res.json(store.saveGroup(groupSchema.parse(req.body),id));
  });
  app.delete('/api/admin/groups/:id', ...mutations, (req,res) => {
    store.deleteGroup(idSchema.parse(req.params.id),z.object({ revision: z.number().int().min(1) }).strict().parse(req.body).revision);
    res.status(204).end();
  });
  app.get('/api/admin/posts', owner.requireOwner, (req, res) => {
    const query = querySchema.parse(req.query);
    const rows = store.db.prepare('SELECT * FROM posts ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(query.limit,(query.page-1)*query.limit) as PostRow[];
    const total = (store.db.prepare('SELECT COUNT(*) AS total FROM posts').get() as { total: number }).total;
    res.json({ posts: rows.map(row => store.summary(row)), total, page: query.page, pages: Math.ceil(total/query.limit) });
  });
  app.get('/api/admin/posts/:id', owner.requireOwner, (req, res) => {
    const row = store.getPost(idSchema.parse(req.params.id));
    if (!row) throw new HttpError(404, 'Post not found.');
    res.json(store.post(row,true));
  });
  app.post('/api/admin/posts', ...mutations, (req, res) => res.status(201).json(store.save(postSchema.parse(req.body))));
  app.put('/api/admin/posts/:id', ...mutations, (req, res) => {
    const id = idSchema.parse(req.params.id);
    if (!store.getPost(id)) throw new HttpError(404, 'Post not found.');
    res.json(store.save(postSchema.parse(req.body),id));
  });
  app.delete('/api/admin/posts/:id', ...mutations, (req, res) => {
    const { revision } = z.object({ revision: z.number().int().min(1) }).strict().parse(req.body);
    store.deletePost(idSchema.parse(req.params.id),revision);
    res.status(204).end();
  });
  app.get('/api/admin/media', owner.requireOwner, (req, res) => {
    const query = querySchema.parse(req.query);
    const rows = store.db.prepare('SELECT media.*,COUNT(post_media.post_id) AS used FROM media LEFT JOIN post_media ON media.id=post_media.media_id GROUP BY media.id ORDER BY media.created_at DESC LIMIT ? OFFSET ?').all(query.limit,(query.page-1)*query.limit) as (MediaRow & { used: number })[];
    const totals = store.db.prepare('SELECT COUNT(*) AS total,COALESCE(SUM(bytes),0) AS bytes FROM media').get() as { total: number; bytes: number };
    res.json({ media: rows.map(row => ({ ...store.media(row), used: row.used })), ...totals, limitBytes: config.storageMaxBytes, page: query.page, pages: Math.ceil(totals.total/query.limit) });
  });
  const upload = multer({ storage: multer.diskStorage({ destination: store.uploads,filename: (_req,_file,done) => done(null,`.incoming-${randomUUID()}`) }), limits: { fileSize: Math.max(config.uploadMaxBytes,config.videoMaxBytes), files: 1, fields: 0, parts: 1 } });
  const uploadLimit = rateLimit({ windowMs: 60000, limit: 100, validate: rateValidation, standardHeaders: 'draft-8', legacyHeaders: false, handler: (_req, res) => res.status(429).json({ error: 'Upload limit reached. Try again in a minute.' }) });
  let incoming = 0;
  const uploadCapacity: express.RequestHandler = (_req,res,next) => {
    if (incoming >= 2) return next(new HttpError(429,'Two uploads are processing. Try again shortly.'));
    incoming++; let released=false;
    const release = () => { if (!released) { released=true; incoming--; } };
    res.once('finish',release); res.once('close',release); next();
  };
  const handleUpload = async (req: express.Request) => {
    if (!req.file) throw new HttpError(400, 'Choose an image or MP4.');
    try {
      if (req.file.mimetype !== 'video/mp4' && req.file.size > config.uploadMaxBytes) throw new HttpError(413,'Image exceeds the upload limit.');
      return req.file.mimetype === 'video/mp4' ? await images.uploadVideo(req.file.path,req.file.originalname) : await images.upload(await fsp.readFile(req.file.path),req.file.originalname,req.file.mimetype);
    }
    finally { await fsp.unlink(req.file.path).catch(() => {}); }
  };
  app.post('/api/admin/media', ...mutations, uploadLimit, uploadCapacity, upload.single('image'), async (req,res) => res.status(201).json(await handleUpload(req)));
  app.delete('/api/admin/media/:id', ...mutations, async (req, res) => { await images.remove(idSchema.parse(req.params.id)); res.status(204).end(); });
  registerReferenceRoutes(app,store,config);
  registerAgentApi({ app,store,config,mutations,ownerRead:owner.requireOwner,uploadMiddlewares:[uploadLimit,uploadCapacity,upload.single('image')],handleUpload,removeMedia:images.remove });
  app.get('/media/:id{/:variant}', (req, res) => {
    const id = idSchema.parse(req.params.id);
    if (req.params.variant && req.params.variant !== 'thumb') throw new HttpError(404, 'Image not found.');
    const media = store.getMedia(id);
    const isPublic = store.db.prepare("SELECT 1 FROM post_media JOIN posts ON post_media.post_id=posts.id WHERE post_media.media_id=? AND posts.status='published' LIMIT 1").get(id);
    if (!media || (!isPublic && !owner.session(req))) throw new HttpError(404, 'Image not found.');
    res.type(req.params.variant === 'thumb' || media.kind === 'image' ? 'webp' : 'mp4');
    // Publication can be revoked, so browsers must revalidate even UUID-named media.
    res.set('Cache-Control', isPublic ? 'public, max-age=0, must-revalidate' : 'private, no-store');
    const filename = req.params.variant === 'thumb' ? media.thumb_filename : media.filename;
    res.sendFile(filename,{ root: store.uploads });
  });
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Endpoint not found.')));
  if (fs.existsSync(clientDirectory)) {
    const template = fs.readFileSync(path.join(clientDirectory,'index.html'),'utf8');
    app.get('/posts/:slug', (req,res) => {
      const row = store.db.prepare("SELECT * FROM posts WHERE slug=? AND status='published'").get(z.string().max(180).parse(req.params.slug)) as PostRow | undefined;
      res.status(row ? 200 : 404).set('Cache-Control','no-store').type('html').send(pageHtml(template,config,row ? store.post(row) : undefined));
    });
    app.use(express.static(clientDirectory,{ index: false, dotfiles: 'deny', maxAge: '1d', setHeaders: (res, file) => { if (path.basename(file) === 'index.html') res.setHeader('Cache-Control', 'no-cache'); } }));
    app.get('/{*path}', (_req, res) => {
      const html = pageHtml(template,config);
      res.set('Cache-Control','no-cache').type('html').send(html);
    });
  }
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return _next(error);
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message || 'Check the form.', fields: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
    if (error instanceof multer.MulterError) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the upload limit.' : 'Upload one file per request.' });
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    const status = (error as { status?: number })?.status;
    if (status === 413 || status === 400) return res.status(status).json({ error: status === 413 ? 'Request is too large.' : 'Request could not be read.' });
    console.error('Request failed:', error instanceof Error ? error.name : 'Unknown error');
    res.status(500).json({ error: 'The server could not complete this request. Try again.' });
  });
  return { app, store };
}
