import fs from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { groupSchema, idSchema, postSchema } from '../shared/schema.js';
import type { ComparisonGroup, GroupInput, Post, PostInput, PostSummary } from '../shared/schema.js';

const execute = promisify(execFile);
const credentialSchema = z.object({
  version: z.literal(1), origin: z.string().url(), secret: z.string().regex(/^abt_[a-f0-9]{64}$/),
  expiresAt: z.string().datetime(), scopes: z.array(z.string()), allowPublishing: z.boolean(),
  uploadRoots: z.array(z.string().min(1)).min(1).max(20),
}).strict();
export type ConnectorCredential = z.infer<typeof credentialSchema>;
export type CredentialProvider = () => Promise<ConnectorCredential>;
const keySchema = z.string().regex(/^[A-Za-z0-9._:-]{16,120}$/).describe('Stable key for this exact write. Reuse it only for the same request within 24 hours.');
const mimeTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4' };
const maxJsonBytes = 512 * 1024;
const maxResponseBytes = 2 * 1024 * 1024;
const maxFileBytes = 500 * 1024 * 1024;

export function redact(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/abt_[a-f0-9]{64}/gi, '[redacted]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(secret|token_hash|authorization|password|passwordHash|ADMIN_PASSWORD_HASH|BENCH_TOKEN)$/i.test(key)).map(([key, item]) => [key, redact(item)]));
  return value;
}
export async function loadWindowsCredential(): Promise<ConnectorCredential> {
  if (process.platform !== 'win32') throw new Error('The saved-token connector requires the owner Windows account.');
  const bridge = fileURLToPath(new URL('../../scripts/connector-vault-read.ps1', import.meta.url));
  try {
    const { stdout } = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', bridge], {
      windowsHide: true, timeout: 15000, maxBuffer: 65536, env: { ...process.env, BENCH_CONNECTOR_IPC: '1' },
    });
    return credentialSchema.parse(JSON.parse(stdout));
  } catch { throw new Error('Owner connector setup is absent, expired or unavailable to this Windows account. Run the owner setup or reconnect the MCP server.'); }
}
function checkCredential(raw: ConnectorCredential) {
  const credential = credentialSchema.parse(raw), origin = new URL(credential.origin);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Saved site origin is invalid.');
  if (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw new Error('Remote sites require HTTPS.');
  if (Date.parse(credential.expiresAt) <= Date.now()) throw new Error('The owner-issued credential has expired. Renew it in Agent tokens, then rerun owner setup.');
  return { ...credential, origin: origin.origin };
}
async function limitedJson(response: Response) {
  if (Number(response.headers.get('Content-Length')) > maxResponseBytes) throw new Error('Server response exceeds the connector limit.');
  const reader = response.body?.getReader(); if (!reader) return null;
  const chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    bytes += value.byteLength;
    if (bytes > maxResponseBytes) { await reader.cancel(); throw new Error('Server response exceeds the connector limit.'); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new Error('Server returned an unreadable response.'); }
}
export class BenchmarkConnector {
  constructor(private readonly credentials: CredentialProvider, private readonly fetcher: typeof fetch = fetch) {}
  private async access(scope?: string, publication = false) {
    const credential = checkCredential(await this.credentials());
    if (scope && !credential.scopes.includes(scope)) throw new Error(`Owner credential requires ${scope} scope.`);
    if (publication && (!credential.allowPublishing || !credential.scopes.includes('publish'))) throw new Error('Publication is disabled in this connector. The owner must explicitly grant publish scope and enable it in setup.');
    return credential;
  }
  private async request(credential: ConnectorCredential, route: string, init: RequestInit = {}, key?: string) {
    const headers = new Headers({ Authorization: `Bearer ${credential.secret}` });
    if (key) headers.set('Idempotency-Key', keySchema.parse(key));
    if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    if (typeof init.body === 'string' && Buffer.byteLength(init.body) > maxJsonBytes) throw new Error('Post input exceeds the 512 KiB API limit.');
    let response: Response;
    try { response = await this.fetcher(credential.origin + route, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(240000) }); }
    catch { throw new Error('Request failed or timed out. Retry a write with its original key; do not generate a new key after an uncertain result.'); }
    const data = await limitedJson(response);
    if (!response.ok) {
      const error = data && typeof data === 'object' && 'error' in data ? String(data.error) : 'Request could not be completed.';
      throw new Error(`HTTP ${response.status}: ${String(redact(error)).slice(0, 600)}`);
    }
    return data;
  }
  async status() {
    const credential = await this.access(), result = await this.request(credential, '/api/v1/me');
    return redact({ credential: result, origin: credential.origin, publishingEnabled: credential.allowPublishing, uploadRoots: credential.uploadRoots });
  }
  async schema() { return this.request(await this.access(), '/api/v1/schema'); }
  async search(q: string, status: 'draft' | 'published' | undefined, limit: number) {
    const credential = await this.access('posts:read'), found: PostSummary[] = [], needle = q.trim().toLocaleLowerCase();
    let scanned = 0, total = 0, more = false;
    for (let page = 1; page <= 20; page++) {
      const result = await this.request(credential, `/api/v1/posts?page=${page}&limit=60${status ? '&status=' + status : ''}`) as { posts: PostSummary[]; total: number; pages: number };
      total = result.total; scanned += result.posts.length;
      for (const post of result.posts) {
        const haystack = [post.title, post.slug, post.summary, ...post.models, ...post.providers, ...post.reasoningEfforts].join('\n').toLocaleLowerCase();
        if (!needle || haystack.includes(needle)) found.push(post);
      }
      more = page < result.pages;
      if (!more || found.length >= limit) break;
    }
    return redact({ posts: found.slice(0, limit), scanned, total, more, note: more ? 'More posts may match; this search is bounded and stops once the requested result count is reached.' : undefined });
  }
  async getPost(id: string) { return this.request(await this.access('posts:read'), '/api/v1/posts/' + idSchema.parse(id)) as Promise<Post>; }
  async listGroups(page: number, limit: number) { return this.request(await this.access('posts:read'), `/api/v1/groups?page=${page}&limit=${limit}`); }
  async getGroup(id: string) { return this.request(await this.access('posts:read'), '/api/v1/groups/' + idSchema.parse(id)) as Promise<ComparisonGroup>; }
  private async groupAccess(postIds: string[], confirmPublishedChange: boolean) {
    const posts = await Promise.all(postIds.map(id => this.getPost(id)));
    const publication = posts.some(post => post.status === 'published');
    if (publication && !confirmPublishedChange) throw new Error('Confirm comparison changes involving published posts only when the user requested them.');
    const credential = await this.access('posts:write', publication);
    const grant = await this.request(credential, '/api/v1/me') as { token?: { scopes?: string[] } };
    if (!grant.token?.scopes?.includes('groups:write')) throw new Error('The owner-issued token requires groups:write scope for comparison changes.');
    return credential;
  }
  async createGroup(raw: GroupInput, key: string, confirmPublishedChange: boolean) {
    const input = groupSchema.parse(raw);
    if (input.revision !== undefined) throw new Error('Omit revision when creating a comparison group.');
    const credential = await this.groupAccess(input.postIds, confirmPublishedChange);
    return this.request(credential, '/api/v1/groups', { method: 'POST', body: JSON.stringify(input) }, key);
  }
  async updateGroup(id: string, raw: GroupInput, key: string, confirmPublishedChange: boolean) {
    idSchema.parse(id); const input = groupSchema.parse(raw);
    if (input.revision === undefined) throw new Error('Include the current comparison-group revision.');
    const existing = await this.getGroup(id);
    const credential = await this.groupAccess([...new Set([...input.postIds, ...existing.posts.map(post => post.id)])], confirmPublishedChange);
    return this.request(credential, '/api/v1/groups/' + id, { method: 'PUT', body: JSON.stringify(input) }, key);
  }
  async createPost(raw: PostInput, key: string) {
    const input = postSchema.parse(raw);
    if (input.status !== 'draft' || input.revision !== undefined) throw new Error('Create a draft without revision; use the separate publish tool when explicitly requested.');
    if (input.groupId) throw new Error('Create the draft first, then use comparison-group tools to associate posts.');
    return this.request(await this.access('posts:write'), '/api/v1/posts', { method: 'POST', body: JSON.stringify(input) }, key);
  }
  async updatePost(id: string, raw: PostInput, key: string, publishedChange: boolean) {
    idSchema.parse(id); const input = postSchema.parse(raw);
    if (input.revision === undefined) throw new Error('Include the current post revision.');
    const existing = await this.getPost(id), publication = input.status === 'published' || existing.status === 'published';
    if (publication && !publishedChange) throw new Error('Set confirmPublishedChange only when the user requested a change to a published post.');
    if (input.groupId !== undefined && input.groupId !== existing.groupId) throw new Error('Preserve the comparison-group assignment; change it through the comparison-group tools.');
    return this.request(await this.access('posts:write', publication), '/api/v1/posts/' + id, { method: 'PUT', body: JSON.stringify(input) }, key);
  }
  async publishPost(id: string, revision: number, key: string) {
    const credential = await this.access('posts:write', true), post = await this.getPost(id);
    const input = postSchema.parse(Object.fromEntries(Object.keys(postSchema.shape).map(field => [field, post[field as keyof Post]])));
    input.status = 'published'; input.revision = revision;
    const result = await this.request(credential, '/api/v1/posts/' + id, { method: 'PUT', body: JSON.stringify(postSchema.parse(input)) }, key) as Post;
    return { post: result, url: credential.origin + '/posts/' + result.slug };
  }
  async listMedia(page: number, limit: number) { return this.request(await this.access('posts:read'), `/api/v1/media?page=${page}&limit=${limit}`); }
  async uploadMedia(file: string, key: string) {
    if (!path.isAbsolute(file)) throw new Error('Name one absolute local media path.');
    const credential = await this.access('media:write'), type = mimeTypes[path.extname(file).toLowerCase()];
    if (!type) throw new Error('Choose one PNG, JPEG, WebP or MP4 file.');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxFileBytes) throw new Error('Choose a regular media file no larger than 500 MiB; configured server limits also apply.');
    const resolved = await fs.realpath(file); let permitted = false;
    for (const root of credential.uploadRoots) {
      if (!path.isAbsolute(root)) continue;
      const actualRoot = await fs.realpath(root).catch(() => ''); if (!actualRoot) continue;
      const relative = path.relative(actualRoot, resolved);
      if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) { permitted = true; break; }
    }
    if (!permitted) throw new Error('This file is outside the owner-approved upload folders.');
    const blob = await openAsBlob(resolved, { type });
    if (blob.size !== stat.size) throw new Error('The chosen file changed before upload.');
    const form = new FormData(); form.append('image', blob, path.basename(file));
    return this.request(credential, '/api/v1/media', { method: 'POST', body: form }, key);
  }
}
function result(value: unknown, isError = false) { return { content: [{ type: 'text' as const, text: JSON.stringify(redact(value)) }], isError }; }
async function safely(action: () => Promise<unknown>) {
  try { return result(await action()); }
  catch (error) {
    const message = error instanceof z.ZodError ? 'Input validation failed. Use bench_schema for the current post format.' : (error as NodeJS.ErrnoException).code ? 'The explicitly chosen local media file is unavailable.' : (error as Error).message;
    return result({ error: String(redact(message)).slice(0, 800) }, true);
  }
}
export function createConnectorServer(credentials: CredentialProvider = loadWindowsCredential, fetcher: typeof fetch = fetch) {
  const server = new McpServer({ name: 'agent-benchmarks', version: '1.0.0' }), api = new BenchmarkConnector(credentials, fetcher);
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  server.registerTool('bench_status', { description: 'Check benchmark connector scopes and expiry. Never returns the saved token.', inputSchema: z.object({}).strict(), annotations: read }, () => safely(() => api.status()));
  server.registerTool('bench_schema', { description: 'Get the current complete post authoring schema, including ordered render collections, references, galleries and run metadata.', inputSchema: z.object({}).strict(), annotations: read }, () => safely(() => api.schema()));
  server.registerTool('bench_search_posts', { description: 'Search authorized post summaries, including drafts. Check for an existing post before creating one; results are bounded.', inputSchema: z.object({ q: z.string().max(320).default(''), status: z.enum(['draft', 'published']).optional(), limit: z.number().int().min(1).max(60).default(24) }).strict(), annotations: read }, ({ q, status, limit }) => safely(() => api.search(q, status, limit)));
  server.registerTool('bench_get_post', { description: 'Read a complete post and its current revision, ordered collections, media and references.', inputSchema: z.object({ id: idSchema }).strict(), annotations: read }, ({ id }) => safely(() => api.getPost(id)));
  server.registerTool('bench_list_groups', { description: 'List authorized comparison groups and their ordered post summaries.', inputSchema: z.object({ page: z.number().int().min(1).max(10000).default(1), limit: z.number().int().min(1).max(60).default(24) }).strict(), annotations: read }, ({ page, limit }) => safely(() => api.listGroups(page, limit)));
  server.registerTool('bench_get_group', { description: 'Read one comparison group and its current revision.', inputSchema: z.object({ id: idSchema }).strict(), annotations: read }, ({ id }) => safely(() => api.getGroup(id)));
  server.registerTool('bench_create_group', { description: 'Associate user-requested posts in an ordered comparison group. Requires the existing server-issued groups:write grant; published membership also requires confirmation and owner-enabled publication.', inputSchema: z.object({ group: groupSchema, idempotencyKey: keySchema, confirmPublishedChange: z.boolean().default(false) }).strict(), annotations: write }, ({ group, idempotencyKey, confirmPublishedChange }) => safely(() => api.createGroup(group, idempotencyKey, confirmPublishedChange)));
  server.registerTool('bench_update_group', { description: 'Update comparison membership and side-by-side permission using the fetched revision. Preserve unrelated members. Published membership changes require explicit user authorization.', inputSchema: z.object({ id: idSchema, group: groupSchema, idempotencyKey: keySchema, confirmPublishedChange: z.boolean().default(false) }).strict(), annotations: { ...write, destructiveHint: true } }, ({ id, group, idempotencyKey, confirmPublishedChange }) => safely(() => api.updateGroup(id, group, idempotencyKey, confirmPublishedChange)));
  server.registerTool('bench_create_draft', { description: 'Create one full draft. Use only user-provided facts and an original stable idempotency key; reuse that key for an identical retry within 24 hours.', inputSchema: z.object({ post: postSchema, idempotencyKey: keySchema }).strict(), annotations: write }, ({ post, idempotencyKey }) => safely(() => api.createPost(post, idempotencyKey)));
  server.registerTool('bench_update_post', { description: 'Replace schema input fields using the fetched revision. Preserve unrelated prompt, metadata, galleries, collections and references. Confirm published changes only when explicitly requested.', inputSchema: z.object({ id: idSchema, post: postSchema, idempotencyKey: keySchema, confirmPublishedChange: z.boolean().default(false) }).strict(), annotations: { ...write, destructiveHint: true } }, ({ id, post, idempotencyKey, confirmPublishedChange }) => safely(() => api.updatePost(id, post, idempotencyKey, confirmPublishedChange)));
  server.registerTool('bench_publish_post', { description: 'Publish an existing post only when the user explicitly requested publication. Requires owner-enabled publish scope; keeps all content and checks the supplied revision.', inputSchema: z.object({ id: idSchema, revision: z.number().int().min(1), idempotencyKey: keySchema }).strict(), annotations: write }, ({ id, revision, idempotencyKey }) => safely(() => api.publishPost(id, revision, idempotencyKey)));
  server.registerTool('bench_list_media', { description: 'List authorized benchmark media, including draft media. Does not scan the local computer.', inputSchema: z.object({ page: z.number().int().min(1).max(10000).default(1), limit: z.number().int().min(1).max(60).default(24) }).strict(), annotations: read }, ({ page, limit }) => safely(() => api.listMedia(page, limit)));
  server.registerTool('bench_upload_media', { description: 'Upload one explicitly named local PNG/JPEG/WebP/MP4 inside an owner-approved folder. Server image/video limits, validation and rate limits remain enforced; reuse the same key for an identical retry.', inputSchema: z.object({ filePath: z.string().min(1).max(2048), idempotencyKey: keySchema }).strict(), annotations: write }, ({ filePath, idempotencyKey }) => safely(() => api.uploadMedia(filePath, idempotencyKey)));
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) { process.stderr.write('Launch this MCP server without credential arguments. Use owner setup and a local STDIO MCP client.\n'); process.exitCode = 1; }
  else {
    const server = createConnectorServer();
    try { await server.connect(new StdioServerTransport()); }
    catch { process.stderr.write('Benchmark MCP startup failed. Check the local MCP configuration.\n'); process.exitCode = 1; }
  }
}
