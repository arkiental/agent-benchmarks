import fs from 'node:fs/promises';
import { createReadStream, createWriteStream, openAsBlob } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { groupSchema, idSchema, postSchema } from '../shared/schema.js';

const help = `Agent Benchmarks CLI

Set BENCH_URL to the configured site origin and BENCH_TOKEN to an owner-issued scoped credential.
The credential is read from the environment and never printed. HTTP is limited to localhost.

  npm run agent -- schema
  npm run agent -- whoami
  npm run agent -- posts list [--status draft|published]
  npm run agent -- post get <id>
  npm run agent -- post create <explicit-file.json> [--key stable-idempotency-key]
  npm run agent -- post update <id> <explicit-file.json> [--key stable-idempotency-key]
  npm run agent -- media list
  npm run agent -- media upload <explicit-file.png|jpg|webp|mp4> [--key stable-idempotency-key]
  npm run agent -- media download <id> <explicit-output-file> [--thumbnail]
  npm run agent -- groups list
  npm run agent -- group get <id>
  npm run agent -- group create <explicit-file.json> [--key stable-idempotency-key]
  npm run agent -- group update <id> <explicit-file.json> [--key stable-idempotency-key]
  npm run agent -- group delete <id> <current-revision> [--key stable-idempotency-key]

Create defaults to a draft unless the JSON explicitly requests publication and the credential
has publish scope. PUT replaces the full record and requires its current revision. Supply
the same explicit --key when retrying a command; a generated key is printed on stderr otherwise.
Uploads read only the named file and are streamed, never a directory or server-side path.
`;
const MAX_FILE_BYTES = 500 * 1024 * 1024;
const MAX_JSON_BYTES = 512 * 1024;
const mimeTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4' };

function baseUrl(value: string | undefined): string {
  if (!value) throw new Error('Set BENCH_URL to the site origin.');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('BENCH_URL must be an HTTP(S) site origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('BENCH_URL must be a bare HTTP(S) origin without credentials.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use HTTPS outside localhost.');
  return url.origin;
}
async function jsonFile(file: string | undefined) {
  if (!file) throw new Error('Provide an explicit JSON file path.');
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_JSON_BYTES) throw new Error('Choose a JSON file no larger than 512 KiB.');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += (chunk as Buffer).length;
    if (bytes > MAX_JSON_BYTES) throw new Error('Choose a JSON file no larger than 512 KiB.');
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch (error) { if (error instanceof SyntaxError) throw new Error('The chosen file is not valid JSON.'); throw error; }
}
function argumentsFor(args: string[]) {
  const positional: string[] = [], options = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--thumbnail') { options.set(arg, 'true'); continue; }
    if (arg.startsWith('--')) {
      if (!['--key', '--status'].includes(arg) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Unknown or incomplete option. Run with --help.');
      if (options.has(arg)) throw new Error('Supply each option once.');
      options.set(arg, args[++index]);
    } else positional.push(arg);
  }
  return { positional, options };
}
async function responseJson(response: Response) {
  if (response.status === 204) return null;
  const bytes = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(bytes) && bytes > 2 * 1024 * 1024) throw new Error('Server response exceeds the CLI limit.');
  const reader = response.body?.getReader();
  if (!reader) return null;
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Server response exceeds the CLI limit.'); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: string }; }
  catch { throw new Error('Server returned an unreadable response.'); }
}

