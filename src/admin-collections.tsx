import { IconPlus } from '@tabler/icons-react';
import type { Media, RenderCollection } from '../shared/schema';
import { Upload } from './upload';
import './collections.css';

export function CollectionEditor({ collections,media,knownMedia,onChange,onUpload,onBusy,busy }: {
  collections:RenderCollection[];media:Media[];knownMedia:Record<string,Media>;
  onChange:(value:RenderCollection[])=>void;onUpload:(image:Media,collectionId:string)=>void;onBusy:(busy:boolean)=>void;busy:boolean;
}) {
  const total=collections.reduce((count,collection)=>count+collection.mediaIds.length,0);
  function update(id:string,value:Partial<RenderCollection>) { onChange(collections.map(collection=>collection.id===id?{...collection,...value}:collection)); }
  function moveCollection(from:number,to:number) {
    if(from<0||to<0||from>=collections.length||to>=collections.length)return;
    const next=[...collections]; const [item]=next.splice(from,1);next.splice(to,0,item);onChange(next);
  }
  function moveImage(collection:RenderCollection,from:number,to:number) {
    if(from<0||to<0||from>=collection.mediaIds.length||to>=collection.mediaIds.length)return;
    const next=[...collection.mediaIds];const [item]=next.splice(from,1);next.splice(to,0,item);update(collection.id,{mediaIds:next});
  }
  return <section className="editor-section collection-editor-section">
    <div className="section-heading"><h2>Render collections</h2><button className="button secondary" type="button" disabled={busy||collections.length>=20} onClick={()=>onChange([...collections,{id:crypto.randomUUID(),title:'Collection '+(collections.length+1),mediaIds:[]}])}><IconPlus size={20} stroke={1.5}/>Add collection</button></div>
    <p className="helper">Named image groups, collapsed on the post. Up to 20 collections, 100 images each and 500 images total.</p>
    <div className="collection-editor-list">{collections.map((collection,index)=>{
      const remaining=Math.max(0,Math.min(100-collection.mediaIds.length,500-total));
      return <fieldset key={collection.id} className="collection-editor" disabled={busy} onDragOver={event=>{if(event.dataTransfer.types.includes('application/x-render-collection'))event.preventDefault();}} onDrop={event=>{
        const id=event.dataTransfer.getData('application/x-render-collection');if(!id)return;event.preventDefault();moveCollection(collections.findIndex(item=>item.id===id),index);
      }}>
        <legend>Collection {index+1}</legend>
        <div className="collection-editor-heading"><label>Collection {index+1} name<input required maxLength={120} value={collection.title} onChange={event=>update(collection.id,{title:event.target.value})}/></label><span className="helper">{collection.mediaIds.length} / 100 images</span></div>
        <div className="row-actions collection-editor-actions">
          <button className="text-button" type="button" draggable aria-label={'Drag collection '+(index+1)+' to reorder'} onDragStart={event=>{event.dataTransfer.setData('application/x-render-collection',collection.id);event.dataTransfer.effectAllowed='move';}}>Drag to reorder</button>
          <button className="text-button" type="button" disabled={index===0} aria-label={'Move collection '+(index+1)+' earlier'} onClick={()=>moveCollection(index,index-1)}>Earlier</button>
          <button className="text-button" type="button" disabled={index===collections.length-1} aria-label={'Move collection '+(index+1)+' later'} onClick={()=>moveCollection(index,index+1)}>Later</button>
          <button className="text-button" type="button" aria-label={'Remove collection '+(index+1)} onClick={()=>onChange(collections.filter(item=>item.id!==collection.id))}>Remove collection</button>
        </div>
        <Upload imagesOnly multiple maxFiles={remaining} onBusy={onBusy} onUpload={image=>onUpload(image,collection.id)}/>
        {remaining>0 && <label>Add existing collection image<select aria-label={'Add image to collection '+(index+1)} value="" onChange={event=>{const id=event.target.value;if(id)update(collection.id,{mediaIds:[...collection.mediaIds,id]});}}><option value="">Choose an image</option>{media.filter(image=>image.kind==='image'&&!collection.mediaIds.includes(image.id)).map(image=><option key={image.id} value={image.id}>{image.name}</option>)}</select></label>}
        <div className="collection-editor-images">{collection.mediaIds.map((id,imageIndex)=>{
          const image=knownMedia[id];return <div className="collection-editor-image" key={id} onDragOver={event=>{if(event.dataTransfer.types.includes('application/x-collection-image'))event.preventDefault();}} onDrop={event=>{
            const value=event.dataTransfer.getData('application/x-collection-image').split(':');if(value[0]!==collection.id||!/^\d+$/.test(value[1]))return;event.preventDefault();event.stopPropagation();moveImage(collection,Number(value[1]),imageIndex);
          }}>
            {image && <img src={image.thumbnailUrl} alt={image.name} loading="lazy" width={image.width} height={image.height}/>}
            <p className="helper">{imageIndex+1}. {image?.name || 'Image'}</p>
            <div className="row-actions">
              <button className="text-button" type="button" draggable aria-label={'Drag image '+(imageIndex+1)+' in collection '+(index+1)+' to reorder'} onDragStart={event=>{event.dataTransfer.setData('application/x-collection-image',collection.id+':'+imageIndex);event.dataTransfer.effectAllowed='move';}}>Drag</button>
              <button className="text-button" type="button" disabled={imageIndex===0} aria-label={'Move image '+(imageIndex+1)+' in collection '+(index+1)+' earlier'} onClick={()=>moveImage(collection,imageIndex,imageIndex-1)}>Earlier</button>
              <button className="text-button" type="button" disabled={imageIndex===collection.mediaIds.length-1} aria-label={'Move image '+(imageIndex+1)+' in collection '+(index+1)+' later'} onClick={()=>moveImage(collection,imageIndex,imageIndex+1)}>Later</button>
              <button className="text-button" type="button" aria-label={'Remove image '+(imageIndex+1)+' from collection '+(index+1)} onClick={()=>update(collection.id,{mediaIds:collection.mediaIds.filter(value=>value!==id)})}>Remove</button>
            </div>
          </div>;
        })}</div>
      </fieldset>;
    })}</div>
  </section>;
}
