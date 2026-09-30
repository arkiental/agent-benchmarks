import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function fixtureVideo(directory:string) {
  await fs.mkdir(directory,{ recursive:true });
  const file=path.join(directory,'fixture-timelapse.mp4');
  await new Promise<void>((resolve,reject)=>execFile('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=white:s=160x120:r=10','-t','1','-c:v','libx264','-pix_fmt','yuv420p','-threads','1','-metadata','comment=REMOVE_THIS_PRIVATE_FIXTURE_METADATA','-movflags','+faststart','-y',file],{ timeout:30000,windowsHide:true },error=>error?reject(error):resolve()));
  return file;
}
