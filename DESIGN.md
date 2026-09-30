# Agent Benchmarks

An image-led journal of agent work for people evaluating the process as well as the result.

The user requested true black and white, large clear typography, thumbnail-and-title posts, minimal chrome, and no caption clutter. Artwork can retain its own colors.

Palette: black #000000, white #ffffff, foreground gray #b5b5b5, secondary surface #151515, border #3b3b3b. White is the only interface accent.

Typography: self-hosted Archivo variable. Its broad, direct letterforms make short post titles feel substantial while remaining legible in forms. Base text 18px; headings 40–96px by viewport.

Layout: left-aligned journal heading, then a two-column image gallery with thumbnail/title pairs. The first image leads through size rather than badges or UI decoration. Detail pages place the result first, the exact prompt and structured runs below. Admin uses ordinary labeled controls.

Space: generous image-to-image separation distinguishes individual experiments without putting each into a bordered panel.

Shape: 2px corners for controls, images and panels. No pills, gradients, shadows, colored interface accents or text overlays on images.

Motion: short hover and pending-state transitions only, respecting reduced motion. No autoplay or scroll effects.

Design-taste dials: DESIGN_VARIANCE 6 / MOTION_INTENSITY 2 / VISUAL_DENSITY 3.
Antislop dials: ENERGY 3 / RHYTHM 2 / MOTION 1. Large image and type carry the energy; a consistent journal grid supports browsing.

The antislop filter applies during implementation, per the explicit task instruction to proceed autonomously and avoid cosmetic questions. No skill installation or project pointer installation is requested.

Demonstration posts are clearly marked as examples and contain no invented model, timing, token or performance values. They are optional and removable. Production starts empty.
