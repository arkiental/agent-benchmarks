import { useEffect,useId,useState } from 'react';
import { IconCopy,IconCheck,IconLink } from '@tabler/icons-react';
import type { Run } from '../shared/schema';

export function ShareLink() {
  const [copied,setCopied]=useState(false),[fallback,setFallback]=useState('');
  async function share() {
    const url=window.location.origin+window.location.pathname;
    try { await navigator.clipboard.writeText(url); setCopied(true); }
    catch { setFallback(url); }
  }
  return <div className="share-control"><button className="text-button" onClick={share}><IconLink size={18}/>{copied ? 'Link copied' : 'Copy link'}</button>{fallback && <label>Post link<input readOnly value={fallback} onFocus={event => event.target.select()}/></label>}</div>;
}
export function Prompt({ text,slug }: { text:string;slug:string }) {
  const id=useId(),long=text.length>800;
  const [expanded,setExpanded]=useState(false),[copied,setCopied]=useState(false),[error,setError]=useState(''),[download,setDownload]=useState('');
  useEffect(() => { if (!long) return; const url=URL.createObjectURL(new Blob([text],{ type:'text/plain;charset=utf-8' })); setDownload(url); return () => URL.revokeObjectURL(url); },[text,long]);
  async function copy() { try { await navigator.clipboard.writeText(text); setCopied(true); setError(''); } catch { setExpanded(true); setError('Select and copy the prompt below.'); } }
  return <section className="detail-section prompt-section"><div className="section-heading"><h2>Original prompt</h2><button className="button secondary" onClick={copy}>{copied ? <IconCheck size={20}/> : <IconCopy size={20}/>}{copied ? 'Copied' : 'Copy prompt'}</button></div>{error && <p role="status">{error}</p>}<pre className="prompt-text" id={id}>{long&&!expanded ? `${text.slice(0,800)}…` : text}</pre>{long && <div className="prompt-actions"><button className="text-button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>{expanded ? 'Collapse prompt' : 'Show full prompt'}</button>{download && <a href={download} download={`${slug}-prompt.txt`}>Download prompt</a>}</div>}</section>;
}
export function ExtraRunFacts({ run }: { run:Run }) {
  return <>{run.reasoningEffort && <div><dt>Reasoning effort</dt><dd>{run.reasoningEffort}</dd></div>}{run.tokens!=null && <div><dt>Tokens</dt><dd>{run.tokens.toLocaleString()}</dd></div>}{run.estimatedCostUsd!=null && <div><dt>Estimated cost</dt><dd>${run.estimatedCostUsd.toLocaleString('en-US',{ minimumFractionDigits:2,maximumFractionDigits:4 })}</dd></div>}</>;
}
