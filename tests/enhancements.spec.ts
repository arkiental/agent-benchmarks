import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { fromBuffer } from 'yauzl';
import type { ComparisonGroup, Media, Post, PostInput } from '../shared/schema';
import { fixtureVideo } from './fixtures.js';

const password = 'isolated-browser-test-passphrase';
const providers = ['OpenAI', 'Google', 'Anthropic', 'Other'] as const;
const providerNames = ['OpenAI', 'Google', 'Anthropic', 'Local fixture provider'];
const models = ['Fixture alpha / v2.7', 'Fixture beta experimental', 'Fixture gamma preview', 'My freely named model'];
const reasoning = ['Verify twice before answering', 'Adaptive with tools', 'Detailed / custom effort', 'Owner supplied reasoning'];
const externalUrl = 'https://example.invalid/reference?source=fixture#detail';

async function signIn(page: Page) {
  await page.goto('/admin');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your posts.' })).toBeVisible();
  const session = await (await page.request.get('/api/admin/session')).json() as { csrf: string };
  return { Origin: new URL(page.url()).origin, 'X-CSRF-Token': session.csrf };
}

function fixturePost(index: number, cover: Media, video: Media, draft = false): PostInput {
  return {
    title: draft ? 'Hidden group fixture' : `Reference fixture ${index + 1}`,
    slug: draft ? 'hidden-group-fixture' : `reference-fixture-${index + 1}`,
    summary: `Search marker ${index + 1}`, category: 'Research',
    prompt: `PROMPT_FOR_${providerNames[index]}\n` + `Keep the ${models[index]} input exact.\n`.repeat(40),
    body: `Result marker ${providerNames[index]}`, status: draft ? 'draft' : 'published',
    isDemo: true, coverId: cover.id, showcaseMediaIds: [cover.id], groupId: null,
    references: index === 0 ? [
      { kind: 'media', mediaId: cover.id, label: 'Reference still' },
      { kind: 'link', url: externalUrl, label: 'External reference' },
      { kind: 'media', mediaId: video.id, label: 'Reference timelapse' },
    ] : [{ kind: 'link', url: `${externalUrl}-${index}`, label: `${providerNames[index]} reference` }],
    runs: [{
      provider: providers[index], customProvider: index === 3 ? providerNames[index] : '', model: models[index],
      reasoningEffort: reasoning[index], harness: 'Isolated browser fixture', author: '', elapsedSeconds: (index + 1) * 60,
      tokens: 1000 + index, estimatedCostUsd: (index + 1) / 100, outcome: 'Completed', notes: '', conditions: '', resultMediaIds: [],
    }],
    progress: [{ mediaId: cover.id, label: `Progress marker ${providerNames[index]}`, elapsedSeconds: 1 }],
  };
}

async function archiveEntries(bytes: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
    if (error || !zip) return reject(error || new Error('Missing ZIP archive.'));
    const entries = new Map<string, Buffer>();
    zip.on('error', reject);
    zip.on('end', () => resolve(entries));
    zip.on('entry', entry => zip.openReadStream(entry, (streamError, stream) => {
      if (streamError || !stream) return reject(streamError || new Error('Missing ZIP entry.'));
      const chunks: Buffer[] = [];
      stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
      stream.on('error', reject);
      stream.on('end', () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
    }));
    zip.readEntry();
  }));
}

async function cleanup(request: APIRequestContext, headers: Record<string, string>, posts: string[], media: string[], groupId?: string) {
  if (groupId) {
    const response = await request.get('/api/admin/groups');
    if (response.ok()) {
      const groups = (await response.json()).groups as ComparisonGroup[];
      const group = groups.find(item => item.id === groupId);
      if (group) expect((await request.delete(`/api/admin/groups/${groupId}`, { headers, data: { revision: group.revision } })).status()).toBe(204);
    }
  }
  for (const id of posts) {
    const response = await request.get(`/api/admin/posts/${id}`);
    if (response.ok()) {
      const post = await response.json() as Post;
      expect((await request.delete(`/api/admin/posts/${id}`, { headers, data: { revision: post.revision } })).status()).toBe(204);
    }
  }
  for (const id of media) expect((await request.delete(`/api/admin/media/${id}`, { headers })).status()).toBe(204);
}

