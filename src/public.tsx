import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { Prompt,ShareLink,ExtraRunFacts } from './post-controls';
import { References } from './references';
import type { Post, PostSummary, Comparison, ComparisonGroup } from '../shared/schema';
import { duration, outcomes, providerLabel } from '../shared/schema';
import { useResource } from './api';
import { Loading, EmptyState, ErrorState, Pager, Paragraphs, ImageViewer, MediaGallery, MissingImage } from './components';
import './enhancements.css';

type Catalog = { models:string[];categories:string[];providers:string[];reasoningEfforts:string[] };
type PostList = { posts: PostSummary[]; total: number; page: number; pages: number };
function useFilters() {
  const [params,setParams] = useSearchParams();
  const update=useCallback((values:Record<string,string>,replace=false) => {
    setParams(current => {
      const next=new URLSearchParams(current);
      Object.entries(values).forEach(([key,value]) => { if (value) next.set(key,value); else next.delete(key); });
      if (!('page' in values)) next.delete('page');
      return next;
    },{ replace });
  },[setParams]);
  const change=useCallback((key:string,value:string,replace=false) => update({ [key]:value },replace),[update]);
  return { params,change,update,clear:()=>setParams(new URLSearchParams()) };
}
export function Journal() {
  const { params,change,update,clear } = useFilters();
  const location=useLocation();
  const currentLocation=useRef(location.key);
  currentLocation.current=location.key;
  const resource = useResource<PostList>(`/api/posts?${params}`);
  const catalog = useResource<Catalog>('/api/catalog');
  const [search,setSearch] = useState(params.get('q') || '');
  useEffect(() => setSearch(params.get('q') || ''),[params]);
  useEffect(() => {
    if (search===(params.get('q') || '')) return;
    const sourceKey=location.key;
    const pending=window.setTimeout(() => {
      if (currentLocation.current===sourceKey) change('q',search,true);
    },250);
    return () => window.clearTimeout(pending);
  },[search,params,location.key,change]);
  useEffect(() => { document.title = 'Journal | Agent Benchmarks'; },[]);
  const filtered = Boolean(params.get('q') || params.get('category') || params.get('model') || params.get('provider') || params.get('reasoning'));
  const clearFilters=() => { clear();setSearch(''); };
  const filter=(key:string,value:string) => update({ q:search,[key]:value });
  return <div className="page journal">
    <header className="journal-heading"><h1>Journal</h1></header>
    <div className="browse-tools">
      <div className="category-tabs" aria-label="Filter by category">
        <button aria-pressed={!params.get('category')} onClick={() => filter('category','')}>All work</button>
        {catalog.data?.categories.map(category => <button key={category} aria-pressed={params.get('category')===category} onClick={() => filter('category',category)}>{category}</button>)}
      </div>
      <form className="search-form" onSubmit={event => { event.preventDefault();change('q',search); }} role="search">
        <label className="sr-only" htmlFor="search">Search posts</label>
        <input id="search" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search work" maxLength={160}/>
        <button type="submit">Search</button>
      </form>
    </div>
    <div className="journal-filters">
      <label>Provider<select aria-label="Provider" value={params.get('provider') || ''} onChange={event => filter('provider',event.target.value)}>
        <option value="">All providers</option>{catalog.data?.providers?.map(provider => <option key={provider}>{provider}</option>)}
      </select></label>
      <label>Model<select aria-label="Model" value={params.get('model') || ''} onChange={event => filter('model',event.target.value)}>
        <option value="">All models</option>{catalog.data?.models.map(model => <option key={model}>{model}</option>)}
      </select></label>
      <label>Reasoning effort<select aria-label="Reasoning effort" value={params.get('reasoning') || ''} onChange={event => filter('reasoning',event.target.value)}>
        <option value="">All reasoning efforts</option>{catalog.data?.reasoningEfforts?.map(reasoning => <option key={reasoning}>{reasoning}</option>)}
      </select></label>
      {filtered && <button className="button secondary" onClick={clearFilters}>Clear filters</button>}
    </div>
    {resource.loading ? <Loading/> : resource.error ? <ErrorState message={resource.error} retry={resource.reload}/> : resource.data?.posts.length ? <>
      <div className="post-grid">{resource.data.posts.map((post,index) => <article className="post-card" key={post.id}>
        <Link to={`/posts/${post.slug}`} className="post-link">
          {post.cover ? <img src={post.cover.thumbnailUrl} alt={post.title} width={post.cover.width} height={post.cover.height} loading={index<2 ? 'eager' : 'lazy'} fetchPriority={index===0 ? 'high' : 'auto'}/> : <MissingImage/>}
          <div className="post-title"><h2>{post.title}</h2>{post.isDemo && <span className="example-label">Example</span>}</div>
          <PostCardMetadata post={post}/>
        </Link>
      </article>)}</div>
      <Pager page={resource.data.page} pages={resource.data.pages} onPage={page => change('page',String(page))}/>
    </> : <EmptyState title={filtered ? 'No matching work.' : 'The journal starts here.'} body={filtered ? 'Try another search or filter.' : 'Published posts will appear here with their prompts, progress and results.'}>
      {!filtered && <Link className="button" to="/admin">Create a post</Link>}
    </EmptyState>}
  </div>;
}

