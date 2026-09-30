import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ComparisonGroup, GroupInput, PostSummary } from '../shared/schema';
import { api, ApiError, useResource } from './api';
import { EmptyState, ErrorState, Loading, Pager, MissingImage } from './components';

type PostList = { posts: PostSummary[]; page: number; pages: number; total: number };

export function AdminGroups() {
  const resource=useResource<{groups:ComparisonGroup[]}>('/api/admin/groups');
  const [editing,setEditing]=useState<ComparisonGroup | 'new' | null>(null);
  const [notice,setNotice]=useState('');
  if(editing) return <GroupEditor key={editing==='new'?'new':`${editing.id}:${editing.revision}`} initial={editing==='new'?undefined:editing} groups={resource.data?.groups || []} onClose={()=>setEditing(null)} onSaved={message=>{setNotice(message);setEditing(null);resource.reload();}} onReload={async id=>{
    const result=await api<{groups:ComparisonGroup[]}>('/api/admin/groups'); resource.setData(result);
    const group=result.groups.find(value=>value.id===id); if(!group)throw new Error('This group was deleted. Return to groups.'); setEditing(group);
  }}/>;
  return <>
    <header className="section-heading admin-heading"><h1>Groups</h1><button className="button" onClick={()=>{setNotice('');setEditing('new');}}>New group</button></header>
    {notice && <p className="save-message" role="status">{notice}</p>}
    {resource.loading?<Loading/>:resource.error?<ErrorState message={resource.error} retry={resource.reload}/>:resource.data?.groups.length?<div className="owner-group-list">{resource.data.groups.map(group=><article className="owner-group" key={group.id}>
      <div><h2>{group.title}</h2><p>{group.posts.length} {group.posts.length===1?'post':'posts'} / Side by side {group.allowSideBySide?'enabled':'disabled'}</p></div>
      <button className="button secondary" aria-label={`Edit ${group.title}`} onClick={()=>setEditing(group)}>Edit group</button>
    </article>)}</div>:<EmptyState title="No groups yet." body="Group posts to switch between their prompts, results and recorded runs."/>}
  </>;
}

