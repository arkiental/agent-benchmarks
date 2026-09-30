import { readConfig } from '../server/config.js';
import { createBackup } from '../server/maintenance.js';

try {
  const args=process.argv.slice(2),destination=args.find(arg => !arg.startsWith('--')) || 'backups';
  const result=await createBackup(readConfig().dataDir,destination,args.includes('--stopped'));
  console.log(`Backup verified: ${result.directory}`);
  console.log(`${result.manifest.posts} posts and ${result.manifest.media} images. Owner sessions excluded.`);
} catch (error) { console.error((error as Error).message); process.exitCode=1; }