function PostCardMetadata({ post }: { post:PostSummary }) {
  if (!post.models.length&&!post.providers.length&&!post.reasoningEfforts.length) return null;
  return <dl className="post-card-metadata">
    {post.providers.length>0 && <div><dt className="sr-only">Provider</dt><dd>{post.providers.join(' / ')}</dd></div>}
    {post.models.length>0 && <div><dt className="sr-only">Model</dt><dd>{post.models.join(' / ')}</dd></div>}
    {post.reasoningEfforts.length>0 && <div><dt>Reasoning:</dt><dd>{post.reasoningEfforts.join(' / ')}</dd></div>}
  </dl>;
}
export function PostDetail() {
  const { slug } = useParams();
  const { data:post,loading,error,reload } = useResource<Post>(`/api/posts/${encodeURIComponent(slug || '')}`);
  useEffect(() => { if (post) document.title = `${post.title} | Agent Benchmarks`; },[post]);
  if (loading) return <div className="page"><Loading detail/></div>;
  if (error || !post) return <div className="page"><ErrorState message={error || 'Post not found.'} retry={reload}/><Link to="/">Back to journal</Link></div>;
  return <article key={post.id} className="page detail">
    <Link className="back-link" to="/">Back to journal</Link>
    {post.group && <ComparisonTabs group={post.group} activeId={post.id}/>}
    <header className="detail-heading">
      <div className="detail-category">{post.category}{post.isDemo && <span>Example content</span>}</div>
      <h1>{post.title}</h1><ShareLink/>{post.summary && <p>{post.summary}</p>}
    </header>
    <PostContent post={post}/>
  </article>;
}

function comparisonNames(post: PostSummary) {
  return { model:post.models.join(' / ') || post.title,provider:post.providers.join(' / ') };
}
function ComparisonTabs({ group,activeId,showCompare=true }: { group:ComparisonGroup;activeId?:string;showCompare?:boolean }) {
  return <nav className="comparison-tabs" aria-label={`Comparison posts: ${group.title}`}>
    {group.posts.map(post => {
      const names=comparisonNames(post);
      return <Link key={post.id} to={`/posts/${post.slug}`} aria-current={post.id===activeId ? 'page' : undefined}>
        {names.provider && <span className="comparison-tab-provider">{names.provider}</span>}
        <span className="comparison-tab-model">{names.model}</span>
        <span className="sr-only">{post.models.length ? `Post: ${post.title}` : ''}</span>
      </Link>;
    })}
    {showCompare && group.allowSideBySide && group.posts.length>1 && <Link className="group-compare-link" to={`/compare?groupId=${group.id}`}>Side by side</Link>}
  </nav>;
}

