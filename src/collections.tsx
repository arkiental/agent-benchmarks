import { useState } from 'react';
import { IconChevronDown } from '@tabler/icons-react';
import type { Media, RenderCollection } from '../shared/schema';
import { MediaGallery } from './components';
import './collections.css';

export function RenderCollections({ collections,media }: { collections:RenderCollection[];media:Record<string,Media> }) {
  if (!collections.length) return null;
  return <section className="detail-section render-collections" aria-label="Render collections">
    <h2>Collections</h2>
    <div className="collection-list">{collections.map(collection => <RenderCollectionView key={collection.id} collection={collection} media={media}/>)}</div>
  </section>;
}

function RenderCollectionView({ collection,media }: { collection:RenderCollection;media:Record<string,Media> }) {
  const [open,setOpen]=useState(false);
  const images=collection.mediaIds.map(id=>media[id]).filter(image=>image?.kind==='image');
  return <details className="render-collection" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>
      <span className="collection-preview" aria-hidden="true">{images.slice(0,3).map(image=><img key={image.id} src={image.thumbnailUrl} alt="" loading="lazy" width={image.width} height={image.height}/>)}</span>
      <span className="collection-title">{collection.title}<span className="collection-count">{images.length} {images.length===1?'image':'images'}</span></span>
      <IconChevronDown className="collection-chevron" size={22} stroke={1.5} aria-hidden="true"/>
    </summary>
    {open && (images.length ? <MediaGallery galleryClass="collection-image-grid" viewerLabel={collection.title} items={images.map((image,index)=>({image,label:collection.title+' '+(index+1)}))}/> : <p className="helper collection-empty">No images in this collection.</p>)}
  </details>;
}
