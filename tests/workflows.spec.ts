import { test,expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixtureVideo } from './fixtures.js';

let videoFile:string,assetDir:string;
const password='isolated-browser-test-passphrase';
test.describe.configure({mode:'serial'});
test.beforeAll(async()=>{await fs.mkdir('.local',{recursive:true});assetDir=await fs.mkdtemp(path.resolve('.local/browser-assets-'));videoFile=await fixtureVideo(assetDir);});
test.afterAll(async()=>{if(assetDir&&path.dirname(assetDir)===path.resolve('.local')&&path.basename(assetDir).startsWith('browser-assets-'))await fs.rm(assetDir,{recursive:true,force:true});});

test('owner creates, bulk uploads, orders, publishes, edits, compares and deletes a post',async({page,context,request})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/admin');await page.getByLabel('Password',{exact:true}).fill('wrong');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Password is incorrect');
  await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('heading',{name:'Your posts.'})).toBeVisible();
  await page.getByRole('link',{name:'New post',exact:true}).click();await page.getByLabel('Title',{exact:true}).fill('Browser workflow fixture');
  await page.getByLabel('Label this as example content').check();
  const longPrompt='EXACT_BROWSER_FIXTURE_PROMPT\n'+'A long prompt remains original.\n'.repeat(1700);
  await page.getByLabel(/^Original prompt/).fill(longPrompt);
  await page.getByLabel('Result notes',{exact:true}).fill('Automated test content. No actual benchmark measurements.');
  await page.getByLabel('Upload image',{exact:true}).setInputFiles('assets/demo/aluminum-study.png');await expect(page.getByText('1 of 1 file uploaded.',{exact:true})).toBeVisible();
  const final=page.locator('.editor-section').filter({has:page.getByRole('heading',{name:'Final showcase',exact:true})});
  const png=await sharp({create:{width:64,height:48,channels:3,background:'#ccc'}}).png().toBuffer();
  await final.getByLabel('Upload files',{exact:true}).setInputFiles(Array.from({length:5},(_,i)=>({name:`final-${i+1}.png`,mimeType:'image/png',buffer:png})));
  await expect(final.locator('.gallery-editor-item')).toHaveCount(5);await expect(final.getByRole('status')).toHaveText('5 of 5 files uploaded.');
  const progress=page.locator('.editor-section').filter({has:page.getByRole('heading',{name:'Progress',exact:true})});
  const transfer=await page.evaluateHandle(({base64})=>{const data=new DataTransfer();for(let i=1;i<=50;i++){const bytes=Uint8Array.from(atob(base64),character=>character.charCodeAt(0));data.items.add(new File([bytes],`step-${String(i).padStart(2,'0')}.png`,{type:'image/png'}));}return data;},{base64:png.toString('base64')});
  await progress.locator('.drop-zone').dispatchEvent('drop',{dataTransfer:transfer});await transfer.dispose();
  await expect(progress.locator('.progress-editor')).toHaveCount(50);await expect(progress.getByRole('status')).toHaveText('50 of 50 files uploaded.');
  await page.getByRole('button',{name:'Move progress 2 earlier',exact:true}).click();await expect(progress.getByLabel('What happened',{exact:true}).first()).toHaveValue('step-02.png');
  const ordering=await page.evaluateHandle(()=>{const data=new DataTransfer();data.setData('application/x-gallery-item','progress:0');return data;});await progress.locator('.progress-editor').nth(1).dispatchEvent('drop',{dataTransfer:ordering});await ordering.dispose();await expect(progress.getByLabel('What happened',{exact:true}).first()).toHaveValue('step-01.png');
  await progress.locator('.progress-editor').last().getByRole('button',{name:'Remove',exact:true}).click();
  await progress.getByLabel('Upload files',{exact:true}).setInputFiles(videoFile);await expect(progress.locator('.progress-editor')).toHaveCount(50);await expect(progress.getByRole('status')).toHaveText('1 of 1 file uploaded.');
  await page.getByRole('button',{name:'Add run',exact:true}).click();await page.locator('.run-editor').first().getByLabel('Model',{exact:true}).fill('Fixture model A');await page.locator('.run-editor').first().getByLabel('Reasoning effort',{exact:true}).fill('High');
  await page.getByRole('button',{name:'Add run',exact:true}).click();await page.locator('.run-editor').nth(1).getByLabel('Model',{exact:true}).fill('Fixture model B');
  await page.getByRole('button',{name:'Save draft',exact:true}).click();await expect(page).toHaveURL(/\/admin\/posts\/[0-9a-f-]+$/);await expect(page.getByRole('status').filter({hasText:'Draft saved.'})).toBeVisible();
  const editorUrl=page.url();await page.reload();await expect(progress.locator('.progress-editor')).toHaveCount(50);await expect(final.locator('.gallery-editor-item')).toHaveCount(5);
  expect((await request.get('/api/posts/browser-workflow-fixture')).status()).toBe(404);
  await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'Published.'})).toBeVisible();
  const publicPage=await context.newPage();await publicPage.goto('/posts/browser-workflow-fixture');await expect(publicPage.getByRole('heading',{name:'Final showcase',exact:true})).toBeVisible();
  const publicFinal=publicPage.locator('.detail-section').filter({has:publicPage.getByRole('heading',{name:'Final showcase',exact:true})});const publicProgress=publicPage.locator('.detail-section').filter({has:publicPage.getByRole('heading',{name:'Progress',exact:true})});
  await expect(publicFinal.locator('figure')).toHaveCount(5);await expect(publicProgress.locator('figure')).toHaveCount(50);
  await expect(publicPage.locator('.prompt-text')).toHaveText(longPrompt.slice(0,800)+'…');await publicPage.getByRole('button',{name:'Show full prompt',exact:true}).click();await expect(publicPage.locator('.prompt-text')).toHaveText(longPrompt);
  const downloadPromise=publicPage.waitForEvent('download');await publicPage.getByRole('link',{name:'Download prompt',exact:true}).click();const download=await downloadPromise;expect(await fs.readFile((await download.path())!,'utf8')).toBe(longPrompt);await publicPage.getByRole('button',{name:'Collapse prompt',exact:true}).click();
  await context.grantPermissions(['clipboard-read','clipboard-write']);await publicPage.getByRole('button',{name:'Copy link',exact:true}).click();expect(await publicPage.evaluate(()=>navigator.clipboard.readText())).toBe(publicPage.url());
  await publicProgress.getByRole('button',{name:'View fixture-timelapse.mp4',exact:true}).click();const dialog=publicPage.getByRole('dialog',{name:'Media viewer'});await expect(dialog.locator('video')).toHaveAttribute('controls','');await expect.poll(()=>dialog.locator('video').evaluate((video:HTMLVideoElement)=>video.readyState)).toBeGreaterThanOrEqual(1);await dialog.locator('video').evaluate((video:HTMLVideoElement)=>video.play());await expect.poll(()=>dialog.locator('video').evaluate((video:HTMLVideoElement)=>video.currentTime)).toBeGreaterThan(0);await publicPage.keyboard.press('Escape');await expect(dialog).toBeHidden();
  await publicFinal.getByRole('button',{name:'View Final 1',exact:true}).click();await publicPage.keyboard.press('ArrowRight');await expect(dialog.getByRole('button',{name:'Show Final 2',exact:true})).toHaveAttribute('aria-pressed','true');await publicPage.keyboard.press('Escape');
  const accessibility=await new AxeBuilder({page:publicPage}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(accessibility.violations).toEqual([]);
  for(const width of [320,390]){await publicPage.setViewportSize({width,height:844});expect(await publicPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);}
  await publicPage.getByRole('link',{name:'Compare these runs',exact:true}).click();await expect(publicPage.locator('.compare-row')).toHaveCount(2);await publicPage.getByRole('checkbox',{name:/Compare Fixture model A/}).check();await publicPage.getByRole('checkbox',{name:/Compare Fixture model B/}).check();await expect(publicPage.locator('.comparison-card')).toHaveCount(2);await publicPage.getByLabel('Model',{exact:true}).selectOption('Fixture model B');await expect(publicPage.locator('.compare-row')).toHaveCount(1);await publicPage.close();
  await page.goto(editorUrl);await page.getByLabel('Title',{exact:true}).fill('Browser workflow edited');await page.getByRole('button',{name:'Save published',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'Published.'})).toBeVisible();
  await page.getByRole('button',{name:'Move to draft',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'Draft saved.'})).toBeVisible();expect((await request.get('/posts/browser-workflow-fixture')).status()).toBe(404);
  page.once('dialog',dialog=>void dialog.accept());await page.getByRole('button',{name:'Delete post',exact:true}).click();await expect(page.getByRole('heading',{name:'Your posts.'})).toBeVisible();
  await page.getByRole('link',{name:'Media',exact:true}).click();await expect(page.getByRole('button',{name:'Delete image',exact:true}).first()).toBeEnabled();page.once('dialog',dialog=>void dialog.accept());await page.getByRole('button',{name:'Delete image',exact:true}).first().click();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('heading',{name:'Owner sign in',exact:true})).toBeVisible();expect(errors).toEqual([]);
});

