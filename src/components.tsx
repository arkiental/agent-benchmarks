import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { IconX, IconChevronLeft, IconChevronRight, IconPhoto, IconPlayerPlay } from '@tabler/icons-react';
import type { Media } from '../shared/schema';

export function ErrorState({ message,retry }: { message: string; retry?: () => void }) {
  return <div className="state error-state" role="alert"><h2>Something went wrong.</h2><p>{message}</p>{retry && <button className="button" onClick={retry}>Try again</button>}</div>;
}
export function EmptyState({ title,body,children }: { title: string; body: string; children?: React.ReactNode }) {
  return <div className="state"><h2>{title}</h2><p>{body}</p>{children}</div>;
}
export function Loading({ detail = false }: { detail?: boolean }) {
  return <div className={`skeletons ${detail ? 'detail-skeleton' : ''}`} aria-busy="true" aria-label="Loading content"><div className="skeleton-title"/><div className="skeleton-image"/>{!detail && <div className="skeleton-image"/>}<span className="sr-only" role="status">Loading content</span></div>;
}
export function MissingImage() {
  return <div className="missing-image"><IconPhoto size={40} stroke={1.5}/><span>No cover yet</span></div>;
}
export function Pager({ page,pages,onPage }: { page: number; pages: number; onPage: (page: number) => void }) {
  if (pages <= 1) return null;
  return <nav className="pager" aria-label="Pagination"><button type="button" className="button secondary" disabled={page===1} onClick={() => onPage(page-1)}><IconChevronLeft size={20} stroke={1.5}/>Previous</button><span>Page {page} of {pages}</span><button type="button" className="button secondary" disabled={page>=pages} onClick={() => onPage(page+1)}>Next<IconChevronRight size={20} stroke={1.5}/></button></nav>;
}
export function Paragraphs({ text }: { text: string }) {
  return <div className="prose">{text.split(/\n\s*\n/).filter(Boolean).map((paragraph,index) => <p key={index}>{paragraph}</p>)}</div>;
}
export function ImageViewer({ image,label,className }: { image: Media; label: string; className?: string }) {
  return <MediaGallery items={[{ image,label }]} singleClass={className}/>;
}
export type GalleryItem = { image: Media; label: string; elapsedSeconds?: number | null };
export function MediaGallery({ items,singleClass }: { items: GalleryItem[]; singleClass?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [active,setActive] = useState<number | null>(null);
  const current = active === null ? null : items[active];
  function show(index: number) { setActive(index); dialog.current?.showModal(); }
  function close() { dialog.current?.close(); setActive(null); }
  function move(direction: number) { setActive(index => index === null ? null : Math.max(0,Math.min(items.length-1,index+direction))); }
  const thumbnail = (item: GalleryItem,index: number) => <button className={`image-button ${singleClass || ''}`} onClick={() => show(index)} aria-label={`View ${item.label}`}><img src={singleClass?item.image.url:item.image.thumbnailUrl} alt={item.label} width={item.image.width} height={item.image.height} loading="lazy"/>{item.image.kind==='video' && <span className="video-marker"><IconPlayerPlay size={22} stroke={1.5}/>MP4</span>}</button>;
  return <>{singleClass ? thumbnail(items[0],0) : <div className="media-gallery">{items.map((item,index) => <figure key={`${item.image.id}-${index}`}>{thumbnail(item,index)}<figcaption><span>{item.label}</span>{item.elapsedSeconds!=null && <span>{item.elapsedSeconds}s</span>}</figcaption></figure>)}</div>}<dialog ref={dialog} className="image-dialog" aria-label="Media viewer" onClose={() => setActive(null)} onKeyDown={event => { if ((event.target as HTMLElement).tagName==='VIDEO') return; if (event.key==='ArrowLeft') { event.preventDefault(); move(-1); } if (event.key==='ArrowRight') { event.preventDefault(); move(1); } }} onClick={event => { if (event.target===event.currentTarget) close(); }}><button className="dialog-close" onClick={close} aria-label="Close media" autoFocus><IconX size={28} stroke={1.5}/></button>{current && <><div className="viewer-content">{current.image.kind==='video' ? <video key={current.image.id} src={current.image.url} poster={current.image.thumbnailUrl} controls playsInline preload="metadata" aria-label={current.label}/> : <img src={current.image.url} alt={current.label}/>}</div><div className="viewer-navigation"><button className="button secondary" disabled={active===0} onClick={() => move(-1)} aria-label="Previous media"><IconChevronLeft size={20}/></button><p aria-live="polite">{active!+1} / {items.length} · {current.label}</p><button className="button secondary" disabled={active===items.length-1} onClick={() => move(1)} aria-label="Next media"><IconChevronRight size={20}/></button></div>{items.length>1 && <div className="viewer-thumbnails" aria-label="Gallery thumbnails">{items.map((item,index) => <button key={`${item.image.id}-${index}`} aria-label={`Show ${item.label}`} aria-pressed={active===index} onClick={() => setActive(index)}><img src={item.image.thumbnailUrl} alt="" loading="lazy"/></button>)}</div>}</>}</dialog></>;
}
export function Shell({ children,name }: { children: React.ReactNode; name: string }) {
  const location = useLocation();
  const admin = location.pathname.startsWith('/admin');
  useEffect(() => { window.scrollTo(0,0); },[location.pathname]);
  return <><a className="skip-link" href="#main">Skip to content</a><header className="site-header"><Link to="/" className="wordmark">{name}</Link><nav aria-label="Main navigation"><Link to="/" aria-current={location.pathname==='/' ? 'page' : undefined}>Journal</Link><Link to="/compare" aria-current={location.pathname==='/compare' ? 'page' : undefined}>Compare</Link></nav></header><main id="main" tabIndex={-1}>{children}</main><footer className="site-footer"><Link to={admin ? '/' : '/admin'}>{admin ? 'Back to journal' : 'Owner sign in'}</Link></footer></>;
}
