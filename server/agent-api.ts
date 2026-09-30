import type { Express, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { groupSchema, idSchema, postSchema } from '../shared/schema.js';
import type { GroupInput, Media, PostInput } from '../shared/schema.js';
import { Store, HttpError } from './db.js';
import type { MediaRow, PostRow } from './db.js';
import type { Config } from './config.js';

export const agentScopes = ['posts:read', 'posts:write', 'publish', 'media:write', 'groups:write'] as const;
type Scope = typeof agentScopes[number];
type CredentialRow = { id: string; name: string; token_hash: string; scopes_json: string; created_at: string; expires_at: number; revoked_at: string | null; last_used_at: string | null };
type StoredResponse = { request_hash: string; response_json: string; status: number; created_at: number };
type JsonResult = { status: number; body: unknown };
const tokenCreationSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(agentScopes)).min(1).max(agentScopes.length).refine(values => new Set(values).size === values.length, 'Select each scope once.'),
  expiresInDays: z.number().int().min(1).max(90),
}).strict();
const pageSchema = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), limit: z.coerce.number().int().min(1).max(60).default(24), status: z.enum(['draft', 'published']).optional() }).strict();
const revisionSchema = z.object({ revision: z.number().int().min(1) }).strict();
const retentionMs = 24 * 60 * 60 * 1000;
const processingMs = 5 * 60 * 1000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const credential = (row: CredentialRow) => ({ id: row.id, name: row.name, scopes: JSON.parse(row.scopes_json) as Scope[], createdAt: row.created_at, expiresAt: new Date(row.expires_at).toISOString(), revokedAt: row.revoked_at, lastUsedAt: row.last_used_at });

const postJson = z.toJSONSchema(postSchema, { target: 'draft-2020-12' });
postJson.allOf = [
  { if: { properties: { status: { const: 'published' } }, required: ['status'] }, then: { properties: { coverId: { type: 'string', format: 'uuid' } } } },
  { properties: {
    showcaseMediaIds: { uniqueItems: true },
    collections: { description: 'Ordered named render collections. Unique collection IDs, images only, at most 500 image entries across all collections.', items: { properties: { mediaIds: { uniqueItems: true } } } },
    runs: { items: { if: { properties: { provider: { const: 'Other' } }, required: ['provider'] }, then: { required: ['customProvider'], properties: { customProvider: { minLength: 1, pattern: '\\S' } } }, else: { properties: { customProvider: { pattern: '^\\s*$' } } } } },
    references: { items: { if: { properties: { kind: { const: 'link' } }, required: ['kind'] }, then: { properties: { url: { pattern: '^[Hh][Tt][Tt][Pp][Ss]?://[^/@?#\\s]+(?:[/?#]|$)' } } } } },
  } },
];
const groupJson = z.toJSONSchema(groupSchema, { target: 'draft-2020-12' });
groupJson.allOf = [{ properties: { postIds: { uniqueItems: true } } }];
export const authoringSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Agent Benchmarks authoring requests',
  description: 'Version 1 full replacement requests. PUT requires the latest revision. Publication requires a still-image cover and publish scope. Post-level provider, model, reasoningEffort, tokens, elapsedSeconds and estimatedCostUsd are optional; zero is a recorded value and omitted fields preserve stored post metadata on edit. Run custom providers require provider Other and customProvider. Reference links must be HTTP(S) without embedded credentials. Render collections contain ordered still-image IDs; omit collections on edit to preserve existing collections.',
  oneOf: [{ $ref: '#/$defs/Post' }, { $ref: '#/$defs/Group' }],
  $defs: {
    Post: postJson,
    Group: groupJson,
    TokenCreation: z.toJSONSchema(tokenCreationSchema, { target: 'draft-2020-12' }),
  },
  'x-api-version': 1,
  'x-max-total-collection-images': 500,
  'x-authentication': 'Authorization: Bearer owner-issued token',
  'x-write-header': 'Idempotency-Key: 16 to 120 ASCII letters, digits, dot, underscore, colon or hyphen',
  'x-scopes': agentScopes,
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}
function requestKey(req: Request): string {
  const value = req.get('Idempotency-Key') || '';
  if (!/^[A-Za-z0-9._:-]{16,120}$/.test(value)) throw new HttpError(400, 'Supply an Idempotency-Key with 16 to 120 ASCII letters, digits, dot, underscore, colon or hyphen.');
  return value;
}
function requestHash(req: Request, body: unknown) { return hash(canonical([req.method, req.path, body])); }
function incomingPath(req: Request, store: Store) {
  if (!req.file) throw new HttpError(400, 'Choose one image or MP4.');
  const file = path.resolve(req.file.path);
  if (path.dirname(file) !== path.resolve(store.uploads) || !/^\.incoming-[0-9a-f-]{36}$/.test(path.basename(file))) throw new HttpError(400, 'Upload could not be read.');
  return file;
}
async function uploadHash(req: Request, store: Store) {
  const file = incomingPath(req, store), stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new HttpError(400, 'Upload could not be read.');
  const digest = createHash('sha256').update(canonical([req.method, req.path, req.file!.originalname, req.file!.mimetype, stat.size]));
  for await (const chunk of createReadStream(file)) digest.update(chunk as Buffer);
  return digest.digest('hex');
}