function PostContent({ post,compareLinks=true }: { post:Post;compareLinks?:boolean }) {
  const cover=post.coverId ? post.media[post.coverId] : null;
  return <>
    {post.isDemo && <p className="demo-note">This is a layout example, with no benchmark measurements.</p>}
    {cover && <ImageViewer image={cover} label={post.title} className="cover-image"/>}
    {post.showcaseMediaIds.length>0 && <section className="detail-section">
      <h2>Final showcase</h2>
      <MediaGallery items={post.showcaseMediaIds.filter(id => post.media[id]).map((id,index) => ({ image:post.media[id],label:`Final ${index+1}` }))}/>
    </section>}
    {post.body && <section className="detail-section"><h2>The result</h2><Paragraphs text={post.body}/></section>}
    <Prompt key={post.id} text={post.prompt} slug={post.slug}/>
    <References post={post}/>
    {post.runs.length>0 ? <section className="detail-section">
      <div className="section-heading">
        <h2>{post.runs.length===1 ? 'The run' : 'Runs'}</h2>
        {compareLinks && post.runs.length>1 && (!post.group || post.group.allowSideBySide) && <Link className="text-link" to={`/compare?postId=${post.id}`}>Compare these runs</Link>}
      </div>
      <div className="run-list">{post.runs.map(run => <article key={run.id} className="run-detail">
        <h3>{run.model}</h3>
        <dl className="run-facts">
          <div><dt>Elapsed time</dt><dd>{duration(run.elapsedSeconds)}</dd></div>
          <div><dt>Outcome</dt><dd>{run.outcome}</dd></div>
          {run.harness && <div><dt>Agent</dt><dd>{run.harness}</dd></div>}
          {run.author && <div><dt>Run by</dt><dd>{run.author}</dd></div>}
          <ExtraRunFacts run={run}/>
        </dl>
        {run.conditions && <div className="run-notes"><h4>Conditions</h4><Paragraphs text={run.conditions}/></div>}
        {run.notes && <Paragraphs text={run.notes}/>}
        <MediaGallery items={run.resultMediaIds.filter(id => post.media[id]).map((id,index) => ({ image:post.media[id],label:`${run.model} result ${index+1}` }))}/>
      </article>)}</div>
    </section> : !post.isDemo && <section className="detail-section"><h2>Run details</h2><p className="muted">No run metadata has been recorded.</p></section>}
    {post.progress.length>0 && <section className="detail-section">
      <h2>Progress</h2>
      <MediaGallery items={post.progress.filter(step => post.media[step.mediaId]).map(step => ({ image:post.media[step.mediaId],label:step.label,elapsedSeconds:step.elapsedSeconds }))}/>
    </section>}
  </>;
}

type ComparisonList={ runs:Comparison[];total:number;page:number;pages:number;group?:ComparisonGroup;posts?:Post[] };
export function Compare() {
  const [params]=useSearchParams();
  const groupId=params.get('groupId');
  return groupId ? <GroupComparison key={groupId} groupId={groupId}/> : <RunComparison/>;
}