export async function runAgent(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env) {
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(help); return; }
  const origin = baseUrl(env.BENCH_URL), { positional: words, options } = argumentsFor(args);
  const schemaOnly = words.length === 1 && words[0] === 'schema';
  const token = env.BENCH_TOKEN || '';
  if (!schemaOnly && !/^abt_[a-f0-9]{64}$/.test(token)) throw new Error('Set BENCH_TOKEN to an owner-issued agent credential.');
  const authHeaders: Record<string, string> = schemaOnly ? {} : { Authorization: `Bearer ${token}` };
  const request = async (route: string, init: RequestInit = {}, write = false, json = true) => {
    const headers = new Headers({ ...authHeaders, ...Object.fromEntries(new Headers(init.headers)) });
    if (write) {
      const key = options.get('--key') || randomUUID();
      if (!/^[A-Za-z0-9._:-]{16,120}$/.test(key)) throw new Error('Use an idempotency key with 16 to 120 permitted ASCII characters.');
      headers.set('Idempotency-Key', key);
      if (!options.has('--key')) console.error(`Idempotency-Key: ${key}`);
    }
    if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    let response: Response;
    try { response = await fetch(origin + route, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(240000) }); }
    catch { throw new Error('The request failed or timed out. Verify BENCH_URL and retry a write with the same idempotency key.'); }
    if (!response.ok) {
      const body = await responseJson(response);
      throw new Error(`HTTP ${response.status}: ${body?.error || 'Request could not be completed.'}`);
    }
    return json ? responseJson(response) : response;
  };
  const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const checkLength = (length: number) => { if (words.length !== length) throw new Error('Incorrect arguments. Run with --help.'); };
  if (schemaOnly) { output(await request('/api/v1/schema')); return; }
  if (words[0] === 'whoami') { checkLength(1); output(await request('/api/v1/me')); return; }
  if (words[1] === 'list' && ['posts', 'media', 'groups'].includes(words[0])) {
    checkLength(2);
    const status = options.get('--status');
    if (status && (words[0] !== 'posts' || !['draft', 'published'].includes(status))) throw new Error('--status is available for posts list only.');
    output(await request(`/api/v1/${words[0]}${status ? '?status=' + status : ''}`)); return;
  }
  if (['post', 'group'].includes(words[0])) {
    const root = '/api/v1/' + words[0] + 's', schema = words[0] === 'post' ? postSchema : groupSchema;
    if (words[1] === 'get') { checkLength(3); output(await request(root + '/' + idSchema.parse(words[2]))); return; }
    if (words[1] === 'create') {
      checkLength(3);
      const raw = await jsonFile(words[2]);
      const input = schema.parse(words[0] === 'post' && raw && typeof raw === 'object' ? { status: 'draft', ...raw } : raw);
      if (input.revision !== undefined) throw new Error('Omit revision when creating a record.');
      output(await request(root, { method: 'POST', body: JSON.stringify(input) }, true)); return;
    }
    if (words[1] === 'update') {
      checkLength(4);
      const id = idSchema.parse(words[2]), input = schema.parse(await jsonFile(words[3]));
      if (input.revision === undefined) throw new Error('Include the current revision in the JSON update file.');
      output(await request(root + '/' + id, { method: 'PUT', body: JSON.stringify(input) }, true)); return;
    }
    if (words[0] === 'group' && words[1] === 'delete') {
      checkLength(4);
      const id = idSchema.parse(words[2]), revision = z.coerce.number().int().min(1).parse(words[3]);
      output(await request(root + '/' + id, { method: 'DELETE', body: JSON.stringify({ revision }) }, true)); return;
    }
  }
  if (words[0] === 'media' && words[1] === 'upload') {
    checkLength(3);
    const file = words[2], stat = await fs.stat(file), type = mimeTypes[path.extname(file).toLowerCase()];
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_FILE_BYTES || !type) throw new Error('Choose one PNG, JPEG, WebP or MP4 file no larger than 500 MiB. Server limits may be lower.');
    const form = new FormData();
    form.append('image', await openAsBlob(file, { type }), path.basename(file));
    output(await request('/api/v1/media', { method: 'POST', body: form }, true)); return;
  }
  if (words[0] === 'media' && words[1] === 'download') {
    checkLength(4);
    const id = idSchema.parse(words[2]), outputFile = words[3];
    const response = await request(`/api/v1/media/${id}${options.has('--thumbnail') ? '/thumb' : ''}`, {}, false, false) as Response;
    if (!response.body) throw new Error('Server returned no media.');
    const contentLength = Number(response.headers.get('Content-Length'));
    if (contentLength > MAX_FILE_BYTES) { await response.body.cancel(); throw new Error('Media exceeds the CLI download limit.'); }
    // wx protects an existing local file; the user names every path the CLI writes.
    const sink = createWriteStream(outputFile, { flags: 'wx', mode: 0o600 });
    let bytes = 0, opened = false;
    sink.once('open', () => { opened = true; });
    const stream = async function* () {
      for await (const chunk of Readable.fromWeb(response.body! as import('node:stream/web').ReadableStream<Uint8Array>)) {
        bytes += (chunk as Buffer).length;
        if (bytes > MAX_FILE_BYTES) throw new Error('Media exceeds the CLI download limit.');
        yield chunk;
      }
    };
    try { await pipeline(stream(), sink); }
    catch (error) { if (opened) await fs.unlink(outputFile).catch(() => {}); throw error; }
    output({ saved: outputFile, bytes }); return;
  }
  throw new Error('Unknown command. Run with --help.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runAgent(); }
  catch (error) {
    const message = error instanceof z.ZodError ? `${error.issues[0]?.path.join('.') || 'Request'}: ${error.issues[0]?.message || 'Invalid input.'}` : (error as NodeJS.ErrnoException).code ? 'The chosen local file could not be read or written.' : (error as Error).message;
    console.error(message); process.exitCode = 1;
  }
}