test('owner groups complete posts; visitors switch, download, compare four providers and filter live', async ({ page, context, request }) => {
  const headers = await signIn(page);
  const assetsRoot = path.resolve('.local');
  await fs.mkdir(assetsRoot, { recursive: true });
  const assetDir = await fs.mkdtemp(path.join(assetsRoot, 'enhancement-browser-'));
  const postIds: string[] = [], mediaIds: string[] = [];
  let groupId: string | undefined;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const videoFile = await fixtureVideo(assetDir);
    const videoResponse = await page.request.post('/api/admin/media', { headers, multipart: { image: { name: 'reference-timelapse.mp4', mimeType: 'video/mp4', buffer: await fs.readFile(videoFile) } } });
    expect(videoResponse.status()).toBe(201);
    const video = await videoResponse.json() as Media;
    mediaIds.push(video.id);
    const posts: Post[] = [];
    for (let index = 0; index < 4; index++) {
      const buffer = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 60 + index * 40, g: 60 + index * 40, b: 60 + index * 40 } } }).png().toBuffer();
      const imageResponse = await page.request.post('/api/admin/media', { headers, multipart: { image: { name: `reference-cover-${index + 1}.png`, mimeType: 'image/png', buffer } } });
      expect(imageResponse.status()).toBe(201);
      const image = await imageResponse.json() as Media;
      mediaIds.push(image.id);
      const response = await page.request.post('/api/admin/posts', { headers, data: fixturePost(index, image, video) });
      expect(response.status()).toBe(201);
      const post = await response.json() as Post;
      posts.push(post); postIds.push(post.id);
    }
    const draftResponse = await page.request.post('/api/admin/posts', { headers, data: fixturePost(0, posts[0].media[posts[0].coverId!], video, true) });
    expect(draftResponse.status()).toBe(201);
    const draft = await draftResponse.json() as Post;
    postIds.push(draft.id);

    await page.getByRole('link', { name: 'Groups', exact: true }).click();
    await page.getByRole('button', { name: 'New group', exact: true }).click();
    await page.getByLabel('Group title', { exact: true }).fill('Four provider browser fixture');
    await page.getByLabel('Enable side-by-side comparison', { exact: true }).check();
    for (const post of [...posts, draft]) await page.getByRole('checkbox', { name: new RegExp(post.title) }).check();
    const groupSaved = page.waitForResponse(response => response.url().endsWith('/api/admin/groups') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save group', exact: true }).click();
    const savedResponse = await groupSaved;
    expect(savedResponse.status()).toBe(201);
    groupId = (await savedResponse.json() as ComparisonGroup).id;
    await expect(page.getByRole('status').filter({ hasText: 'Group created.' })).toBeVisible();

    const publicPage = await context.newPage();
    publicPage.on('pageerror', error => errors.push(error.message));
    await publicPage.goto(`/posts/${posts[0].slug}`);
    const tabs = publicPage.getByRole('navigation', { name: 'Comparison posts: Four provider browser fixture', exact: true });
    await expect(tabs.getByRole('link')).toHaveCount(5);
    await expect(tabs).not.toContainText(draft.title);
    const publicPost = await (await request.get(`/api/posts/${posts[0].slug}`)).json() as Post;
    expect(publicPost.group?.posts).toHaveLength(4);
    expect((await request.get(`/api/posts/${draft.slug}`)).status()).toBe(404);
    expect((await request.get(`/posts/${draft.slug}`)).status()).toBe(404);
    expect((await request.get(`/api/posts/${draft.slug}/bundle`)).status()).toBe(404);

    await expect(publicPage.locator('.prompt-text')).toHaveText(posts[0].prompt.slice(0, 800) + '\u2026');
    expect(await publicPage.locator('.prompt-section').evaluate(element => element.nextElementSibling?.classList.contains('references-section'))).toBe(true);
    const references = publicPage.locator('.references-section');
    await expect(references.locator('.reference-item')).toHaveCount(3);
    await expect(references.locator('.reference-item').nth(1).getByRole('link', { name: 'External reference', exact: true })).toHaveAttribute('href', externalUrl);
    const individualPromise = publicPage.waitForEvent('download');
    await references.getByRole('link', { name: 'Download Reference still', exact: true }).click();
    const individual = await individualPromise;
    expect(individual.suggestedFilename()).toMatch(/\.webp$/);
    const individualBytes = await fs.readFile((await individual.path())!);
    const bundlePromise = publicPage.waitForEvent('download');
    await references.getByRole('link', { name: 'Download prompt + references', exact: true }).click();
    const bundle = await bundlePromise;
    expect(bundle.suggestedFilename()).toBe(`${posts[0].slug}-prompt-references.zip`);
    const entries = await archiveEntries(await fs.readFile((await bundle.path())!));
    expect(entries.get('prompt.txt')?.toString('utf8')).toBe(posts[0].prompt);
    const manifest = JSON.parse(entries.get('references.json')!.toString('utf8'));
    expect(manifest.externalLinksFetched).toBe(false);
    expect(manifest.references.map((item: { position: number }) => item.position)).toEqual([1, 2, 3]);
    expect(manifest.references[1].url).toBe(externalUrl);
    expect(entries.get(manifest.references[0].file)?.equals(individualBytes)).toBe(true);
    expect(manifest.references[2].file).toMatch(/^references\/03-.*\.mp4$/);
    expect(entries.get(manifest.references[2].file)?.length).toBeGreaterThan(0);
    expect(entries.size).toBe(4);
    await references.getByRole('button', { name: 'View Reference timelapse', exact: true }).click();
    const dialog = publicPage.getByRole('dialog', { name: 'Media viewer' });
    await expect(dialog.locator('video')).toHaveAttribute('controls', '');
    await dialog.locator('video').evaluate((video: HTMLVideoElement) => video.play());
    await expect.poll(() => dialog.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0);
    await publicPage.keyboard.press('Escape');

    await publicPage.getByRole('button', { name: 'Show full prompt', exact: true }).click();
    await expect(publicPage.locator('.prompt-text')).toHaveText(posts[0].prompt);
    await tabs.getByRole('link', { name: new RegExp(models[1]) }).click();
    await expect(publicPage).toHaveURL(new RegExp(`/posts/${posts[1].slug}$`));
    await expect(publicPage.getByRole('heading', { name: posts[1].title, exact: true })).toBeVisible();
    await expect(publicPage.locator('.prompt-text')).toHaveText(posts[1].prompt.slice(0, 800) + '\u2026');
    await expect(publicPage.locator('.cover-image img')).toHaveAttribute('src', `/media/${posts[1].coverId}`);
    await expect(publicPage.locator('.run-detail')).toContainText(providerNames[1]);
    await expect(publicPage.locator('.run-detail')).toContainText(reasoning[1]);
    await expect(publicPage.locator('.run-detail')).toContainText('2m');
    await expect(publicPage.locator('.references-section')).toContainText(`${providerNames[1]} reference`);
    await expect(publicPage.locator('.references-section .reference-item')).toHaveCount(1);
    await expect(publicPage.locator('.prose')).toContainText(`Result marker ${providerNames[1]}`);
    await expect(publicPage.getByRole('button', { name: `View Progress marker ${providerNames[1]}`, exact: true })).toBeVisible();
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await publicPage.getByRole('button', { name: 'Copy link', exact: true }).click();
    expect(await publicPage.evaluate(() => navigator.clipboard.readText())).toBe(publicPage.url());
    await publicPage.goBack();
    await expect(publicPage).toHaveURL(new RegExp(`/posts/${posts[0].slug}$`));
    await expect(publicPage.locator('.prompt-text')).toHaveText(posts[0].prompt.slice(0, 800) + '\u2026');
    await fs.mkdir('output', { recursive: true });
    await publicPage.screenshot({ path: 'output/references-fixture-desktop.png', fullPage: true });
    await expect(publicPage.getByRole('button', { name: 'Copy link', exact: true })).toBeVisible();

    await publicPage.getByRole('link', { name: 'Side by side', exact: true }).click();
    for (let index = 0; index < posts.length; index++) await publicPage.getByRole('checkbox', { name: `Compare ${models[index]} on ${posts[index].title}`, exact: true }).check();
    await expect(publicPage.locator('.post-comparison-panel')).toHaveCount(4);
    for (let index = 0; index < posts.length; index++) {
      const panel = publicPage.locator('.post-comparison-panel').nth(index);
      await expect(panel).toContainText(providerNames[index]);
      await expect(panel.locator('.prompt-text')).toHaveText(posts[index].prompt.slice(0, 800) + '\u2026');
      await expect(panel.getByRole('heading', { name: 'Final showcase', exact: true })).toBeVisible();
      await expect(panel.getByRole('heading', { name: 'Progress', exact: true })).toBeVisible();
    }
    await publicPage.screenshot({ path: 'output/group-fixture-desktop.png', fullPage: true });
    for (const width of [320, 390]) {
      await publicPage.setViewportSize({ width, height: 844 });
      expect(await publicPage.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    }
    await publicPage.screenshot({ path: 'output/group-fixture-mobile.png', fullPage: true });

    await page.getByRole('button', { name: 'Edit Four provider browser fixture', exact: true }).click();
    await page.getByLabel('Enable side-by-side comparison', { exact: true }).uncheck();
    await page.getByRole('button', { name: 'Save group', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Group saved.' })).toBeVisible();
    expect((await request.get(`/api/compare?groupId=${groupId}`)).status()).toBe(403);
    await publicPage.goto(`/posts/${posts[0].slug}`);
    await expect(publicPage.getByRole('navigation', { name: 'Comparison posts: Four provider browser fixture', exact: true }).getByRole('link')).toHaveCount(4);
    await expect(publicPage.getByRole('link', { name: 'Side by side', exact: true })).toHaveCount(0);

    await publicPage.goto('/');
    await publicPage.getByLabel('Search posts', { exact: true }).fill('Search marker 1');
    await expect(publicPage.locator('.post-card')).toHaveCount(1);
    await publicPage.getByLabel('Search posts', { exact: true }).fill('');
    await expect(publicPage.locator('.post-card')).toHaveCount(4);
    await publicPage.getByLabel('Provider', { exact: true }).selectOption(providerNames[0]);
    await publicPage.getByLabel('Model', { exact: true }).selectOption(models[0]);
    await publicPage.getByLabel('Reasoning effort', { exact: true }).selectOption(reasoning[0]);
    await expect(publicPage.locator('.post-card')).toHaveCount(1);
    await expect(publicPage.locator('.post-card')).toContainText(providerNames[0]);
    await expect(publicPage.locator('.post-card')).toContainText(models[0]);
    await expect(publicPage.locator('.post-card')).toContainText(reasoning[0]);
    await publicPage.getByLabel('Provider', { exact: true }).selectOption(providerNames[1]);
    await expect(publicPage.getByRole('heading', { name: 'No matching work.' })).toBeVisible();
    await publicPage.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await expect(publicPage.locator('.post-card')).toHaveCount(4);
    await expect(publicPage.getByLabel('Search posts', { exact: true })).toHaveValue('');
    await publicPage.goBack();
    await expect(publicPage.getByLabel('Provider', { exact: true })).toHaveValue(providerNames[1]);
    await expect(publicPage.getByRole('heading', { name: 'No matching work.' })).toBeVisible();
    await publicPage.goBack();
    await expect(publicPage.locator('.post-card')).toHaveCount(1);
    expect(errors).toEqual([]);
    await publicPage.close();
  } finally {
    try { await cleanup(page.request, headers, postIds, mediaIds, groupId); }
    finally {
      if (path.dirname(assetDir) !== assetsRoot || !path.basename(assetDir).startsWith('enhancement-browser-')) throw new Error('Unsafe fixture cleanup path.');
      await fs.rm(assetDir, { recursive: true, force: true });
    }
  }
});

test('owner creates a scoped fixture token, dismisses its secret and revokes access', async ({ page }) => {
  const headers = await signIn(page);
  const tokenName = 'Isolated browser agent';
  let tokenId: string | undefined;
  try {
    await page.getByRole('link', { name: 'Agent tokens', exact: true }).click();
    await page.getByLabel('Token name', { exact: true }).fill(tokenName);
    await page.getByLabel('Expires after (days)', { exact: true }).fill('7');
    for (const name of ['Read posts', 'Create and edit drafts', 'Upload media']) await page.getByRole('checkbox', { name, exact: true }).check();
    for (const name of ['Manage comparison groups', 'Publish posts']) await page.getByRole('checkbox', { name, exact: true }).uncheck();
    const createdPromise = page.waitForResponse(response => response.url().endsWith('/api/admin/agent-tokens') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create token', exact: true }).click();
    const created = await createdPromise;
    expect(created.status()).toBe(201);
    tokenId = (await created.json() as { token: { id: string } }).token.id;
    const secret = page.getByRole('textbox', { name: 'New agent token', exact: true });
    await expect(secret).toBeVisible();
    expect(await secret.inputValue().then(value => /^abt_[a-f0-9]{64}$/.test(value))).toBe(true);
    await page.getByRole('button', { name: 'Dismiss token', exact: true }).click();
    await expect(secret).toHaveCount(0);
    await page.reload();
    await expect(secret).toHaveCount(0);
    const list = await (await page.request.get('/api/admin/agent-tokens')).json() as { tokens: { id: string; scopes: string[]; revokedAt: string | null }[] };
    const record = list.tokens.find(item => item.id === tokenId)!;
    expect(record.scopes.sort()).toEqual(['media:write', 'posts:read', 'posts:write']);
    expect(record.revokedAt).toBeNull();
    expect(Object.keys(record)).not.toContain('secret');
    expect(Object.keys(record)).not.toContain('tokenHash');
    page.once('dialog', dialog => void dialog.accept());
    await page.getByRole('button', { name: `Revoke ${tokenName}`, exact: true }).click();
    await expect(page.getByRole('button', { name: `Revoke ${tokenName}`, exact: true })).toHaveCount(0);
    const revoked = await (await page.request.get('/api/admin/agent-tokens')).json() as { tokens: { id: string; revokedAt: string | null }[] };
    expect(revoked.tokens.find(item => item.id === tokenId)?.revokedAt).toBeTruthy();
  } finally {
    if (tokenId) expect((await page.request.delete(`/api/admin/agent-tokens/${tokenId}`, { headers })).status()).toBe(204);
  }
});