function GroupEditor({initial,groups,onClose,onSaved,onReload}: {
  initial?:ComparisonGroup; groups:ComparisonGroup[]; onClose:()=>void; onSaved:(message:string)=>void; onReload:(id:string)=>Promise<void>;
}) {
  const initialInput:GroupInput={title:initial?.title || '',allowSideBySide:initial?.allowSideBySide || false,postIds:initial?.posts.map(post=>post.id) || [],...(initial?{revision:initial.revision}:{})};
  const [form,setForm]=useState(initialInput);
  const [page,setPage]=useState(1);
  const posts=useResource<PostList>(`/api/admin/posts?limit=60&page=${page}`);
  const [knownPosts,setKnownPosts]=useState<Record<string,PostSummary>>(()=>Object.fromEntries((initial?.posts || []).map(post=>[post.id,post])));
  const [pending,setPending]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false);
  const dirty=JSON.stringify(form)!==JSON.stringify(initialInput);
  useEffect(()=>{if(posts.data)setKnownPosts(current=>({...current,...Object.fromEntries(posts.data!.posts.map(post=>[post.id,post]))}));},[posts.data]);
  useEffect(()=>{
    const beforeUnload=(event:BeforeUnloadEvent)=>{if(dirty){event.preventDefault();event.returnValue='';}};
    const leaving=(event:MouseEvent)=>{const link=(event.target as HTMLElement).closest('a');if(dirty && link && !link.target && link.pathname!==window.location.pathname && !window.confirm('Leave this page and discard unsaved changes?'))event.preventDefault();};
    window.addEventListener('beforeunload',beforeUnload);document.addEventListener('click',leaving,true);
    return()=>{window.removeEventListener('beforeunload',beforeUnload);document.removeEventListener('click',leaving,true);};
  },[dirty]);
  function close(){if(!dirty || window.confirm('Discard unsaved group changes?'))onClose();}
  function select(id:string,checked:boolean){setForm(current=>({...current,postIds:checked?[...current.postIds,id]:current.postIds.filter(value=>value!==id)}));}
  async function save(event:React.FormEvent){
    event.preventDefault();setPending(true);setError('');setConflict(false);
    try{await api<ComparisonGroup>(initial?`/api/admin/groups/${initial.id}`:'/api/admin/groups',{method:initial?'PUT':'POST',body:JSON.stringify(form)});onSaved(initial?'Group saved.':'Group created.');}
    catch(error){setError((error as Error).message);setConflict(error instanceof ApiError && error.status===409);}
    finally{setPending(false);}
  }
  async function remove(){
    if(!initial || !window.confirm('Delete this group? Its posts will remain in the journal.'))return;
    setPending(true);setError('');setConflict(false);
    try{await api(`/api/admin/groups/${initial.id}`,{method:'DELETE',body:JSON.stringify({revision:initial.revision})});onSaved('Group deleted.');}
    catch(error){setError((error as Error).message);setConflict(error instanceof ApiError && error.status===409);}
    finally{setPending(false);}
  }
  async function reload(){
    if(!initial || !window.confirm('Reload the saved group and discard unsaved changes?'))return;
    setPending(true);setError('');try{await onReload(initial.id);}catch(error){setError((error as Error).message);}finally{setPending(false);}
  }
  return <>
    <header className="editor-heading"><button className="text-button" type="button" onClick={close}>Back to groups</button><h1>{initial?'Edit group':'New group'}</h1></header>
    <form className="editor-form" onSubmit={save}>
      <fieldset className="editor-fields" disabled={pending}>
        <section className="editor-section">
          <label>Group title<input value={form.title} required maxLength={160} onChange={event=>setForm(current=>({...current,title:event.target.value}))}/></label>
          <label className="checkbox-label"><input type="checkbox" checked={form.allowSideBySide} onChange={event=>setForm(current=>({...current,allowSideBySide:event.target.checked}))}/>Enable side-by-side comparison</label>
          <p className="helper">Model tabs switch the whole post. This toggle also allows visitors to compare selected runs from this group.</p>
        </section>
        <section className="editor-section">
          <div className="section-heading"><h2>Posts</h2><span className="helper">{form.postIds.length} of 20 selected</span></div>
          {form.postIds.length>0 && <div className="group-selected-posts" aria-label="Selected posts">{form.postIds.map(id=><div key={id}><span>{knownPosts[id]?.title || 'Selected post'}</span><button type="button" className="text-button" aria-label={`Remove ${knownPosts[id]?.title || 'selected post'} from group`} onClick={()=>select(id,false)}>Remove</button></div>)}</div>}
          {posts.loading?<Loading/>:posts.error?<ErrorState message={posts.error} retry={posts.reload}/>:posts.data?.posts.length?<>
            <div className="group-post-options">{posts.data.posts.map(post=>{
              const selected=form.postIds.includes(post.id),otherGroup=post.groupId && post.groupId!==initial?.id;
              const groupTitle=groups.find(group=>group.id===post.groupId)?.title;
              return <label className="group-post-option" key={post.id}>
                <input type="checkbox" checked={selected} disabled={Boolean(otherGroup) || (!selected && form.postIds.length>=20)} onChange={event=>select(post.id,event.target.checked)}/>
                {post.cover?<img src={post.cover.thumbnailUrl} alt="" loading="lazy"/>:<MissingImage/>}
                <span><strong>{post.title}</strong><span>{post.status==='published'?'Published':'Draft'}{otherGroup?` / In ${groupTitle || 'another group'}`:''}</span></span>
              </label>;
            })}</div>
            <Pager page={page} pages={posts.data.pages} onPage={setPage}/>
          </>:<EmptyState title="No posts yet." body="Create a post before adding group members."><Link to="/admin/posts/new">New post</Link></EmptyState>}
          <p className="helper">Only published members appear publicly. To move a post from another group, change its group in the post editor.</p>
        </section>
      </fieldset>
      {error && <div className="form-error save-message" role="alert">{error}{conflict && initial && <button type="button" className="text-button" disabled={pending} onClick={()=>void reload()}>Reload saved group</button>}</div>}
      <div className="editor-actions"><button className="button" disabled={pending}>{pending?'Saving...':'Save group'}</button><button className="button secondary" type="button" disabled={pending} onClick={close}>Cancel</button>{initial && <button className="text-button delete-post" type="button" disabled={pending} onClick={()=>void remove()}>Delete group</button>}</div>
    </form>
  </>;
}
