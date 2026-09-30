import fs from 'node:fs/promises';
import { readConfig } from '../server/config.js';
import { Store } from '../server/db.js';
import { mediaService } from '../server/media.js';
import { postSchema } from '../shared/schema.js';

const config = readConfig();
const store = new Store(config.dataDir);
const images = mediaService(store,config);
const examples = [
  { slug: 'aluminum-study',title: 'An aluminum study',asset: 'aluminum-study.png',category: 'Design',prompt: 'Generate a wide 3:2 photoreal studio image of a single sculptural folded brushed-aluminum ribbon, an intricate continuous loop resting on a matte black pedestal. Strong geometric silhouette, tactile brushed grain, soft silver highlights, black backdrop with subtle falloff. Editorial industrial design photography, carefully balanced negative space, medium close view, dramatic softbox lighting. Strict monochrome black, white and neutral silver gray. No color tint, no blue, no orange. No words, no letters, no logos, no UI, no watermark.' },
  { slug: 'porcelain-study',title: 'Porcelain, in black and white',asset: 'ceramic.png',category: 'Design',prompt: 'Generate a landscape 3:2 studio photograph of a large white porcelain sculptural torus with an off-center circular opening, angled on a glossy black plinth. Three-quarter composition, striking silver-white form against a pure black backdrop, crisp edge lighting and realistic porcelain surface. Contemporary industrial design editorial, high visual clarity. Strict neutral monochrome, no colored tint. No text, no logo, no watermark, no UI.' },
  { slug: 'parallel-pavilion',title: 'A pavilion in parallel',asset: 'pavilion.png',category: 'Other',prompt: 'Create a landscape 3:2 cinematic architectural photograph of a minimal concrete pavilion made from parallel slender white fins that curve overhead, standing on black basalt terrain. A small black reflecting pool in foreground, soft gray overcast sky and mist, strong wide framing, brutalist material textures. True black, white, neutral gray monochrome, no blue or warm tint. Beautiful composition and clear silhouette. No text, no logo, no watermark, no people, no UI.' },
];
try {
  for (const example of [...examples].reverse()) {
    if (store.db.prepare('SELECT id FROM posts WHERE slug=?').get(example.slug)) continue;
    const image = await images.upload(await fs.readFile(`assets/demo/${example.asset}`),example.asset,'image/png');
    store.save(postSchema.parse({ title: example.title,slug: example.slug,summary: 'Sample artwork for the journal layout.',category: example.category,
      prompt: example.prompt,body: 'This image was generated as sample artwork using the built-in image generation tool. No model identity, elapsed time, token count or benchmark score was recorded. Replace these examples with your own documented work.',
      status: 'published',isDemo: true,coverId: image.id,runs: [],progress: [] }));
    console.log(`Added example: ${example.title}`);
  }
  console.log('Example posts are removable through the owner editor. No benchmark measurements have been seeded.');
} finally { store.close(); }
