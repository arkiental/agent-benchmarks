import { useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useNavigate, useParams, useLocation } from 'react-router-dom';
import { IconPlus, IconTrash, IconArrowUp, IconArrowDown } from '@tabler/icons-react';
import type { Media, Post, PostInput, PostSummary, RunInput } from '../shared/schema';
import { categories, outcomes, slugify } from '../shared/schema';
import { api, setCsrf, useResource } from './api';
import { EmptyState, ErrorState, Loading, Pager, MissingImage } from './components';

import { Upload } from './upload';

type Session = { configured: boolean; authenticated: boolean; csrf: string | null };
type MediaList = { media: (Media & { used: number })[]; total: number; bytes: number; limitBytes: number; page: number; pages: number };
type PostList = { posts: PostSummary[]; total: number; page: number; pages: number };
const emptyPost: PostInput = { title: '',slug: '',summary: '',category: 'Design',prompt: '',body: '',status: 'draft',isDemo: false,coverId: null,showcaseMediaIds: [],runs: [],progress: [] };
const newRun = (): RunInput => ({ model: '',harness: '',author: '',elapsedSeconds: null,reasoningEffort: '',tokens: null,estimatedCostUsd: null,outcome: 'Completed',notes: '',conditions: '',resultMediaIds: [] });

export default function Admin() {
  const session = useResource<Session>('/api/admin/session');
  const [logoutError,setLogoutError] = useState('');
  const [loggingOut,setLoggingOut] = useState(false);
  useEffect(() => setCsrf(session.data?.csrf || null),[session.data]);
  useEffect(() => { document.title = 'Owner | Agent Benchmarks'; },[]);
  async function logout() {
    setLoggingOut(true); setLogoutError('');
    try { await api('/api/admin/logout',{ method: 'POST' }); setCsrf(null); session.setData({ configured: true,authenticated: false,csrf: null }); }
    catch (error) { setLogoutError((error as Error).message); }
    finally { setLoggingOut(false); }
  }
  if (session.loading) return <div className="page"><Loading detail/></div>;
  if (session.error) return <div className="page"><ErrorState message={session.error} retry={session.reload}/></div>;
  if (!session.data?.configured) return <div className="page owner-login"><EmptyState title="Owner setup required" body="Set an owner password locally to enable posting."><p className="setup-command">Run <code>npm run admin:password</code>, then restart the server.</p><Link to="/">Back to journal</Link></EmptyState></div>;
  if (!session.data.authenticated) return <Login onSuccess={csrf => { setCsrf(csrf); session.setData({ configured: true,authenticated: true,csrf }); }}/ >;
  return <div className="page admin-page"><div className="admin-nav"><nav aria-label="Owner navigation"><NavLink to="/admin" end>Posts</NavLink><NavLink to="/admin/media">Media</NavLink></nav><button className="text-button" disabled={loggingOut} onClick={logout}>{loggingOut ? 'Signing out...' : 'Sign out'}</button></div>{logoutError && <p className="form-error" role="alert">{logoutError}</p>}<Routes><Route index element={<PostIndex/>}/><Route path="posts/new" element={<Editor/>}/><Route path="posts/:id" element={<EditExisting/>}/><Route path="media" element={<MediaIndex/>}/><Route path="*" element={<EmptyState title="Owner page not found." body="Choose Posts or Media above."/>}/></Routes></div>;
}
function Login({ onSuccess }: { onSuccess: (csrf: string) => void }) {
  const [password,setPassword] = useState('');
  const [error,setError] = useState('');
  const [pending,setPending] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setPending(true); setError('');
    try { const result = await api<{ csrf: string }>('/api/admin/login',{ method: 'POST',body: JSON.stringify({ password }) }); setPassword(''); onSuccess(result.csrf); }
    catch (error) { setError((error as Error).message); }
    finally { setPending(false); }
  }
  return <div className="page owner-login"><header className="compact-heading"><h1>Owner sign in</h1></header><form onSubmit={submit} className="login-form"><label htmlFor="password">Password</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required maxLength={256}/>{error && <p className="form-error" role="alert">{error}</p>}<button className="button" disabled={pending}>{pending ? 'Signing in...' : 'Sign in'}</button></form></div>;
}
function PostIndex() {
  const [page,setPage] = useState(1);
  const resource = useResource<PostList>(`/api/admin/posts?page=${page}`);
  return <><header className="section-heading admin-heading"><h1>Your posts.</h1><Link className="button" to="/admin/posts/new"><IconPlus size={20} stroke={1.5}/>New post</Link></header>{resource.loading ? <Loading/> : resource.error ? <ErrorState message={resource.error} retry={resource.reload}/> : resource.data?.posts.length ? <><div className="admin-posts">{resource.data.posts.map(post => <Link className="admin-post" key={post.id} to={`/admin/posts/${post.id}`}>{post.cover ? <img src={post.cover.thumbnailUrl} alt=""/> : <MissingImage/>}<div><h2>{post.title}</h2><p>{post.category}{post.isDemo ? ' / Example' : ''}</p></div><span className="post-status">{post.status === 'published' ? 'Published' : 'Draft'}</span></Link>)}</div><Pager page={page} pages={resource.data.pages} onPage={setPage}/></> : <EmptyState title="No posts yet." body="Create a post to add a prompt, media and recorded runs."/>}</>;
}
function EditExisting() {
  const { id } = useParams();
  const resource = useResource<Post>(`/api/admin/posts/${id}`);
  if (resource.loading) return <Loading detail/>;
  if (resource.error || !resource.data) return <ErrorState message={resource.error || 'Post not found.'} retry={resource.reload}/>;
  return <Editor key={resource.data.id} initial={resource.data}/>;
}
function MediaSelect({ label,value,onChange,media,required = false }: { label: string; value: string; onChange: (value: string) => void; media: Media[]; required?: boolean }) {
  return <label>{label}<select aria-label={label} value={value} onChange={event => onChange(event.target.value)} required={required}><option value="">Choose an image</option>{media.map(image => <option value={image.id} key={image.id}>{image.name}</option>)}</select></label>;
}
function Editor({ initial }: { initial?: Post }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [form,setForm] = useState<PostInput>(() => initial ? toInput(initial) : { ...emptyPost });
  const [postId,setPostId] = useState(initial?.id);
  const [mediaPage,setMediaPage] = useState(1);
  const mediaResource = useResource<MediaList>(`/api/admin/media?limit=60&page=${mediaPage}`);
  const [knownMedia,setKnownMedia] = useState<Record<string,Media>>(initial?.media || {});
  const [saved,setSaved] = useState(JSON.stringify(initial ? toInput(initial) : emptyPost));
  const [pending,setPending] = useState(false);
  const [uploads,setUploads] = useState(0);
  const uploadBusy = (busy:boolean) => setUploads(current=>current+(busy?1:-1));
  const [error,setError] = useState('');
  const [message,setMessage] = useState<string>((location.state as { notice?:string } | null)?.notice || '');
  const [customSlug,setCustomSlug] = useState(Boolean(initial));
  const dirty = JSON.stringify(form)!==saved || uploads>0;
  useEffect(() => { if (mediaResource.data) setKnownMedia(current => ({ ...current,...Object.fromEntries(mediaResource.data!.media.map(image => [image.id,image])) })); },[mediaResource.data]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue=''; } };
    const leaving = (event: MouseEvent) => {
      const link = (event.target as HTMLElement).closest('a');
      if (dirty && link && !link.target && link.pathname !== window.location.pathname && !window.confirm('Leave this page and discard unsaved changes?')) event.preventDefault();
    };
    window.addEventListener('beforeunload',beforeUnload); document.addEventListener('click',leaving,true);
    return () => { window.removeEventListener('beforeunload',beforeUnload); document.removeEventListener('click',leaving,true); };
  },[dirty]);
  function update<K extends keyof PostInput>(key: K,value: PostInput[K]) { setForm(current => ({ ...current,[key]: value })); setMessage(''); }
  function updateRun(index: number,value: Partial<RunInput>) { update('runs',form.runs.map((run,position) => position===index ? { ...run,...value } : run)); }
  function upload(image: Media,target: 'cover'|'showcase'|'progress'='cover') {
    setKnownMedia(current => ({ ...current,[image.id]:image })); setMessage('');
    setForm(current => ({ ...current,coverId:current.coverId || (image.kind==='image'?image.id:null),
      showcaseMediaIds:target==='showcase'?[...(current.showcaseMediaIds || []),image.id]:current.showcaseMediaIds,
      progress:target==='progress'?[...current.progress,{ mediaId:image.id,label:image.name,elapsedSeconds:null }]:current.progress }));
    mediaResource.reload();
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setMessage(''); setPending(true);
    const status = ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement)?.value === 'published' ? 'published' : 'draft';
    try {
      const result = await api<Post>(postId ? `/api/admin/posts/${postId}` : '/api/admin/posts',{ method: postId ? 'PUT' : 'POST',body: JSON.stringify({ ...form,status }) });
      const next = toInput(result); setForm(next); setSaved(JSON.stringify(next)); setPostId(result.id); setCustomSlug(true);
      setMessage(status==='published' ? 'Published. Your post is in the journal.' : 'Draft saved.');
      if (!postId) navigate(`/admin/posts/${result.id}`,{ replace:true,state:{ notice:status==='published'?'Published.':'Draft saved.' } });
    } catch (error) { setError((error as Error).message); }
    finally { setPending(false); }
  }
  async function remove() {
    if (!postId || !window.confirm('Delete this post? Its images will stay in Media.')) return;
    setPending(true); setError('');
    try { await api(`/api/admin/posts/${postId}`,{ method: 'DELETE',body: JSON.stringify({ revision: form.revision }) }); setSaved(JSON.stringify(form)); navigate('/admin'); }
    catch (error) { setError((error as Error).message); setPending(false); }
  }
  function moveProgress(from:number,to:number) { const steps=[...form.progress]; const [step]=steps.splice(from,1); steps.splice(to,0,step); update('progress',steps); }
  function reorder(index:number,direction:number) { moveProgress(index,index+direction); }
  function moveShowcase(from:number,to:number) { const items=[...(form.showcaseMediaIds || [])];const [item]=items.splice(from,1);items.splice(to,0,item);update('showcaseMediaIds',items); }
  function dropped(event:React.DragEvent,kind:'progress'|'showcase',to:number) { event.preventDefault();const value=event.dataTransfer.getData('application/x-gallery-item').split(':'); if(value[0]===kind&&/^\d+$/.test(value[1])) { const from=Number(value[1]);if(from<(kind==='progress'?form.progress.length:(form.showcaseMediaIds || []).length)) (kind==='progress'?moveProgress:moveShowcase)(from,to); } }
  function dragHandle(kind:'progress'|'showcase',index:number) { return <button className="text-button" type="button" draggable onDragStart={event=>{event.dataTransfer.setData('application/x-gallery-item',kind+':'+index);event.dataTransfer.effectAllowed='move';}} aria-label={`Drag ${kind} ${index+1} to reorder`}>Drag to reorder</button>; }
  const media = Object.values(knownMedia).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  return <><header className="editor-heading"><Link className="back-link" to="/admin">Back to posts</Link><h1>{postId ? 'Edit post.' : 'New post.'}</h1><span>{form.status==='published' ? 'Published' : 'Draft'}{dirty ? ' / Unsaved changes' : ''}</span></header><form className="editor-form" onSubmit={save}><fieldset disabled={pending} className="editor-fields"><section className="editor-section"><h2>The work</h2><label>Title<input value={form.title} required minLength={3} maxLength={160} onChange={event => { update('title',event.target.value); if (!customSlug) update('slug',slugify(event.target.value)); }}/></label><div className="form-columns"><label>Post URL<input value={form.slug} required minLength={3} maxLength={180} pattern="[a-z0-9]+(-[a-z0-9]+)*" onChange={event => { setCustomSlug(true); update('slug',event.target.value); }}/><span className="helper">/posts/{form.slug || 'your-post'}</span></label><label>Category<select aria-label="Category" value={form.category} onChange={event => update('category',event.target.value as PostInput['category'])}>{categories.map(category => <option key={category}>{category}</option>)}</select></label></div><label>Short description<textarea rows={2} value={form.summary} maxLength={320} onChange={event => update('summary',event.target.value)}/></label><label className="checkbox-label"><input type="checkbox" checked={form.isDemo} onChange={event => update('isDemo',event.target.checked)}/>Label this as example content</label></section><section className="editor-section"><h2>Cover image</h2>{form.coverId && knownMedia[form.coverId] && <img className="editor-cover" src={knownMedia[form.coverId].thumbnailUrl} alt="Selected cover"/>}<Upload onBusy={uploadBusy} imagesOnly onUpload={image=>upload(image)}/><MediaSelect label="Or choose existing media" value={form.coverId || ''} onChange={id => update('coverId',id || null)} media={media.filter(image=>image.kind==='image')}/>{form.coverId && <button className="text-button" type="button" onClick={() => update('coverId',null)}>Remove cover</button>}{mediaResource.loading && <p role="status">Loading media...</p>}{mediaResource.error && <p className="form-error" role="alert">{mediaResource.error}</p>}{mediaResource.data && <Pager page={mediaPage} pages={mediaResource.data.pages} onPage={setMediaPage}/>}</section><section className="editor-section"><h2>Prompt and result</h2><label>Original prompt<textarea className="prompt-input" rows={7} required value={form.prompt} maxLength={100000} onChange={event => update('prompt',event.target.value)}/><span className="helper">Keep the exact wording of the task.</span></label><label>Result notes<textarea rows={5} value={form.body} maxLength={30000} onChange={event => update('body',event.target.value)}/></label></section><section className="editor-section"><div className="section-heading"><h2>Runs</h2><button className="button secondary" type="button" disabled={form.runs.length>=20} onClick={() => update('runs',[...form.runs,newRun()])}><IconPlus size={20} stroke={1.5}/>Add run</button></div><p className="helper">Record only values you measured. Leave elapsed time blank when unknown.</p>{form.runs.map((run,index) => <fieldset className="run-editor" key={index}><legend>Run {index+1}</legend><div className="form-columns"><label>Model<input value={run.model} required maxLength={120} onChange={event => updateRun(index,{ model: event.target.value })}/></label><label>Agent / tool<input value={run.harness} maxLength={120} onChange={event => updateRun(index,{ harness: event.target.value })}/></label><label>Elapsed time (seconds)<input type="number" min={0} max={31536000} step={1} value={run.elapsedSeconds ?? ''} onChange={event => updateRun(index,{ elapsedSeconds: event.target.value==='' ? null : Number(event.target.value) })}/></label><label>Reasoning effort<input value={run.reasoningEffort || ''} maxLength={80} onChange={event=>updateRun(index,{reasoningEffort:event.target.value})}/></label><label>Tokens<input type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1} value={run.tokens ?? ''} onChange={event=>updateRun(index,{tokens:event.target.value===''?null:Number(event.target.value)})}/></label><label>Estimated cost (USD)<input type="number" min={0} max={1000000} step="any" value={run.estimatedCostUsd ?? ''} onChange={event=>updateRun(index,{estimatedCostUsd:event.target.value===''?null:Number(event.target.value)})}/></label><label>Outcome<select aria-label="Outcome" value={run.outcome} onChange={event => updateRun(index,{ outcome: event.target.value as RunInput['outcome'] })}>{outcomes.map(outcome => <option key={outcome}>{outcome}</option>)}</select></label></div><label>Run by<input value={run.author} maxLength={120} onChange={event => updateRun(index,{ author: event.target.value })}/></label><label>Conditions<textarea rows={2} value={run.conditions} maxLength={6000} onChange={event => updateRun(index,{ conditions: event.target.value })}/><span className="helper">Tools, environment and any limits relevant to comparison.</span></label><label>Run notes<textarea rows={3} value={run.notes} maxLength={12000} onChange={event => updateRun(index,{ notes: event.target.value })}/></label><div className="attached-images">{run.resultMediaIds.map(id => <div key={id}>{knownMedia[id] && <img src={knownMedia[id].thumbnailUrl} alt={knownMedia[id].name}/>}<button className="text-button" type="button" onClick={() => updateRun(index,{ resultMediaIds: run.resultMediaIds.filter(value => value!==id) })}>Remove image</button></div>)}</div>{run.resultMediaIds.length<12 && <MediaSelect label="Add result image" value="" onChange={id => { if (id && !run.resultMediaIds.includes(id)) updateRun(index,{ resultMediaIds: [...run.resultMediaIds,id] }); }} media={media.filter(image => !run.resultMediaIds.includes(image.id))}/>}<button className="text-button danger" type="button" onClick={() => update('runs',form.runs.filter((_run,position) => position!==index))}><IconTrash size={18} stroke={1.5}/>Remove run</button></fieldset>)}</section><section className="editor-section"><h2>Final showcase</h2><Upload onBusy={uploadBusy} multiple maxFiles={50-(form.showcaseMediaIds || []).length} onUpload={image=>upload(image,'showcase')}/><div className="showcase-editor">{(form.showcaseMediaIds || []).map((id,index)=><fieldset className="gallery-editor-item" key={id} onDragOver={event=>event.preventDefault()} onDrop={event=>dropped(event,'showcase',index)}><legend>Final {index+1}</legend>{knownMedia[id]&&<img src={knownMedia[id].thumbnailUrl} alt={knownMedia[id].name} loading="lazy"/>}<div className="row-actions">{dragHandle('showcase',index)}<button className="text-button" type="button" disabled={index===0} onClick={()=>moveShowcase(index,index-1)} aria-label={`Move final ${index+1} earlier`}>Earlier</button><button className="text-button" type="button" disabled={index===(form.showcaseMediaIds || []).length-1} onClick={()=>moveShowcase(index,index+1)} aria-label={`Move final ${index+1} later`}>Later</button><button className="text-button" type="button" onClick={()=>update('showcaseMediaIds',(form.showcaseMediaIds || []).filter(value=>value!==id))}>Remove</button></div></fieldset>)}</div>{(form.showcaseMediaIds || []).length<50&&<MediaSelect label="Add existing final media" value="" onChange={id=>{if(id)update('showcaseMediaIds',[...(form.showcaseMediaIds || []),id]);}} media={media.filter(image=>!(form.showcaseMediaIds || []).includes(image.id))}/>}</section><section className="editor-section"><h2>Progress</h2><Upload onBusy={uploadBusy} multiple maxFiles={50-form.progress.length} onUpload={image=>upload(image,'progress')}/><p className="helper">Up to 50 images or videos. Drag to reorder, or use Earlier and Later.</p>{form.progress.map((step,index) => <fieldset className="progress-editor" key={index} onDragOver={event=>event.preventDefault()} onDrop={event=>dropped(event,'progress',index)}><legend>Progress {index+1}</legend>{knownMedia[step.mediaId] && <img src={knownMedia[step.mediaId].thumbnailUrl} alt={step.label || 'Progress image'}/>}<label>What happened<input value={step.label} required maxLength={160} onChange={event => update('progress',form.progress.map((value,position) => position===index ? { ...value,label: event.target.value } : value))}/></label><label>Elapsed time (seconds)<input type="number" min={0} max={31536000} step={1} value={step.elapsedSeconds ?? ''} onChange={event => update('progress',form.progress.map((value,position) => position===index ? { ...value,elapsedSeconds: event.target.value==='' ? null : Number(event.target.value) } : value))}/></label><div className="row-actions">{dragHandle('progress',index)}<button className="button secondary" type="button" disabled={index===0} onClick={() => reorder(index,-1)} aria-label={`Move progress ${index+1} earlier`}><IconArrowUp size={18} stroke={1.5}/>Earlier</button><button className="button secondary" type="button" disabled={index===form.progress.length-1} onClick={() => reorder(index,1)} aria-label={`Move progress ${index+1} later`}><IconArrowDown size={18} stroke={1.5}/>Later</button><button className="text-button" type="button" onClick={() => update('progress',form.progress.filter((_value,position) => position!==index))}>Remove</button></div></fieldset>)}{form.progress.length<50 && <MediaSelect label="Add existing progress media" value="" onChange={id => { if (id) update('progress',[...form.progress,{ mediaId: id,label: '',elapsedSeconds: null }]); }} media={media}/>}</section></fieldset>{error && <p className="form-error save-message" role="alert">{error}</p>}{message && <p className="save-message" role="status">{message}</p>}<div className="editor-actions"><button className="button secondary" type="submit" value="draft" disabled={pending||uploads>0}>{pending ? 'Saving...' : form.status==='published' ? 'Move to draft' : 'Save draft'}</button><button className="button" type="submit" value="published" disabled={pending||uploads>0}>{pending ? 'Saving...' : form.status==='published' ? 'Save published' : 'Publish'}</button>{postId && form.status==='published' && !dirty && <Link to={`/posts/${form.slug}`} target="_blank" rel="noopener">View post</Link>}{postId && <button className="text-button delete-post" type="button" disabled={pending||uploads>0} onClick={remove}>Delete post</button>}</div></form></>;
}
function toInput(post: Post): PostInput {
  return { title: post.title,slug: post.slug,summary: post.summary,category: post.category,prompt: post.prompt,body: post.body,status: post.status,isDemo: post.isDemo,coverId: post.coverId,showcaseMediaIds: post.showcaseMediaIds,runs: post.runs,progress: post.progress,revision: post.revision };
}
function MediaIndex() {
  const [page,setPage] = useState(1);
  const resource = useResource<MediaList>(`/api/admin/media?page=${page}`);
  const [error,setError] = useState('');
  const [pending,setPending] = useState<string | null>(null);
  async function remove(image: Media & { used: number }) {
    if (!window.confirm(`Delete ${image.name}?`)) return;
    setPending(image.id); setError('');
    try { await api(`/api/admin/media/${image.id}`,{ method: 'DELETE' }); resource.reload(); }
    catch (error) { setError((error as Error).message); }
    finally { setPending(null); }
  }
  return <><header className="compact-heading"><h1>Media</h1></header><Upload multiple onUpload={() => resource.reload()}/>{error && <p className="form-error" role="alert">{error}</p>}{resource.loading ? <Loading/> : resource.error ? <ErrorState message={resource.error} retry={resource.reload}/> : resource.data?.media.length ? <><p className="storage-note">{(resource.data.bytes/1024/1024).toFixed(1)} MB of {Math.round(resource.data.limitBytes/1024/1024)} MB used</p><div className="media-grid">{resource.data.media.map(image => <article key={image.id}><img src={image.thumbnailUrl} alt={image.name} loading="lazy"/><h2>{image.name}</h2><p>{image.kind==='video'?'MP4 / ':''}{image.width} × {image.height}{image.used ? ` / Used in ${image.used} ${image.used===1 ? 'post' : 'posts'}` : ' / Unused'}</p><button className="button secondary" disabled={Boolean(image.used) || pending===image.id} onClick={() => remove(image)}>{pending===image.id ? 'Deleting...' : 'Delete image'}</button></article>)}</div><Pager page={page} pages={resource.data.pages} onPage={setPage}/></> : <EmptyState title="No media yet." body="Upload images or MP4s above."/>}</>;
}
