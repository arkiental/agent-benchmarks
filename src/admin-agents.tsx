import { useState } from 'react';
import { api, useResource } from './api';
import { EmptyState, ErrorState, Loading } from './components';

type AgentToken = { id:string; name:string; scopes:string[]; createdAt:string; expiresAt:string; revokedAt:string | null; lastUsedAt:string | null };
const scopeOptions=[
  {value:'posts:read',label:'Read posts'},
  {value:'posts:write',label:'Create and edit drafts'},
  {value:'media:write',label:'Upload media'},
  {value:'groups:write',label:'Manage comparison groups'},
  {value:'publish',label:'Publish posts'},
];
const defaultScopes=['posts:read','posts:write','media:write'];

export function AdminAgents(){
  const resource=useResource<{tokens:AgentToken[]}>('/api/admin/agent-tokens');
  const [name,setName]=useState(''),[days,setDays]=useState(7),[scopes,setScopes]=useState(defaultScopes);
  const [pending,setPending]=useState(false),[revoking,setRevoking]=useState<string | null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [secret,setSecret]=useState(''),[secretName,setSecretName]=useState(''),[copied,setCopied]=useState(false),[copyError,setCopyError]=useState('');
  async function create(event:React.FormEvent){
    event.preventDefault();setPending(true);setError('');setNotice('');
    try{
      const result=await api<{token:AgentToken;secret:string}>('/api/admin/agent-tokens',{method:'POST',body:JSON.stringify({name,scopes,expiresInDays:days})});
      setSecret(result.secret);setSecretName(result.token.name);setCopied(false);setCopyError('');setName('');resource.reload();
    }catch(error){setError((error as Error).message);}
    finally{setPending(false);}
  }
  async function copy(){
    try{await navigator.clipboard.writeText(secret);setCopied(true);setCopyError('');}
    catch{setCopied(false);setCopyError('Select the token below and copy it manually.');}
  }
  async function revoke(token:AgentToken){
    if(!window.confirm(`Revoke ${token.name}? The agent will lose access immediately.`))return;
    setRevoking(token.id);setError('');setNotice('');
    try{await api(`/api/admin/agent-tokens/${token.id}`,{method:'DELETE'});resource.reload();setNotice(`${token.name} revoked.`);if(secretName===token.name){setSecret('');setSecretName('');}}
    catch(error){setError((error as Error).message);}
    finally{setRevoking(null);}
  }
  return <>
    <header className="compact-heading"><h1>Agent tokens</h1></header>
    <div className="agent-owner-layout">
      <form className="editor-form" onSubmit={create}>
        <fieldset className="editor-fields" disabled={pending || Boolean(secret)}>
          <section className="editor-section">
            <h2>Create token</h2>
            <p className="helper">Create access for an agent you choose. Publishing requires its own permission.</p>
            <div className="form-columns">
              <label>Token name<input value={name} required minLength={1} maxLength={80} autoComplete="off" onChange={event=>setName(event.target.value)}/></label>
              <label>Expires after (days)<input type="number" min={1} max={90} step={1} required value={days} onChange={event=>setDays(Number(event.target.value))}/></label>
            </div>
            <fieldset className="agent-scope-options"><legend>Permissions</legend>{scopeOptions.map(scope=><label className="checkbox-label" key={scope.value}><input type="checkbox" checked={scopes.includes(scope.value)} onChange={event=>setScopes(current=>event.target.checked?[...current,scope.value]:current.filter(value=>value!==scope.value))}/>{scope.label}</label>)}</fieldset>
            <button className="button agent-create-button" type="submit" disabled={pending || !scopes.length}>{pending?'Creating...':'Create token'}</button>
          </section>
        </fieldset>
      </form>
      {secret && <section className="agent-secret" aria-label="New token" aria-live="polite">
        <h2>{secretName}</h2>
        <p>Copy this token now. After you dismiss it, it cannot be shown again.</p>
        <label>New agent token<textarea aria-label="New agent token" value={secret} readOnly autoComplete="off" spellCheck={false} rows={3} onFocus={event=>event.currentTarget.select()}/></label>
        <div className="row-actions"><button className="button" type="button" onClick={()=>void copy()}>{copied?'Copied':'Copy token'}</button><button className="button secondary" type="button" onClick={()=>{setSecret('');setSecretName('');setCopied(false);setCopyError('');}}>Dismiss token</button></div>
        {copyError && <p role="status">{copyError}</p>}
      </section>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <section className="agent-existing-tokens" aria-labelledby="existing-tokens-heading">
        <h2 id="existing-tokens-heading">Existing tokens</h2>
        {resource.loading?<Loading/>:resource.error?<ErrorState message={resource.error} retry={resource.reload}/>:resource.data?.tokens.length?<div className="agent-token-list">{resource.data.tokens.map(token=>{
          const expired=Date.parse(token.expiresAt)<=Date.now();
          return <article className="agent-token" key={token.id}>
            <div><h3>{token.name}</h3><p>{token.revokedAt?'Revoked':expired?'Expired':'Active'} / Expires {date(token.expiresAt)}</p><p>{token.scopes.map(scope=>scopeOptions.find(option=>option.value===scope)?.label || scope).join(', ')}</p><p className="helper">Created {date(token.createdAt)}{token.lastUsedAt?` / Last used ${date(token.lastUsedAt)}`:' / Never used'}</p></div>
            {!token.revokedAt && !expired && <button className="button secondary" type="button" aria-label={`Revoke ${token.name}`} disabled={Boolean(revoking)} onClick={()=>void revoke(token)}>{revoking===token.id?'Revoking...':'Revoke'}</button>}
          </article>;
        })}</div>:<EmptyState title="No agent tokens." body="Create a token only when you want an agent to author posts."/>}
      </section>
    </div>
  </>;
}

function date(value:string){
  const parsed=new Date(value);return Number.isNaN(parsed.getTime())?'Unknown':parsed.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
}
