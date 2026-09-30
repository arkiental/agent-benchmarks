import { readConfig } from '../server/config.js';
import { restoreBackup } from '../server/maintenance.js';

try {
  const args=process.argv.slice(2),source=args.find(arg => !arg.startsWith('--'));
  if (!source) throw new Error('Usage: npm run restore -- <snapshot-directory> --stopped');
  const result=await restoreBackup(source,readConfig().dataDir,args.includes('--stopped'));
  console.log(`Restored ${result.posts} posts and ${result.media} images to ${result.dataDir}.`);
  if (result.retained) console.log(`Previous data retained at ${result.retained}`);
  console.log('Owner sessions are cleared. Start the server and sign in again.');
} catch (error) { console.error((error as Error).message); process.exitCode=1; }