test('empty, loading, error and mobile navigation states remain usable',async({page})=>{
  await page.goto('/');await expect(page.getByRole('heading',{name:'The journal starts here.'})).toBeVisible();
  await page.route('**/api/posts?*',async route=>{await new Promise(resolve=>setTimeout(resolve,300));await route.fulfill({status:503,json:{error:'Test connection failure.'}});});await page.reload();await expect(page.getByRole('status',{name:'',exact:true})).toContainText('Loading content');await expect(page.getByRole('alert')).toContainText('Test connection failure.');await page.unroute('**/api/posts?*');await page.getByRole('button',{name:'Try again',exact:true}).click();await expect(page.getByRole('heading',{name:'The journal starts here.'})).toBeVisible();
  await page.getByLabel('Search posts',{exact:true}).fill('unmatched');await page.getByRole('button',{name:'Search',exact:true}).click();await expect(page.getByRole('heading',{name:'No matching work.'})).toBeVisible();await page.getByRole('button',{name:'Clear filters',exact:true}).click();await expect(page.getByRole('heading',{name:'The journal starts here.'})).toBeVisible();
  for(const width of [320,390]){await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);}
  await page.getByRole('link',{name:'Compare',exact:true}).click();await expect(page.getByRole('heading',{name:'No runs to compare yet.'})).toBeVisible();
  expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
});
