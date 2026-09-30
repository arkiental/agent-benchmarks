import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { providerLabel } from '../shared/schema.js';
import type { Post, PostInput, Media, Run, PostSummary, GroupInput, ComparisonGroup } from '../shared/schema.js';

export type PostRow = { id: string; title: string; slug: string; summary: string; category: Post['category']; prompt: string; body: string; status: Post['status']; is_demo: number; cover_id: string | null; progress_json: string; showcase_json: string; collections_json: string; references_json: string; group_id: string | null; revision: number; created_at: string; updated_at: string; published_at: string | null };
export type GroupRow = { id: string; title: string; allow_side_by_side: number; revision: number; created_at: string; updated_at: string };
export type MediaRow = { id: string; name: string; kind: 'image' | 'video'; duration_seconds: number | null; width: number; height: number; bytes: number; created_at: string; filename: string; thumb_filename: string };
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

export class Store {
  db: Database.Database;
  uploads: string;
  constructor(public dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.uploads = path.join(dataDir, 'uploads');
    fs.mkdirSync(this.uploads, { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(dataDir, 'journal.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    try { this.migrate(); }
    catch (error) { this.db.close(); throw error; }
  }
  migrate() {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > 4) throw new Error('Database is newer than this application. Restore a compatible application version.');
    if (version === 0) this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE posts (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
          summary TEXT NOT NULL, category TEXT NOT NULL, prompt TEXT NOT NULL, body TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('draft','published')), is_demo INTEGER NOT NULL DEFAULT 0,
          cover_id TEXT REFERENCES media(id), progress_json TEXT NOT NULL DEFAULT '[]', revision INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, published_at TEXT
        );
        CREATE TABLE media (id TEXT PRIMARY KEY, name TEXT NOT NULL, filename TEXT NOT NULL UNIQUE, thumb_filename TEXT NOT NULL UNIQUE,
          width INTEGER NOT NULL, height INTEGER NOT NULL, bytes INTEGER NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE runs (id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
          model TEXT NOT NULL, harness TEXT NOT NULL, author TEXT NOT NULL, elapsed_seconds INTEGER,
          outcome TEXT NOT NULL, notes TEXT NOT NULL, conditions TEXT NOT NULL, result_ids_json TEXT NOT NULL, position INTEGER NOT NULL);
        CREATE TABLE post_media (post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
          media_id TEXT NOT NULL REFERENCES media(id), PRIMARY KEY(post_id,media_id));
        CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL, auth_revision TEXT NOT NULL);
        CREATE INDEX posts_public ON posts(status,published_at DESC);
        CREATE INDEX runs_post ON runs(post_id,position);
        CREATE INDEX runs_model ON runs(model,post_id);
        CREATE INDEX media_links ON post_media(media_id,post_id);
        PRAGMA user_version = 1;
      `);
    })();
    if (version < 2) this.db.transaction(() => {
      this.db.exec(`ALTER TABLE posts ADD COLUMN showcase_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE media ADD COLUMN kind TEXT NOT NULL DEFAULT 'image';
        ALTER TABLE media ADD COLUMN duration_seconds REAL;
        ALTER TABLE runs ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT '';
        ALTER TABLE runs ADD COLUMN tokens INTEGER;
        ALTER TABLE runs ADD COLUMN estimated_cost_usd REAL;
        PRAGMA user_version = 2;`);
    })();
    if (version < 3) this.db.transaction(() => {
      this.db.exec(`CREATE TABLE comparison_groups (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, allow_side_by_side INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        ALTER TABLE posts ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE posts ADD COLUMN group_id TEXT REFERENCES comparison_groups(id) ON DELETE SET NULL;
        ALTER TABLE runs ADD COLUMN provider TEXT;
        ALTER TABLE runs ADD COLUMN custom_provider TEXT NOT NULL DEFAULT '';
        CREATE INDEX posts_group ON posts(group_id,status);
        CREATE TABLE agent_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
          scopes_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL,
          revoked_at TEXT, last_used_at TEXT);
        CREATE TABLE idempotency (credential_id TEXT NOT NULL REFERENCES agent_tokens(id) ON DELETE CASCADE,
          key TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT, status INTEGER,
          created_at INTEGER NOT NULL, PRIMARY KEY(credential_id,key));
        PRAGMA user_version = 3;`);
    })();
    if (version < 4) this.db.transaction(() => {
      this.db.exec(`ALTER TABLE posts ADD COLUMN collections_json TEXT NOT NULL DEFAULT '[]';
        PRAGMA user_version = 4;`);
    })();
  }
  getPost(id: string): PostRow | undefined { return this.db.prepare('SELECT * FROM posts WHERE id=?').get(id) as PostRow | undefined; }
  getMedia(id: string): MediaRow | undefined { return this.db.prepare('SELECT * FROM media WHERE id=?').get(id) as MediaRow | undefined; }
  media(row: MediaRow): Media { return { id: row.id, name: row.name, kind: row.kind, durationSeconds: row.duration_seconds, width: row.width, height: row.height, bytes: row.bytes, createdAt: row.created_at, url: `/media/${row.id}`, thumbnailUrl: `/media/${row.id}/thumb` }; }
  runs(postId: string): Run[] {
    const rows = this.db.prepare('SELECT * FROM runs WHERE post_id=? ORDER BY position').all(postId) as Array<Record<string, unknown>>;
    return rows.map(row => ({ id: row.id as string, model: row.model as string, provider: row.provider as Run['provider'], customProvider: row.custom_provider as string, harness: row.harness as string, author: row.author as string, elapsedSeconds: row.elapsed_seconds as number | null, reasoningEffort: row.reasoning_effort as string, tokens: row.tokens as number | null, estimatedCostUsd: row.estimated_cost_usd as number | null, outcome: row.outcome as Run['outcome'], notes: row.notes as string, conditions: row.conditions as string, resultMediaIds: JSON.parse(row.result_ids_json as string) }));
  }
  summary(row: PostRow): PostSummary {
    const cover = row.cover_id ? this.getMedia(row.cover_id) : undefined;
    const runs = this.runs(row.id);
    return { id: row.id, title: row.title, slug: row.slug, summary: row.summary, category: row.category, status: row.status,
      isDemo: Boolean(row.is_demo), coverId: row.cover_id, cover: cover ? this.media(cover) : null,
      publishedAt: row.published_at, updatedAt: row.updated_at, revision: row.revision, groupId: row.group_id, models: [...new Set(runs.map(run => run.model))], providers: [...new Set(runs.map(providerLabel).filter(Boolean))], reasoningEfforts: [...new Set(runs.map(run => run.reasoningEffort || '').filter(Boolean))], runCount: runs.length };
  }
  post(row: PostRow, includeDrafts = false): Post {
    const mediaRows = this.db.prepare('SELECT media.* FROM media JOIN post_media ON media.id=post_media.media_id WHERE post_media.post_id=?').all(row.id) as MediaRow[];
    return { ...this.summary(row), title: row.title, slug: row.slug, summary: row.summary, category: row.category, prompt: row.prompt,
      body: row.body, status: row.status, isDemo: Boolean(row.is_demo), coverId: row.cover_id, runs: this.runs(row.id),
      progress: JSON.parse(row.progress_json), showcaseMediaIds: JSON.parse(row.showcase_json), collections: JSON.parse(row.collections_json), references: JSON.parse(row.references_json), group: row.group_id ? this.group(row.group_id, includeDrafts) || null : null, createdAt: row.created_at, media: Object.fromEntries(mediaRows.map(media => [media.id, this.media(media)])) };
  }
  save(input: PostInput, id: string = randomUUID()): Post {
    return this.db.transaction(() => {
      const existing = this.getPost(id);
      if (existing && input.revision !== existing.revision) throw new HttpError(409, 'This post changed in another window. Reload it before saving.');
      const duplicate = this.db.prepare('SELECT id FROM posts WHERE slug=? AND id<>?').get(input.slug, id);
      if (duplicate) throw new HttpError(409, 'That URL is already in use. Choose another.');
      const collections = input.collections ?? (existing ? JSON.parse(existing.collections_json) as Post['collections'] : []);
      const references = input.references ?? (existing ? JSON.parse(existing.references_json) as Post['references'] : []);
      const groupId = input.groupId === undefined ? existing?.group_id || null : input.groupId;
      if (groupId && !this.getGroup(groupId)) throw new HttpError(400, 'Comparison group no longer exists.');
      if (groupId && groupId !== existing?.group_id && (this.db.prepare('SELECT COUNT(*) AS count FROM posts WHERE group_id=?').get(groupId) as { count: number }).count >= 20) throw new HttpError(400, 'A comparison group supports up to 20 posts.');
      const mediaIds = [...new Set([...(input.coverId ? [input.coverId] : []), ...(input.showcaseMediaIds || []), ...collections.flatMap(collection => collection.mediaIds), ...input.progress.map(image => image.mediaId), ...input.runs.flatMap(run => run.resultMediaIds), ...references.flatMap(reference => reference.kind === 'media' ? [reference.mediaId] : [])])];
      for (const mediaId of mediaIds) if (!this.getMedia(mediaId)) throw new HttpError(400, 'A selected image no longer exists. Choose it again.');
      for (const collection of collections) for (const mediaId of collection.mediaIds) {
        if (this.getMedia(mediaId)?.kind !== 'image') throw new HttpError(400, 'Render collections accept still images. Videos belong in the final or progress galleries.');
      }
      if (input.coverId && this.getMedia(input.coverId)?.kind !== 'image') throw new HttpError(400, 'Choose a still image for the cover. Videos belong in the galleries.');
      const now = new Date().toISOString();
      const publishedAt = input.status === 'published' ? existing?.published_at || now : existing?.published_at || null;
      this.db.prepare(`INSERT INTO posts (id,title,slug,summary,category,prompt,body,status,is_demo,cover_id,progress_json,showcase_json,collections_json,references_json,group_id,revision,created_at,updated_at,published_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,slug=excluded.slug,summary=excluded.summary,
        category=excluded.category,prompt=excluded.prompt,body=excluded.body,status=excluded.status,is_demo=excluded.is_demo,cover_id=excluded.cover_id,
        progress_json=excluded.progress_json,showcase_json=excluded.showcase_json,collections_json=excluded.collections_json,references_json=excluded.references_json,group_id=excluded.group_id,revision=excluded.revision,updated_at=excluded.updated_at,published_at=excluded.published_at`).run(
        id,input.title,input.slug,input.summary,input.category,input.prompt,input.body,input.status,Number(input.isDemo),input.coverId,
        JSON.stringify(input.progress),JSON.stringify(input.showcaseMediaIds || []),JSON.stringify(collections),JSON.stringify(references),groupId,(existing?.revision || 0)+1,existing?.created_at || now,now,publishedAt);
      if (groupId !== (existing?.group_id || null)) {
        for (const changedGroup of new Set([groupId, existing?.group_id].filter(Boolean))) this.db.prepare('UPDATE comparison_groups SET revision=revision+1,updated_at=? WHERE id=?').run(now, changedGroup);
      }
      this.db.prepare('DELETE FROM runs WHERE post_id=?').run(id);
      const insert = this.db.prepare('INSERT INTO runs (id,post_id,model,provider,custom_provider,harness,author,elapsed_seconds,reasoning_effort,tokens,estimated_cost_usd,outcome,notes,conditions,result_ids_json,position) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      input.runs.forEach((run, index) => {
        const runId = run.id || randomUUID();
        if (this.db.prepare('SELECT id FROM runs WHERE id=?').get(runId)) throw new HttpError(400, 'A run ID belongs to another post.');
        insert.run(runId,id,run.model,run.provider || null,run.customProvider || '',run.harness,run.author,run.elapsedSeconds,run.reasoningEffort || '',run.tokens ?? null,run.estimatedCostUsd ?? null,run.outcome,run.notes,run.conditions,JSON.stringify(run.resultMediaIds),index);
      });
      this.db.prepare('DELETE FROM post_media WHERE post_id=?').run(id);
      const link = this.db.prepare('INSERT INTO post_media (post_id,media_id) VALUES (?,?)');
      for (const mediaId of mediaIds) link.run(id,mediaId);
      return this.post(this.getPost(id)!);
    })();
  }
  deletePost(id: string, revision: number) {
    this.db.transaction(() => {
      const existing = this.getPost(id);
      const result = this.db.prepare('DELETE FROM posts WHERE id=? AND revision=?').run(id, revision);
      if (!result.changes) throw new HttpError(existing ? 409 : 404, 'Post changed or no longer exists. Reload before deleting.');
      if (existing?.group_id) this.db.prepare('UPDATE comparison_groups SET revision=revision+1,updated_at=? WHERE id=?').run(new Date().toISOString(), existing.group_id);
    })();
  }
  getGroup(id: string): GroupRow | undefined { return this.db.prepare('SELECT * FROM comparison_groups WHERE id=?').get(id) as GroupRow | undefined; }
  group(id: string, includeDrafts = false): ComparisonGroup | undefined {
    const row = this.getGroup(id); if (!row) return undefined;
    const posts = this.db.prepare(`SELECT * FROM posts WHERE group_id=? ${includeDrafts ? '' : "AND status='published'"} ORDER BY created_at,id`).all(id) as PostRow[];
    if (!includeDrafts && !posts.length) return undefined;
    return { id: row.id, title: row.title, allowSideBySide: Boolean(row.allow_side_by_side), revision: row.revision, posts: posts.map(post => this.summary(post)) };
  }
  saveGroup(input: GroupInput, id: string = randomUUID()): ComparisonGroup {
    return this.db.transaction(() => {
      const existing = this.getGroup(id);
      if (existing && input.revision !== existing.revision) throw new HttpError(409, 'This group changed. Reload before saving.');
      if (!existing && (this.db.prepare('SELECT COUNT(*) AS count FROM comparison_groups').get() as { count: number }).count >= 200) throw new HttpError(400, 'The journal supports up to 200 comparison groups.');
      for (const postId of input.postIds) {
        const post = this.getPost(postId);
        if (!post) throw new HttpError(400, 'A selected post no longer exists.');
        if (post.group_id && post.group_id !== id) throw new HttpError(409, 'A selected post belongs to another group. Change its group in the post editor first.');
      }
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO comparison_groups (id,title,allow_side_by_side,revision,created_at,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,allow_side_by_side=excluded.allow_side_by_side,revision=excluded.revision,updated_at=excluded.updated_at`).run(id,input.title,Number(input.allowSideBySide),(existing?.revision || 0)+1,existing?.created_at || now,now);
      const current = (this.db.prepare('SELECT id FROM posts WHERE group_id=?').all(id) as { id: string }[]).map(post => post.id);
      for (const postId of current.filter(postId => !input.postIds.includes(postId))) this.db.prepare('UPDATE posts SET group_id=NULL,revision=revision+1,updated_at=? WHERE id=?').run(now,postId);
      for (const postId of input.postIds.filter(postId => !current.includes(postId))) this.db.prepare('UPDATE posts SET group_id=?,revision=revision+1,updated_at=? WHERE id=?').run(id,now,postId);
      return this.group(id,true)!;
    })();
  }
  deleteGroup(id: string, revision: number) {
    this.db.transaction(() => {
      const existing = this.getGroup(id);
      if (!existing) throw new HttpError(404, 'Group not found.');
      if (existing.revision !== revision) throw new HttpError(409, 'This group changed. Reload before deleting.');
      this.db.prepare('UPDATE posts SET group_id=NULL,revision=revision+1,updated_at=? WHERE group_id=?').run(new Date().toISOString(),id);
      this.db.prepare('DELETE FROM comparison_groups WHERE id=?').run(id);
    })();
  }
  close() { this.db.close(); }
}
