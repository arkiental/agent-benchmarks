import type { Post } from '../shared/schema';
import { MediaGallery } from './components';

export function References({ post }: { post: Post }) {
  if (!post.references.length) return null;
  return <section className="detail-section references-section">
    <div className="section-heading">
      <h2>References</h2>
      <a className="button secondary reference-bundle" href={`/api/posts/${encodeURIComponent(post.slug)}/bundle`} download>Download prompt + references</a>
    </div>
    <ol className="reference-list">
      {post.references.map((reference,index) => {
        const media = reference.kind === 'media' ? post.media[reference.mediaId] : null;
        const label = reference.label || (reference.kind === 'link' ? reference.url : media?.name || `Reference ${index+1}`);
        return <li key={reference.kind === 'media' ? `${reference.mediaId}-${index}` : `${reference.url}-${index}`} className={`reference-item reference-${reference.kind}`}>
          <span className="reference-number" aria-hidden="true">{index+1}</span>
          {media ? <>
            <div className="reference-preview"><MediaGallery items={[{ image:media,label }]}/></div>
            <div className="reference-caption">
              <span>{label}</span>
              <a href={`/api/posts/${encodeURIComponent(post.slug)}/references/${index}/download`} download aria-label={`Download ${label}`}>Download</a>
            </div>
          </> : reference.kind === 'link' ? <div className="reference-link-content">
            <a href={reference.url} target="_blank" rel="noopener noreferrer">{label}</a>
            {reference.label && <span className="reference-url">{reference.url}</span>}
          </div> : <p className="muted">This reference file is unavailable.</p>}
        </li>;
      })}
    </ol>
  </section>;
}
