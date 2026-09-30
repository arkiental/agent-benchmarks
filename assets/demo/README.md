# Optional example artwork

These images were generated for this project using the built-in image generation tool on 2026-09-30. They are demonstration artwork, not evidence of measured agent or model performance. No model name, elapsed time, tokens or scores were supplied or invented.

`npm run seed:demo` creates clearly labeled example posts. Production starts empty unless this command is run. Existing slugs are skipped. Remove the posts in the owner editor and delete unused images from Media when ready.

The content prompts appear in `scripts/seed.ts`. The full generation prompts also specified the use case, intended sample-thumbnail role and prohibition on benchmark claims:

- `aluminum-study.png`: product-mockup, optional demonstration thumbnail; single folded brushed-aluminum ribbon on a black pedestal, neutral monochrome industrial design photography.
- `ceramic.png`: product-mockup, optional demonstration thumbnail; white porcelain torus on a glossy black plinth, neutral monochrome editorial photography.
- `pavilion.png`: stylized-concept, optional demonstration thumbnail; concrete pavilion with slender parallel fins, basalt terrain and reflecting pool, neutral monochrome architectural image.

The files are retained as generated images. Imported media is decoded, stripped of metadata, size limited and reencoded to WebP by the same pipeline used for owner uploads.
