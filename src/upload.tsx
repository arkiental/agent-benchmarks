import { useRef,useState } from 'react';
import type { Media } from '../shared/schema';
import { api,useResource } from './api';

export function Upload({ onUpload,multiple=false,imagesOnly=false,maxFiles=50,onBusy }: { onUpload:(image:Media)=>void;multiple?:boolean;imagesOnly?:boolean;maxFiles?:number;onBusy?:(busy:boolean)=>void }) {
  const [pending,setPending]=useState(false),[errors,setErrors]=useState<string[]>([]),[status,setStatus]=useState(''),[dragging,setDragging]=useState(false);
  const input=useRef<HTMLInputElement>(null);
  const busy=useRef(false);
  const site=useResource<{ uploadMaxBytes:number;videoMaxBytes:number }>('/api/site');
  async function upload(files:File[]) {
    if (!files.length || busy.current) return;
    setErrors([]); setStatus('');
    const fileLimit=Math.max(0,multiple?maxFiles:Math.min(1,maxFiles));
    if (files.length>fileLimit) { setErrors([`Choose up to ${fileLimit} files for this gallery.`]); if(input.current)input.current.value=''; return; }
    busy.current=true;setPending(true);onBusy?.(true); let completed=0;
    try {
      for (const [index,file] of files.entries()) {
        setStatus(`Uploading ${index+1} of ${files.length}: ${file.name}`);
        const video=file.type==='video/mp4',limit=video?site.data?.videoMaxBytes:site.data?.uploadMaxBytes;
        if (imagesOnly&&video || !['image/png','image/jpeg','image/webp','video/mp4'].includes(file.type)) { setErrors(current=>[...current,`${file.name}: choose ${imagesOnly?'an image':'an image or MP4'}.`]); continue; }
        if (limit&&file.size>limit) { setErrors(current=>[...current,`${file.name}: exceeds ${Math.round(limit/1024/1024)} MB.`]); continue; }
        const form=new FormData(); form.append('image',file);
        try { onUpload(await api<Media>('/api/admin/media',{ method:'POST',body:form })); completed++; }
        catch(error) { setErrors(current=>[...current,`${file.name}: ${(error as Error).message}`]); }
      }
      setStatus(`${completed} of ${files.length} ${files.length===1?'file':'files'} uploaded.`);
    } finally { busy.current=false;setPending(false);onBusy?.(false); if(input.current)input.current.value=''; }
  }
  return <div className={`upload-control drop-zone ${dragging?'dragging':''}`} onDragOver={event=>{ event.preventDefault(); if(!pending)setDragging(true); }} onDragLeave={()=>setDragging(false)} onDrop={event=>{ event.preventDefault();setDragging(false);void upload(Array.from(event.dataTransfer.files)); }}><label className="button secondary upload-label">{pending?'Uploading…':multiple?'Choose files':'Upload image'}<input ref={input} type="file" multiple={multiple} accept={`image/png,image/jpeg,image/webp${imagesOnly?'':',video/mp4'}`} disabled={pending||maxFiles<=0} onChange={event=>void upload(Array.from(event.target.files||[]))} aria-label={multiple?'Upload files':'Upload image'}/></label><p className="helper">Drop {imagesOnly?'images':'images or MP4s'} here, or choose files.{site.data&&` Images up to ${Math.round(site.data.uploadMaxBytes/1024/1024)} MB${imagesOnly?'':`; MP4s up to ${Math.round(site.data.videoMaxBytes/1024/1024)} MB`}.`}</p>{status&&<p role="status">{status}</p>}{errors.length>0&&<div className="form-error" role="alert">{errors.map((error,index)=><p key={index}>{error}</p>)}</div>}</div>;
}
