import { z } from 'zod';

export const categories = ['Design', 'Websites', 'Code', 'Research', 'Other'] as const;
export const outcomes = ['Completed', 'Partial', 'Failed'] as const;
export const idSchema = z.string().uuid();
const elapsed = z.number().int().min(0).max(31_536_000).nullable();
const imageIds = z.array(idSchema).max(12);
export const runSchema = z.object({
  id: idSchema.optional(),
  model: z.string().trim().min(1).max(120),
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
  category: z.enum(categories),
  prompt: z.string().min(1).max(100000),
  body: z.string().max(30000),
  status: z.enum(['draft', 'published']),
  isDemo: z.boolean(),
  coverId: idSchema.nullable(),
  showcaseMediaIds: z.array(idSchema).max(50).optional(),
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
});
export type PostInput = z.infer<typeof postSchema>;
export type RunInput = z.infer<typeof runSchema>;
export type Media = { id: string; name: string; kind: 'image' | 'video'; durationSeconds: number | null; width: number; height: number; bytes: number; url: string; thumbnailUrl: string; createdAt: string };
export type Run = Omit<RunInput, 'id'> & { id: string };
export type Post = Omit<PostInput, 'revision' | 'runs' | 'showcaseMediaIds'> & { id: string; revision: number; runs: Run[]; showcaseMediaIds: string[]; createdAt: string; updatedAt: string; publishedAt: string | null; media: Record<string, Media> };
export type PostSummary = Pick<Post, 'id' | 'title' | 'slug' | 'summary' | 'category' | 'status' | 'isDemo' | 'coverId' | 'publishedAt' | 'updatedAt' | 'revision'> & { cover: Media | null; models: string[]; runCount: number };
export type Comparison = Run & { postId: string; postTitle: string; slug: string; category: string; isDemo: boolean; cover: Media | null; resultImages: Media[] };

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
