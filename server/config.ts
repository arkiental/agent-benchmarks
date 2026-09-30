import 'dotenv/config';
import path from 'node:path';
import { isIP } from 'node:net';

export type Config = {
  publicUrl: string; host: string; port: number; dataDir: string; siteName: string;
  passwordHash: string; sessionHours: number; trustedProxies: string[];
  uploadMaxBytes: number; videoMaxBytes: number; storageMaxBytes: number; allowIndexing: boolean;
};
function number(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error('Invalid numeric environment configuration.');
  return parsed;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const url = new URL(env.PUBLIC_URL || 'http://localhost:8787');
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('PUBLIC_URL must be a bare HTTP(S) origin.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use an HTTPS PUBLIC_URL outside localhost.');
  const passwordHash = env.ADMIN_PASSWORD_HASH || '';
  if (passwordHash && !/^scrypt\$32768\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(passwordHash)) throw new Error('Generate ADMIN_PASSWORD_HASH with npm run admin:password.');
  const trustedProxies = (env.TRUSTED_PROXY_CIDRS || '').split(',').map(ip => ip.trim()).filter(Boolean);
  for (const proxy of trustedProxies) {
    const [address, prefix] = proxy.split('/');
    const version = isIP(address);
    const bits = prefix === undefined ? (version === 4 ? 32 : 128) : Number(prefix);
    if (!version || !Number.isInteger(bits) || bits > (version === 4 ? 32 : 128) || bits < (version === 4 ? 8 : 32) || proxy.split('/').length > 2) throw new Error('TRUSTED_PROXY_CIDRS requires specific trusted IPs or narrow CIDRs.');
  }
  return {
    publicUrl: url.origin, host: env.HOST || '127.0.0.1', port: number(env.PORT, 8787, 1, 65535),
    dataDir: path.resolve(env.DATA_DIR || 'data'), siteName: (env.SITE_NAME || 'Agent Benchmarks').trim().slice(0, 80) || 'Agent Benchmarks',
    passwordHash, sessionHours: number(env.SESSION_HOURS, 12, 1, 48), trustedProxies,
    uploadMaxBytes: number(env.UPLOAD_MAX_MB, 32, 1, 64) * 1024 * 1024,
    videoMaxBytes: number(env.VIDEO_MAX_MB, 100, 1, 500) * 1024 * 1024,
    storageMaxBytes: number(env.STORAGE_MAX_MB, 2048, 20, 1048576) * 1024 * 1024,
    allowIndexing: env.ALLOW_INDEXING === 'true',
  };
}
