import { z } from 'zod';

export const categories = ['Design', 'Websites', 'Code', 'Research', 'Other'] as const;
export const outcomes = ['Completed', 'Partial', 'Failed'] as const;
export const providers = ['OpenAI', 'Google', 'Anthropic', 'Other'] as const;
export const idSchema = z.string().uuid();
export const referenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('media'), mediaId: idSchema, label: z.string().trim().max(160) }).strict(),
  z.object({ kind: z.literal('link'), url: z.string().trim().max(2048).url().refine(value => {
    const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  }, 'Use an HTTP(S) link without embedded credentials.'), label: z.string().trim().max(160) }).strict(),
]);
export const groupSchema = z.object({
  title: z.string().trim().min(1).max(160), allowSideBySide: z.boolean(),
  postIds: z.array(idSchema).max(20).refine(ids => new Set(ids).size === ids.length, 'Select each post once.'),
  revision: z.number().int().min(1).optional(),
}).strict();
const elapsed = z.number().int().min(0).max(31_536_000).nullable();
const imageIds = z.array(idSchema).max(12);
export const renderCollectionLimits = { maxCollections: 20, maxImages: 100, maxTotalImages: 500 } as const;
export const renderCollectionSchema = z.object({
  id: idSchema,
  title: z.string().trim().min(1).max(120),
  mediaIds: z.array(idSchema).max(renderCollectionLimits.maxImages).refine(ids => new Set(ids).size === ids.length, 'Select each collection image once.'),
}).strict();
export const postMetadataFields = ['provider', 'customProvider', 'model', 'reasoningEffort', 'tokens', 'elapsedSeconds', 'estimatedCostUsd'] as const;
export const postMetadataSchema = z.object({
  provider: z.enum(providers).nullable().optional().describe('Optional provider for the work in this post.'),
  customProvider: z.string().trim().max(80).optional().describe('Optional custom name when provider is Other.'),
  model: z.string().trim().max(120).optional().describe('Optional free-text model for this post; blank is valid.'),
  reasoningEffort: z.string().trim().max(80).optional().describe('Optional free-text reasoning setting; blank is valid.'),
  tokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional().describe('Optional recorded token count; null is unknown and zero is a recorded value.'),
  elapsedSeconds: elapsed.optional().describe('Optional recorded elapsed time in seconds; null is unknown and zero is a recorded value.'),
  estimatedCostUsd: z.number().min(0).max(1000000).nullable().optional().describe('Optional estimated cost in USD; null is unknown and zero is a recorded value.'),
}).strict();
export const runSchema = z.object({
  id: idSchema.optional(),
  model: z.string().trim().min(1).max(120),
  provider: z.enum(providers).nullable().optional(),
  customProvider: z.string().trim().max(80).optional(),
  harness: z.string().trim().max(120),
  author: z.string().trim().max(120),
  elapsedSeconds: elapsed,
  reasoningEffort: z.string().trim().max(80).optional(),
  tokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  estimatedCostUsd: z.number().min(0).max(1000000).nullable().optional(),
  outcome: z.enum(outcomes),
  notes: z.string().max(12000),
  conditions: z.string().max(6000),
  resultMediaIds: imageIds,
}).strict();
export const postSchema = z.object({
  title: z.string().trim().min(3).max(160),
  slug: z.string().min(3).max(180).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  summary: z.string().trim().max(320),
  ...postMetadataSchema.shape,
  category: z.enum(categories),
  prompt: z.string().min(1).max(100000),
  body: z.string().max(30000),
  status: z.enum(['draft', 'published']),
  isDemo: z.boolean(),
  coverId: idSchema.nullable(),
  showcaseMediaIds: z.array(idSchema).max(50).optional(),
  collections: z.array(renderCollectionSchema).max(renderCollectionLimits.maxCollections).optional(),
  references: z.array(referenceSchema).max(50).optional(),
  groupId: idSchema.nullable().optional(),
  runs: z.array(runSchema).max(20),
  progress: z.array(z.object({
    mediaId: idSchema,
    label: z.string().trim().min(1).max(160),
    elapsedSeconds: elapsed,
  }).strict()).max(50),
  revision: z.number().int().min(1).optional(),
}).strict().superRefine((post, ctx) => {
  if (post.status === 'published' && !post.coverId) {
    ctx.addIssue({ code: 'custom', path: ['coverId'], message: 'Choose a cover before publishing.' });
  }
  const ids = post.runs.flatMap(run => run.id ? [run.id] : []);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['runs'], message: 'Run IDs must be unique.' });
  const showcase = post.showcaseMediaIds || [];
  if (new Set(showcase).size !== showcase.length) ctx.addIssue({ code: 'custom', path: ['showcaseMediaIds'], message: 'Final showcase items must be unique.' });
  const collections = post.collections || [];
  if (new Set(collections.map(collection => collection.id)).size !== collections.length) ctx.addIssue({ code: 'custom', path: ['collections'], message: 'Collection IDs must be unique.' });
  if (collections.reduce((total, collection) => total + collection.mediaIds.length, 0) > renderCollectionLimits.maxTotalImages) ctx.addIssue({ code: 'custom', path: ['collections'], message: 'Use at most 500 images across the collections.' });
  post.runs.forEach((run, index) => {
    if (run.provider === 'Other' && !run.customProvider?.trim()) ctx.addIssue({ code: 'custom', path: ['runs', index, 'customProvider'], message: 'Enter the provider name.' });
    if (run.provider !== 'Other' && run.customProvider?.trim()) ctx.addIssue({ code: 'custom', path: ['runs', index, 'customProvider'], message: 'Choose Other for a custom provider.' });
  });
});
export type PostMetadata = z.infer<typeof postMetadataSchema>;
export type PostInput = z.infer<typeof postSchema>;
export type RunInput = z.infer<typeof runSchema>;
export type Reference = z.infer<typeof referenceSchema>;
export type RenderCollection = z.infer<typeof renderCollectionSchema>;
export type GroupInput = z.infer<typeof groupSchema>;
export type Media = { id: string; name: string; kind: 'image' | 'video'; durationSeconds: number | null; width: number; height: number; bytes: number; url: string; thumbnailUrl: string; createdAt: string };
export type Run = Omit<RunInput, 'id'> & { id: string };
export type Post = Omit<PostInput, 'revision' | 'runs' | 'showcaseMediaIds' | 'collections' | 'references' | 'groupId'> & { id: string; revision: number; runs: Run[]; showcaseMediaIds: string[]; collections: RenderCollection[]; references: Reference[]; groupId: string | null; group: ComparisonGroup | null; createdAt: string; updatedAt: string; publishedAt: string | null; media: Record<string, Media> };
export type PostSummary = Pick<Post, 'id' | 'title' | 'slug' | 'summary' | 'category' | 'status' | 'isDemo' | 'coverId' | 'publishedAt' | 'updatedAt' | 'revision' | 'groupId' | keyof PostMetadata> & { cover: Media | null; models: string[]; providers: string[]; reasoningEfforts: string[]; runCount: number };
export type ComparisonGroup = { id: string; title: string; allowSideBySide: boolean; revision: number; posts: PostSummary[] };
export type Comparison = Run & { postId: string; postTitle: string; slug: string; category: string; isDemo: boolean; cover: Media | null; resultImages: Media[]; groupId: string | null; canCompare: boolean };

export function providerLabel(run: Pick<RunInput, 'provider' | 'customProvider'>): string {
  return run.provider === 'Other' ? run.customProvider || 'Other' : run.provider || '';
}

export function postMetadata(post: PostMetadata & { runs?: RunInput[] }): PostMetadata {
  const source: PostMetadata = postMetadataFields.some(key => post[key] !== undefined) ? post : post.runs?.[0] || {};
  return Object.fromEntries(postMetadataFields.flatMap(key => source[key] === undefined ? [] : [[key, source[key]]])) as PostMetadata;
}

export function duration(seconds: number | null): string {
  if (seconds === null) return 'Not recorded';
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', remainder ? `${remainder}s` : ''].filter(Boolean).join(' ');
}

export function slugify(title: string): string {
  return title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 180);
}