export type AgentApiOptions = {
  app: Express; store: Store; config: Config;
  mutations: RequestHandler[]; ownerRead: RequestHandler;
  uploadMiddlewares: RequestHandler[];
  handleUpload: (request: Request) => Promise<Media>;
  removeMedia: (id: string) => Promise<void>;
};

export function registerAgentApi({ app, store, config, mutations, ownerRead, uploadMiddlewares, handleUpload, removeMedia }: AgentApiOptions) {
  const bearer: RequestHandler = (req, res, next) => {
    const authorization = req.get('Authorization') || '';
    if (!config.passwordHash || !/^Bearer abt_[a-f0-9]{64}$/.test(authorization)) return next(new HttpError(401, 'A valid agent credential is required.'));
    const record = store.db.prepare('SELECT * FROM agent_tokens WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?').get(hash(authorization.slice(7)), Date.now()) as CredentialRow | undefined;
    if (!record) return next(new HttpError(401, 'A valid agent credential is required.'));
    record.last_used_at = new Date().toISOString();
    store.db.prepare('UPDATE agent_tokens SET last_used_at=? WHERE id=?').run(record.last_used_at, record.id);
    res.locals.agent = record;
    next();
  };
  const requireScope = (res: Response, scope: Scope) => {
    if (!(JSON.parse((res.locals.agent as CredentialRow).scopes_json) as Scope[]).includes(scope)) throw new HttpError(403, `This credential requires ${scope} scope.`);
  };
  const scope = (value: Scope): RequestHandler => (_req, res, next) => { try { requireScope(res, value); next(); } catch (error) { next(error); } };
  const keyRequired: RequestHandler = (req, _res, next) => { try { requestKey(req); next(); } catch (error) { next(error); } };
  function requireActive(id: string) {
    if (!config.passwordHash || !store.db.prepare('SELECT id FROM agent_tokens WHERE id=? AND revoked_at IS NULL AND expires_at>?').get(id, Date.now())) throw new HttpError(401, 'A valid agent credential is required.');
  }
  function previous(id: string, key: string, digest: string): StoredResponse | undefined {
    const now = Date.now();
    store.db.prepare('DELETE FROM idempotency WHERE credential_id=? AND (created_at<? OR (status=0 AND created_at<?))').run(id, now - retentionMs, now - processingMs);
    const existing = store.db.prepare('SELECT * FROM idempotency WHERE credential_id=? AND key=?').get(id, key) as StoredResponse | undefined;
    if (existing && existing.request_hash !== digest) throw new HttpError(409, 'This Idempotency-Key was used for a different request.');
    if (existing?.status === 0) throw new HttpError(409, 'This request is processing. Retry shortly with the same key.');
    return existing;
  }
  function capacity(id: string) {
    const count = (store.db.prepare('SELECT COUNT(*) AS count FROM idempotency WHERE credential_id=?').get(id) as { count: number }).count;
    if (count >= 1000) throw new HttpError(429, 'This credential reached its daily write limit. Retry after earlier requests expire.');
  }
  function send(res: Response, result: JsonResult, replayed = false) {
    res.set('Idempotency-Replayed', replayed ? 'true' : 'false');
    if (result.status === 204) res.status(204).end();
    else res.status(result.status).json(result.body);
  }
  function write(req: Request, res: Response, body: unknown, operation: () => JsonResult) {
    const id = (res.locals.agent as CredentialRow).id, key = requestKey(req), digest = requestHash(req, body);
    const result = store.db.transaction(() => {
      const existing = previous(id, key, digest);
      if (existing) return { status: existing.status, body: JSON.parse(existing.response_json), replayed: true };
      capacity(id);
      const response = operation();
      store.db.prepare('INSERT INTO idempotency (credential_id,key,request_hash,response_json,status,created_at) VALUES (?,?,?,?,?,?)').run(id, key, digest, JSON.stringify(response.body), response.status, Date.now());
      return { ...response, replayed: false };
    }).immediate();
    send(res, result, result.replayed);
  }
  function postPermissions(res: Response, input: PostInput, existing?: PostRow) {
    if (input.status === 'published' || existing?.status === 'published') requireScope(res, 'publish');
    const groupId = input.groupId === undefined ? existing?.group_id || null : input.groupId;
    if (groupId !== (existing?.group_id || null)) requireScope(res, 'groups:write');
  }
  function groupPermissions(res: Response, input: GroupInput | undefined, id?: string) {
    const previousPosts = id ? store.group(id, true)?.posts || [] : [];
    if (previousPosts.some(post => post.status === 'published') || input?.postIds.some(postId => store.getPost(postId)?.status === 'published')) requireScope(res, 'publish');
  }

  app.get('/api/v1/schema', (_req, res) => res.json(authoringSchema));
  app.get('/api/v1/me', bearer, (_req, res) => res.json({ token: credential(res.locals.agent as CredentialRow) }));
  app.get('/api/v1/posts', bearer, scope('posts:read'), (req, res) => {
    const query = pageSchema.parse(req.query), where = query.status ? 'WHERE status=?' : '', values = query.status ? [query.status] : [];
    const rows = store.db.prepare(`SELECT * FROM posts ${where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...values, query.limit, (query.page - 1) * query.limit) as PostRow[];
    const total = (store.db.prepare(`SELECT COUNT(*) AS total FROM posts ${where}`).get(...values) as { total: number }).total;
    res.json({ posts: rows.map(row => store.summary(row)), total, page: query.page, pages: Math.ceil(total / query.limit) });
  });
  app.get('/api/v1/posts/:id', bearer, scope('posts:read'), (req, res) => {
    const row = store.getPost(idSchema.parse(req.params.id));
    if (!row) throw new HttpError(404, 'Post not found.');
    res.json(store.post(row, true));
  });
  app.post('/api/v1/posts', bearer, scope('posts:write'), keyRequired, (req, res) => {
    const input = postSchema.parse(req.body);
    if (input.revision !== undefined) throw new HttpError(400, 'Omit revision when creating a post.');
    postPermissions(res, input);
    write(req, res, input, () => ({ status: 201, body: store.save(input) }));
  });
  app.put('/api/v1/posts/:id', bearer, scope('posts:write'), keyRequired, (req, res) => {
    const id = idSchema.parse(req.params.id), existing = store.getPost(id), input = postSchema.parse(req.body);
    if (!existing) throw new HttpError(404, 'Post not found.');
    if (input.revision === undefined) throw new HttpError(400, 'Include the current revision when updating a post.');
    postPermissions(res, input, existing);
    write(req, res, input, () => ({ status: 200, body: store.save(input, id) }));
  });
  app.get('/api/v1/media', bearer, scope('posts:read'), (req, res) => {
    const query = pageSchema.omit({ status: true }).parse(req.query);
    const rows = store.db.prepare('SELECT * FROM media ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(query.limit, (query.page - 1) * query.limit) as MediaRow[];
    const total = (store.db.prepare('SELECT COUNT(*) AS total FROM media').get() as { total: number }).total;
    res.json({ media: rows.map(row => store.media(row)), total, page: query.page, pages: Math.ceil(total / query.limit) });
  });
  app.get('/api/v1/media/:id{/:variant}', bearer, scope('posts:read'), (req, res) => {
    const item = store.getMedia(idSchema.parse(req.params.id));
    if (!item || (req.params.variant && req.params.variant !== 'thumb')) throw new HttpError(404, 'Media not found.');
    const filename = req.params.variant ? item.thumb_filename : item.filename;
    const expected = item.id + (req.params.variant ? '-thumb.webp' : item.kind === 'image' ? '.webp' : '.mp4');
    if (filename !== expected) throw new HttpError(500, 'Media is unavailable.');
    res.type(req.params.variant || item.kind === 'image' ? 'webp' : 'mp4').set('Cache-Control', 'private, no-store');
    res.sendFile(filename, { root: store.uploads });
  });
  app.post('/api/v1/media', bearer, scope('media:write'), keyRequired, ...uploadMiddlewares, async (req, res) => {
    const file = incomingPath(req, store), id = (res.locals.agent as CredentialRow).id, key = requestKey(req);
    let reserved = false;
    try {
      const digest = await uploadHash(req, store);
      const existing = store.db.transaction(() => {
        requireActive(id);
        const result = previous(id, key, digest);
        if (result) return result;
        capacity(id);
        store.db.prepare('INSERT INTO idempotency (credential_id,key,request_hash,response_json,status,created_at) VALUES (?,?,?,?,0,?)').run(id, key, digest, '', Date.now());
        reserved = true;
      }).immediate();
      if (existing) { send(res, { status: existing.status, body: JSON.parse(existing.response_json) }, true); return; }
      const media = await handleUpload(req);
      try { requireActive(id); }
      catch (error) { await removeMedia(media.id).catch(() => {}); throw error; }
      store.db.prepare('UPDATE idempotency SET response_json=?,status=201 WHERE credential_id=? AND key=? AND status=0').run(JSON.stringify(media), id, key);
      reserved = false;
      send(res, { status: 201, body: media });
    } finally {
      if (reserved) store.db.prepare('DELETE FROM idempotency WHERE credential_id=? AND key=? AND status=0').run(id, key);
      await fs.unlink(file).catch(() => {});
    }
  });
  app.get('/api/v1/groups', bearer, scope('posts:read'), (req, res) => {
    const query = pageSchema.omit({ status: true }).parse(req.query);
    const rows = store.db.prepare('SELECT id FROM comparison_groups ORDER BY updated_at DESC,id LIMIT ? OFFSET ?').all(query.limit, (query.page - 1) * query.limit) as { id: string }[];
    const total = (store.db.prepare('SELECT COUNT(*) AS total FROM comparison_groups').get() as { total: number }).total;
    res.json({ groups: rows.map(row => store.group(row.id, true)), total, page: query.page, pages: Math.ceil(total / query.limit) });
  });
  app.get('/api/v1/groups/:id', bearer, scope('posts:read'), (req, res) => {
    const group = store.group(idSchema.parse(req.params.id), true);
    if (!group) throw new HttpError(404, 'Comparison group not found.');
    res.json(group);
  });
  app.post('/api/v1/groups', bearer, scope('groups:write'), keyRequired, (req, res) => {
    const input = groupSchema.parse(req.body);
    if (input.revision !== undefined) throw new HttpError(400, 'Omit revision when creating a group.');
    groupPermissions(res, input);
    write(req, res, input, () => ({ status: 201, body: store.saveGroup(input) }));
  });
  app.put('/api/v1/groups/:id', bearer, scope('groups:write'), keyRequired, (req, res) => {
    const id = idSchema.parse(req.params.id), input = groupSchema.parse(req.body);
    if (!store.getGroup(id)) throw new HttpError(404, 'Comparison group not found.');
    if (input.revision === undefined) throw new HttpError(400, 'Include the current revision when updating a group.');
    groupPermissions(res, input, id);
    write(req, res, input, () => ({ status: 200, body: store.saveGroup(input, id) }));
  });
  app.delete('/api/v1/groups/:id', bearer, scope('groups:write'), keyRequired, (req, res) => {
    const id = idSchema.parse(req.params.id), input = revisionSchema.parse(req.body);
    // A replay remains valid after the first deletion; permission is checked on any remaining group.
    groupPermissions(res, undefined, id);
    write(req, res, input, () => { store.deleteGroup(id, input.revision); return { status: 204, body: null }; });
  });

  app.get('/api/admin/agent-tokens', ownerRead, (_req, res) => {
    const rows = store.db.prepare('SELECT * FROM agent_tokens ORDER BY created_at DESC,id LIMIT 200').all() as CredentialRow[];
    res.json({ tokens: rows.map(credential), scopes: agentScopes });
  });
  app.post('/api/admin/agent-tokens', ...mutations, (req, res) => {
    const input = tokenCreationSchema.parse(req.body), now = Date.now();
    const total = (store.db.prepare('SELECT COUNT(*) AS count FROM agent_tokens WHERE revoked_at IS NULL AND expires_at>?').get(now) as { count: number }).count;
    if (total >= 20) throw new HttpError(429, 'Revoke an existing agent credential before creating another.');
    const secret = 'abt_' + randomBytes(32).toString('hex');
    const row: CredentialRow = { id: randomUUID(), name: input.name, token_hash: hash(secret), scopes_json: JSON.stringify(input.scopes), created_at: new Date(now).toISOString(), expires_at: now + input.expiresInDays * 24 * 60 * 60 * 1000, revoked_at: null, last_used_at: null };
    store.db.prepare('INSERT INTO agent_tokens (id,name,token_hash,scopes_json,created_at,expires_at,revoked_at,last_used_at) VALUES (?,?,?,?,?,?,?,?)').run(row.id, row.name, row.token_hash, row.scopes_json, row.created_at, row.expires_at, row.revoked_at, row.last_used_at);
    // The plaintext secret is returned once and is never stored in an idempotency record.
    res.status(201).json({ token: credential(row), secret });
  });
  app.delete('/api/admin/agent-tokens/:id', ...mutations, (req, res) => {
    const id = idSchema.parse(req.params.id);
    if (!store.db.prepare('SELECT id FROM agent_tokens WHERE id=?').get(id)) throw new HttpError(404, 'Agent credential not found.');
    store.db.transaction(() => {
      store.db.prepare('UPDATE agent_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(new Date().toISOString(), id);
      store.db.prepare('DELETE FROM idempotency WHERE credential_id=?').run(id);
    })();
    res.status(204).end();
  });
}