function GroupComparison({ groupId }: { groupId:string }) {
  const resource=useResource<ComparisonList>(`/api/compare?${new URLSearchParams({ groupId })}`);
  const [selected,setSelected]=useState<string[]>([]);
  const group=resource.data?.group;
  const posts=resource.data?.posts || [];
  const selection=posts.filter(post => selected.includes(post.id));
  useEffect(() => { document.title=group ? `${group.title} | Agent Benchmarks` : 'Compare posts | Agent Benchmarks'; },[group]);
  function toggle(id:string) {
    setSelected(current => current.includes(id) ? current.filter(value => value!==id) : current.length<8 ? [...current,id] : current);
  }
  if (resource.loading) return <div className="page group-compare"><Loading detail/></div>;
  if (resource.error || !group) return <div className="page group-compare"><header className="compact-heading"><h1>Compare posts</h1></header><ErrorState message={resource.error || 'Comparison group not found.'} retry={resource.reload}/><Link to="/">Back to journal</Link></div>;
  if (!group.allowSideBySide) return <div className="page group-compare"><header className="compact-heading"><h1>{group.title}</h1></header><ComparisonTabs group={group} showCompare={false}/><p>Side-by-side comparison is disabled for this group.</p></div>;
  return <div className="page group-compare">
    <header className="compact-heading"><h1>{group.title}</h1></header>
    <ComparisonTabs group={group} showCompare={false}/>
    {posts.length ? <>
      <fieldset className="group-post-picker">
        <legend>Select up to eight posts</legend>
        {posts.map(post => {
          const summary=group.posts.find(item => item.id===post.id);
          const names=summary ? comparisonNames(summary) : { model:post.title,provider:'' };
          return <label className="group-post-choice" key={post.id}>
            <input type="checkbox" checked={selected.includes(post.id)} disabled={selected.length>=8&&!selected.includes(post.id)} onChange={() => toggle(post.id)} aria-label={`Compare ${names.model} on ${post.title}`}/>
            <span><strong>{names.model}</strong>{names.provider && <small>{names.provider}</small>}{post.title!==names.model && <small>{post.title}</small>}</span>
          </label>;
        })}
      </fieldset>
      {selection.length>0 && <section aria-label="Selected posts">
        <div className="comparison-selection-heading"><h2>Side by side</h2><button className="button secondary" onClick={() => setSelected([])}>Clear selection</button></div>
        <div className="post-comparison-grid">{selection.map(post => <article key={post.id} className="post-comparison-panel">
          <header className="post-comparison-heading"><h2>{post.title}</h2>{post.summary && <p>{post.summary}</p>}<Link to={`/posts/${post.slug}`}>Open post</Link></header>
          <PostContent post={post} compareLinks={false}/>
        </article>)}</div>
      </section>}
    </> : <EmptyState title="No published posts in this group." body="Published posts added to this comparison will appear here."><Link to="/">Back to journal</Link></EmptyState>}
  </div>;
}

