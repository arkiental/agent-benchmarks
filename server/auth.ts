import { scrypt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Config } from './config.js';
import { Store, HttpError } from './db.js';

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
  });
}
export async function passwordHash(password: string): Promise<string> {
  if (password.length < 16 || password.length > 256) throw new Error('Use a password or passphrase with 16 to 256 characters.');
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt);
  return `scrypt$32768$8$1$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!hash || password.length > 256) return false;
  const parts = hash.split('$');
  const key = await derive(password, parts[4]);
  const expected = Buffer.from(parts[5], 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}
export const digest = (token: string) => createHash('sha256').update(token).digest('hex');
type Session = { token_hash: string; csrf: string; expires_at: number; auth_revision: string };
export function auth(store: Store, config: Config) {
  const cookieName = config.publicUrl.startsWith('https:') ? '__Host-bench-session' : 'bench-session';
  const cookieOptions = { httpOnly: true, secure: config.publicUrl.startsWith('https:'), sameSite: 'strict' as const, path: '/' };
  function session(req: Request): Session | undefined {
    const token = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!token || !/^[a-f0-9]{64}$/.test(token) || !config.passwordHash) return;
    const record = store.db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>? AND auth_revision=?').get(digest(token), Date.now(), digest(config.passwordHash)) as Session | undefined;
    return record;
  }
  function requireOwner(req: Request, res: Response, next: NextFunction) {
    const record = session(req);
    if (!record) return next(new HttpError(401, 'Sign in to continue.'));
    res.locals.session = record;
    next();
  }
  function requireOrigin(req: Request, _res: Response, next: NextFunction) {
    if (req.headers.origin !== config.publicUrl) return next(new HttpError(403, 'Request origin does not match this site.'));
    if (req.headers['sec-fetch-site'] === 'cross-site') return next(new HttpError(403, 'Cross-site requests are not allowed.'));
    next();
  }
  function csrf(req: Request, res: Response, next: NextFunction) {
    const expected = (res.locals.session as Session).csrf;
    const supplied = req.get('x-csrf-token') || '';
    if (!/^[a-f0-9]{48}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return next(new HttpError(403, 'Session check failed. Reload and try again.'));
    next();
  }
  function issue(res: Response) {
    const token = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(24).toString('hex');
    const maxAge = config.sessionHours * 3600000;
    store.db.prepare('DELETE FROM sessions WHERE expires_at<=? OR auth_revision<>?').run(Date.now(), digest(config.passwordHash));
    store.db.prepare('INSERT INTO sessions (token_hash,csrf,expires_at,auth_revision) VALUES (?,?,?,?)').run(digest(token), csrfToken, Date.now() + maxAge, digest(config.passwordHash));
    res.cookie(cookieName, token, { ...cookieOptions, maxAge });
    return csrfToken;
  }
  function revoke(req: Request, res: Response) {
    const record = session(req);
    if (record) store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(record.token_hash);
    res.clearCookie(cookieName, cookieOptions);
  }
  return { session, requireOwner, requireOrigin, csrf, issue, revoke };
}
