import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Store, HttpError } from './db.js';
import type { Config } from './config.js';
import { execFile } from 'node:child_process';

function mediaCommand(command: string,args: string[]) {
  return new Promise<string>((resolve,reject) => execFile(command,args,{ timeout:60000,maxBuffer:512*1024,windowsHide:true },(error,stdout) => {
    if (error) reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new HttpError(503,'Install FFmpeg and ffprobe on the server to enable MP4 uploads.') : new HttpError(415,'MP4 processing failed. Use an H.264 MP4 with optional AAC audio.'));
    else resolve(stdout);
  }));
}
const safeName = (name: string) => path.basename(name.replace(/\\/g,'/')).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,160) || 'media';

export function mediaService(store: Store, config: Config) {
  let reservedBytes = 0;
  let processing = 0;
  async function upload(buffer: Buffer, name: string, mime: string) {
    if (buffer.length > config.uploadMaxBytes) throw new HttpError(413, 'Image exceeds the upload limit.');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new HttpError(415, 'Choose a PNG, JPEG or WebP image.');
    if (processing >= 2) throw new HttpError(429, 'Two images are processing. Try again shortly.');
    processing++;
    let reservation = 0;
    let reserved = false;
    const id = randomUUID();
    const filename = `${id}.webp`;
    const thumbFilename = `${id}-thumb.webp`;
    const output = path.join(store.uploads, filename);
    const thumbOutput = path.join(store.uploads, thumbFilename);
    try {
      const input = sharp(buffer, { limitInputPixels: 40_000_000, failOn: 'warning', animated: false });
      const metadata = await input.metadata();
      const accepted = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
      if (!metadata.format || !(metadata.format in accepted) || accepted[metadata.format as keyof typeof accepted] !== mime || (metadata.pages || 1) > 1) throw new HttpError(415, 'Image content must match a non-animated PNG, JPEG or WebP.');
      const image = await input.rotate().resize({ width: 3000, height: 3000, fit: 'inside', withoutEnlargement: true }).webp({ quality: 90 }).toBuffer({ resolveWithObject: true });
      const thumbnail = await sharp(image.data).resize({ width: 1100, height: 1100, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
      const used = (store.db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM media').get() as { bytes: number }).bytes;
      reservation = image.data.length + thumbnail.length;
      if (used + reservedBytes + reservation > config.storageMaxBytes) throw new HttpError(507, 'Media storage is full. Remove unused images or increase the storage limit.');
      reservedBytes += reservation;
      reserved = true;
      await fs.writeFile(output, image.data, { flag: 'wx', mode: 0o600 });
      await fs.writeFile(thumbOutput, thumbnail, { flag: 'wx', mode: 0o600 });
      store.db.prepare('INSERT INTO media (id,name,filename,thumb_filename,width,height,bytes,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id,safeName(name),filename,thumbFilename,image.info.width,image.info.height,reservation,new Date().toISOString());
      return store.media(store.getMedia(id)!);
    } catch (error) {
      await Promise.allSettled([fs.unlink(output), fs.unlink(thumbOutput)]);
      if (error instanceof HttpError) throw error;
      throw new HttpError(415, 'This image could not be decoded safely. Export a PNG, JPEG or WebP and try again.');
    } finally {
      if (reserved) reservedBytes -= reservation;
      processing--;
    }
  }
  async function uploadVideo(inputFile: string,name: string) {
    const size=(await fs.stat(inputFile)).size;
    if (size > config.videoMaxBytes) throw new HttpError(413,'Video exceeds the upload limit.');
    const file=await fs.open(inputFile,'r'); const header=Buffer.alloc(32);
    try { await file.read(header,0,32,0); } finally { await file.close(); }
    if (header.toString('ascii',4,8)!=='ftyp' || !/^(isom|iso[2-9]|mp4[12]|avc1|M4V )$/.test(header.toString('ascii',8,12))) throw new HttpError(415,'Choose a valid MP4 file.');
    if (processing >= 2) throw new HttpError(429,'Two files are processing. Try again shortly.');
    const used=(store.db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM media').get() as { bytes:number }).bytes;
    if (used + reservedBytes + size + 1024*1024 > config.storageMaxBytes) throw new HttpError(507,'Media storage is full. Remove unused files or increase the storage limit.');
    processing++; let reservation=size+1024*1024; reservedBytes+=reservation;
    const id=randomUUID(),filename=`${id}.mp4`,thumbFilename=`${id}-thumb.webp`;
    const output=path.join(store.uploads,filename),thumbOutput=path.join(store.uploads,thumbFilename);
    try {
      const probe=JSON.parse(await mediaCommand('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',path.resolve(inputFile)])) as { streams:{ codec_type:string; codec_name:string; width?:number; height?:number }[];format:{ duration:string } };
      const video=probe.streams.filter(stream => stream.codec_type==='video'),audio=probe.streams.filter(stream => stream.codec_type==='audio');
      const duration=Number(probe.format.duration),width=video[0]?.width || 0,height=video[0]?.height || 0;
      if (video.length!==1 || video[0].codec_name!=='h264' || audio.length>1 || audio.some(stream => stream.codec_name!=='aac') || probe.streams.length!==video.length+audio.length || !Number.isFinite(duration) || duration<=0 || duration>14400 || width<1 || height<1 || width>3840 || height>3840) throw new HttpError(415,'Use an H.264 MP4 up to 4K and four hours long, with optional AAC audio.');
      await mediaCommand('ffmpeg',['-nostdin','-v','error','-protocol_whitelist','file,pipe','-i',path.resolve(inputFile),'-map','0:v:0','-map','0:a:0?','-c','copy','-map_metadata','-1','-map_chapters','-1','-movflags','+faststart','-f','mp4',output]);
      await mediaCommand('ffmpeg',['-nostdin','-v','error','-protocol_whitelist','file,pipe','-i',output,'-frames:v','1','-vf',"scale='min(1100,iw)':'min(1100,ih)':force_original_aspect_ratio=decrease",'-c:v','libwebp','-quality','85','-threads','1',thumbOutput]);
      const bytes=(await fs.stat(output)).size+(await fs.stat(thumbOutput)).size;
      const current=(store.db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM media').get() as { bytes:number }).bytes;
      if (current+reservedBytes-reservation+bytes>config.storageMaxBytes) throw new HttpError(507,'Media storage is full.');
      await Promise.all([fs.chmod(output,0o600),fs.chmod(thumbOutput,0o600)]);
      store.db.prepare('INSERT INTO media (id,name,filename,thumb_filename,width,height,bytes,created_at,kind,duration_seconds) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,safeName(name),filename,thumbFilename,width,height,bytes,new Date().toISOString(),'video',duration);
      return store.media(store.getMedia(id)!);
    } catch (error) { await Promise.allSettled([fs.unlink(output),fs.unlink(thumbOutput)]); if (error instanceof HttpError) throw error; throw new HttpError(415,'This MP4 could not be processed safely.'); }
    finally { reservedBytes-=reservation; processing--; }
  }
  async function remove(id: string) {
    const row = store.getMedia(id);
    if (!row) throw new HttpError(404, 'Image not found.');
    if (store.db.prepare('SELECT post_id FROM post_media WHERE media_id=? LIMIT 1').get(id)) throw new HttpError(409, 'This image is used in a post. Remove it from the post first.');
    store.db.prepare('DELETE FROM media WHERE id=?').run(id);
    const results = await Promise.allSettled([fs.unlink(path.join(store.uploads, row.filename)), fs.unlink(path.join(store.uploads, row.thumb_filename))]);
    if (results.some(result => result.status === 'rejected' && (result.reason as NodeJS.ErrnoException).code !== 'ENOENT')) console.error('An unused media file could not be removed from disk.');
  }
  return { upload, uploadVideo, remove };
}