function RunComparison() {
  const { params,change,clear } = useFilters();
  const resource = useResource<ComparisonList>(`/api/compare?${params}`);
  const catalog = useResource<Catalog>('/api/catalog');
  const [selected,setSelected] = useState<string[]>([]);
  useEffect(() => { document.title = 'Compare runs | Agent Benchmarks'; setSelected([]); },[params]);
  const selection = resource.data?.runs.filter(run => selected.includes(run.id)&&run.canCompare!==false) || [];
  function toggle(id: string) {
    if (resource.data?.runs.find(run => run.id===id)?.canCompare===false) return;
    setSelected(current => current.includes(id) ? current.filter(value => value!==id) : current.length<8 ? [...current,id] : current);
  }
  return <div className="page compare">
    <header className="compact-heading"><h1>Compare runs</h1></header>
    <div className="compare-filters">
      <label>Provider<select aria-label="Provider" value={params.get('provider') || ''} onChange={event => change('provider',event.target.value)}>
        <option value="">All providers</option>{catalog.data?.providers?.map(provider => <option key={provider}>{provider}</option>)}
      </select></label>
      <label>Model<select aria-label="Model" value={params.get('model') || ''} onChange={event => change('model',event.target.value)}>
        <option value="">All models</option>{catalog.data?.models.map(model => <option key={model}>{model}</option>)}
      </select></label>
      <label>Reasoning effort<select aria-label="Reasoning effort" value={params.get('reasoning') || ''} onChange={event => change('reasoning',event.target.value)}>
        <option value="">All reasoning efforts</option>{catalog.data?.reasoningEfforts?.map(reasoning => <option key={reasoning}>{reasoning}</option>)}
      </select></label>
      <label>Category<select aria-label="Category" value={params.get('category') || ''} onChange={event => change('category',event.target.value)}>
        <option value="">All categories</option>{catalog.data?.categories.map(category => <option key={category}>{category}</option>)}
      </select></label>
      <label>Outcome<select aria-label="Outcome" value={params.get('outcome') || ''} onChange={event => change('outcome',event.target.value)}>
        <option value="">All outcomes</option>{outcomes.map(outcome => <option key={outcome}>{outcome}</option>)}
      </select></label>
      {params.toString() && <button className="button secondary" onClick={clear}>Clear filters</button>}
    </div>
    {resource.loading ? <Loading/> : resource.error ? <ErrorState message={resource.error} retry={resource.reload}/> : !resource.data?.runs.length ? <EmptyState title="No runs to compare yet." body="Published posts with recorded model runs appear here."><Link to="/">Browse the journal</Link></EmptyState> : <>
      <p className="compare-hint">Select up to eight runs. Elapsed time is meaningful only when prompts, tools and conditions match.</p>
      {selection.length>0 && <section className="selected-comparison" aria-label="Selected runs">
        <div className="section-heading"><h2>Side by side</h2><button className="button secondary" onClick={() => setSelected([])}>Clear selection</button></div>
        {new Set(selection.map(run => run.postId)).size>1 && <p role="status">These runs use different posts. Check their original prompts before drawing conclusions.</p>}
        <div className="comparison-grid">{selection.map(run => <RunCard key={run.id} run={run}/>)}</div>
      </section>}
      <div className="compare-list">{resource.data.runs.map(run => <article key={run.id} className="compare-row">
        <label className="run-select"><input type="checkbox" checked={selected.includes(run.id)} disabled={run.canCompare===false || (selected.length>=8&&!selected.includes(run.id))} onChange={() => toggle(run.id)} aria-label={`Compare ${run.model} on ${run.postTitle}`}/></label>
        <Link className="compare-thumb" to={`/posts/${run.slug}`}>{(run.resultImages[0] || run.cover) && <img src={(run.resultImages[0] || run.cover)!.thumbnailUrl} alt={run.postTitle} loading="lazy"/>}</Link>
        <div className="compare-description">
          {providerLabel(run) && <span className="compare-provider">{providerLabel(run)}</span>}
          <h2>{run.model}</h2><Link to={`/posts/${run.slug}`}>{run.postTitle}</Link>
          {run.isDemo && <span className="example-label">Example</span>}
          {run.canCompare===false && <p className="compare-disabled-note">Side-by-side disabled for this group.</p>}
        </div>
        <div className="compare-time"><span>Elapsed time</span><strong>{duration(run.elapsedSeconds)}</strong></div>
        <span className="compare-outcome">{run.outcome}</span>
      </article>)}</div>
      <Pager page={resource.data.page} pages={resource.data.pages} onPage={page => change('page',String(page))}/>
    </>}
  </div>;
}
function RunCard({ run }: { run: Comparison }) {
  const image = run.resultImages[0] || run.cover;
  return <article className="comparison-card">{image && <img src={image.thumbnailUrl} alt={`${run.model} result`} loading="lazy"/>}<h3>{run.model}</h3><Link to={`/posts/${run.slug}`}>{run.postTitle}</Link><dl><ExtraRunFacts run={run}/><div><dt>Elapsed time</dt><dd>{duration(run.elapsedSeconds)}</dd></div><div><dt>Outcome</dt><dd>{run.outcome}</dd></div>{run.harness && <div><dt>Agent</dt><dd>{run.harness}</dd></div>}{run.author && <div><dt>Run by</dt><dd>{run.author}</dd></div>}</dl>{run.conditions && <Paragraphs text={run.conditions}/>}<Paragraphs text={run.notes}/></article>;
}
