import type { Config } from './config.js';
import type { Post } from '../shared/schema.js';
import { duration, providerLabel } from '../shared/schema.js';

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]!));
export function shareDescription(post: Post) {
  const runs = post.runs.slice(0,3).map(run => [
    [providerLabel(run), run.model].filter(Boolean).join(' / '), run.reasoningEffort ? `Reasoning: ${run.reasoningEffort}` : '',
    run.elapsedSeconds !== null ? duration(run.elapsedSeconds) : '',
    run.tokens != null ? `${run.tokens.toLocaleString('en-US')} tokens` : '',
    run.estimatedCostUsd != null ? `Estimated $${run.estimatedCostUsd.toFixed(4).replace(/0+$/,'').replace(/\.$/,'')}` : '',
  ].filter(Boolean).join(' · '));
  return [post.isDemo ? 'Example content' : '',...runs,post.summary].filter(Boolean).join(' / ').replace(/[\s\u0000-\u001f]+/g,' ').slice(0,300);
}
export function pageHtml(template: string, config: Config, post?: Post) {
  const title = post ? `${post.title} | ${config.siteName}` : config.siteName;
  const description = post ? shareDescription(post) : '';
  let html = template.replace(/<title>.*?<\/title>/s,`<title>${escape(title)}</title>`).replace(/\s*<meta name="description"[^>]*>/g,'');
  if (!post) return html;
  const url = new URL(`/posts/${post.slug}`,config.publicUrl).href;
  const cover = post.coverId ? post.media[post.coverId] : undefined;
  const tags = [
    `<link rel="canonical" href="${escape(url)}">`,
    `<meta name="description" content="${escape(description)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:site_name" content="${escape(config.siteName)}">`,
    `<meta property="og:title" content="${escape(post.title)}">`,
    `<meta property="og:description" content="${escape(description)}">`,
    `<meta property="og:url" content="${escape(url)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escape(post.title)}">`,
    `<meta name="twitter:description" content="${escape(description)}">`,
  ];
  if (cover?.kind === 'image') {
    const image = escape(new URL(cover.url,config.publicUrl).href);
    tags.push(`<meta property="og:image" content="${image}">`,`<meta property="og:image:type" content="image/webp">`,`<meta property="og:image:width" content="${cover.width}">`,`<meta property="og:image:height" content="${cover.height}">`,`<meta property="og:image:alt" content="${escape(post.title)}">`,`<meta name="twitter:image" content="${image}">`);
  }
  return html.replace('</head>',`${tags.join('\n')}\n</head>`);
}
