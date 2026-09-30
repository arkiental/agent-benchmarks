import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { z } from 'zod';

const mediaName=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-thumb\.webp|\.(?:webp|mp4))$/;
const manifestSchema=z.object({
  version:z.literal(1), createdAt:z.string().datetime(), schemaVersion:z.union([z.literal(1),z.literal(2),z.literal(3),z.literal(4)]),
  posts:z.number().int().min(0), media:z.number().int().min(0),
  files:z.array(z.object({ path:z.string(),bytes:z.number().int().min(0),sha256:z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1),
}).strict();
export type BackupManifest=z.infer<typeof manifestSchema>;
async function hash(file: string) {
  const digest=createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest('hex');
}
function requireStopped(stopped: boolean) { if (!stopped) throw new Error('Stop the application first, then pass --stopped to confirm.'); }
function validFile(value: string) { return value==='journal.sqlite' || value.startsWith('uploads/') && mediaName.test(value.slice(8)); }
async function removeStage(parent: string,target: string,prefix: string) {
  if (path.dirname(path.resolve(target))!==path.resolve(parent) || !path.basename(target).startsWith(prefix)) throw new Error('Invalid staging cleanup path.');
  await fs.rm(target,{ recursive:true,force:true });
}
function validateDatabase(database: Database.Database) {
  if (![1,2,3,4].includes(database.pragma('user_version',{ simple:true }) as number)) throw new Error('Unsupported backup database version.');
  if (database.pragma('integrity_check',{ simple:true })!=='ok' || (database.pragma('foreign_key_check') as unknown[]).length) throw new Error('Database integrity check failed.');
}
export async function createBackup(dataDirectory: string,backupParent: string,stopped: boolean) {
  requireStopped(stopped);
  const dataDir=path.resolve(dataDirectory),parent=path.resolve(backupParent);
  const source=path.join(dataDir,'journal.sqlite'); await fs.access(source);
  await fs.mkdir(parent,{ recursive:true,mode:0o700 });
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const stage=path.join(parent,`.snapshot-${randomUUID()}`),destination=path.join(parent,`snapshot-${stamp}-${randomUUID().slice(0,8)}`);
  await fs.mkdir(stage,{ mode:0o700 }); await fs.mkdir(path.join(stage,'uploads'),{ mode:0o700 });
  const database=new Database(source,{ readonly:true,fileMustExist:true });
  try {
    validateDatabase(database);
    await database.backup(path.join(stage,'journal.sqlite'));
    const snapshot=new Database(path.join(stage,'journal.sqlite'));
    let rows:{ filename:string; thumb_filename:string }[],posts:number;
    try {
      snapshot.pragma('journal_mode = DELETE');
      snapshot.prepare('DELETE FROM sessions').run();
      if ((snapshot.pragma('user_version',{ simple:true }) as number) >= 3) {
        snapshot.prepare('DELETE FROM idempotency').run();
        snapshot.prepare('DELETE FROM agent_tokens').run();
      }
      validateDatabase(snapshot);
      rows=snapshot.prepare('SELECT filename,thumb_filename FROM media ORDER BY id').all() as typeof rows;
      posts=(snapshot.prepare('SELECT COUNT(*) AS count FROM posts').get() as { count:number }).count;
    } finally { snapshot.close(); }
    const files=['journal.sqlite'];
    for (const row of rows) for (const filename of [row.filename,row.thumb_filename]) {
      if (!mediaName.test(filename)) throw new Error('Unexpected media filename in database.');
      await fs.copyFile(path.join(dataDir,'uploads',filename),path.join(stage,'uploads',filename)); files.push(`uploads/${filename}`);
    }
    const manifest:BackupManifest={ version:1,createdAt:new Date().toISOString(),schemaVersion:database.pragma('user_version',{ simple:true }) as 1 | 2 | 3 | 4,posts,media:rows.length,files:[] };
    for (const file of files) { const absolute=path.join(stage,file); manifest.files.push({ path:file,bytes:(await fs.stat(absolute)).size,sha256:await hash(absolute) }); }
    await fs.writeFile(path.join(stage,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{ mode:0o600 });
    await fs.rename(stage,destination);
    return { directory:destination,manifest };
  } catch (error) { await removeStage(parent,stage,'.snapshot-'); throw error; }
  finally { database.close(); }
}
export async function verifyBackup(directory: string): Promise<BackupManifest> {
  const root=path.resolve(directory);
  const uploads=await fs.lstat(path.join(root,'uploads'));
  if(!uploads.isDirectory()||uploads.isSymbolicLink())throw new Error('Invalid backup uploads directory.');
  const manifest=manifestSchema.parse(JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8')));
  const paths=manifest.files.map(file => file.path);
  if (new Set(paths).size!==paths.length || paths.filter(file => file==='journal.sqlite').length!==1 || paths.some(file => !validFile(file))) throw new Error('Invalid backup file list.');
  for (const file of manifest.files) {
    const absolute=path.join(root,file.path),stat=await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size!==file.bytes || await hash(absolute)!==file.sha256) throw new Error(`Backup verification failed: ${file.path}`);
  }
  const database=new Database(path.join(root,'journal.sqlite'),{ readonly:true,fileMustExist:true });
  try {
    validateDatabase(database);
    if (database.pragma('user_version',{ simple:true })!==manifest.schemaVersion) throw new Error('Backup schema version does not match the manifest.');
    const rows=database.prepare('SELECT filename,thumb_filename FROM media').all() as { filename:string; thumb_filename:string }[];
    const expected=['journal.sqlite',...rows.flatMap(row => [`uploads/${row.filename}`,`uploads/${row.thumb_filename}`])].sort();
    if (JSON.stringify([...paths].sort())!==JSON.stringify(expected) || rows.length!==manifest.media || (database.prepare('SELECT COUNT(*) AS count FROM posts').get() as { count:number }).count!==manifest.posts) throw new Error('Backup manifest does not match database content.');
    if ((database.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count:number }).count) throw new Error('Backup contains owner sessions.');
    if (manifest.schemaVersion >= 3 && ((database.prepare('SELECT COUNT(*) AS count FROM agent_tokens').get() as { count:number }).count || (database.prepare('SELECT COUNT(*) AS count FROM idempotency').get() as { count:number }).count)) throw new Error('Backup contains agent credentials or replay records.');
  } finally { database.close(); }
  return manifest;
}
export async function restoreBackup(backupDirectory: string,dataDirectory: string,stopped: boolean) {
  requireStopped(stopped);
  const backupDir=path.resolve(backupDirectory),dataDir=path.resolve(dataDirectory),parent=path.dirname(dataDir);
  if (dataDir===parent || backupDir===dataDir || backupDir.startsWith(dataDir+path.sep)) throw new Error('Restore source must be outside the data directory.');
  const manifest=await verifyBackup(backupDir);
  await fs.mkdir(parent,{ recursive:true,mode:0o700 });
  const stage=path.join(parent,`.restore-${randomUUID()}`);
  const previous=path.join(parent,`${path.basename(dataDir)}.before-restore-${Date.now()}-${randomUUID().slice(0,8)}`);
  await fs.mkdir(stage,{ mode:0o700 }); await fs.mkdir(path.join(stage,'uploads'),{ mode:0o700 });
  let retained: string | null=null;
  try {
    for (const file of manifest.files) await fs.copyFile(path.join(backupDir,file.path),path.join(stage,file.path));
    const stagedDb=new Database(path.join(stage,'journal.sqlite'));
    try { stagedDb.prepare('DELETE FROM sessions').run(); validateDatabase(stagedDb); } finally { stagedDb.close(); }
    try { await fs.rename(dataDir,previous); retained=previous; }
    catch (error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
    try { await fs.rename(stage,dataDir); }
    catch (error) { if (retained) await fs.rename(retained,dataDir); throw error; }
    return { dataDir,retained,posts:manifest.posts,media:manifest.media };
  } catch (error) { await removeStage(parent,stage,'.restore-'); throw error; }
}
