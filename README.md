# Raphus

**An island for the last dodo. You make it with your hands; it comes alive by itself.**

Live: _add your deploy link here_ · Built for the Dodo Payments design engineer brief.

---

## What it is

Mauritius, 1662. The camera falls through the clouds to a single rock in the
sea, and on it stands the last dodo.

Press and hold on the sea and land comes up out of it: the water boils, new
rock arrives molten, and smoke rolls off the vent. Lava finds its way down the
slopes in glowing threads and hisses into the sea. Hold for rain and the
weather turns: clouds, lightning, thunder a beat later. Where it rains, forest
spreads over the bare rock. Rivers form, find the sea, and slowly cut their
valleys, and hollows fill into lakes. As the forest grows, eggs hatch. Seabirds
come in from the sea to nest. Leave it alone and the day goes on by itself;
at night the surf glows.

Raise twelve dodos and the species isn't extinct any more, at least here.

The whole world is drawn as a print: four inks and one fluorescent spot
colour, put down through an ordered dither, like an engraving that happens to
be alive. **Print** mounts the current view as a plate from an old natural
history, with a caption of what's on the island.

| | |
|---|---|
| **Press and hold** on the sea or land | raise land (it erupts) |
| **Shift-drag** | carve land away |
| **Hold R** or the rain button | rain, storms |
| **Drag the sky** | move the sun; below the horizon is night |
| **Right-drag**, arrows · **scroll** · **double-click** | turn · zoom · fly to a spot |
| **Click a dodo** | say hello |
| **1–5** · **P** · **[ ]** | inks · dither pattern · dot size |
| **H** | back home |

On a touchscreen: one finger sculpts, two fingers turn and zoom.

## Why

The dodo is Dodo's mascot, and also the most famous thing humans ever made
extinct. A toy where you give it back its island felt kinder than another
logo animation. The brief asked for something interactive that feels
finished, so the goal was a small world with cause and effect you can feel in
the first ten seconds (press, and the sea boils), and a slower loop that
rewards staying (rain, forest, rivers, eggs, birds, the log filling up).

It's also built the way the brief suggested, out of shaders. Paper Shaders'
dithering was the starting point for the look; here the dither is the whole
renderer, and a few inks stretch to cover sea, forest, lava and night.

## How it's built

No 3D engine: React for the chrome, one WebGL2 canvas, and about 3,000 lines
of TypeScript and GLSL.

- **The world is one fragment shader.** It raymarches a heightfield (the land
  you sculpt), an analytic sea with swells and a reef break, tree canopies,
  soft shadows, cloud shadows, signed-distance dodos, billowing volumetric
  smoke, and seabirds projected into screen space and drawn as inked "M"s. It
  renders at print resolution, one texel per dot, and outputs no colour: only
  tone, depth, material and a glow mask.
- **The print is a second pass.** It inks that tone through an ordered
  dither (Bayer, blue noise, a 45° halftone or engraving lines) with key and
  paper shared and the middle inks chosen per material, the way a risograph run
  uses a different spot colour for each plate. Contour lines go wherever depth
  jumps. The "Day" palette follows the sun from dawn through dusk to night.
- **The land is simulated on the CPU** in a 256² heightmap, then mirrored
  into an RGBA16F texture (height, vegetation, lava heat, water):
  - *Drainage* is a priority-flood from the coast, so every river reaches the
    sea, and a hollow fills to its rim and becomes a lake. Flow accumulates
    down the drainage tree in one pass; while it rains, fast water erodes its
    bed.
  - *Lava* is heat that spills from cell to cell down the same drainage tree,
    cooling as it goes. Where it reaches the sea, a steam plume starts.
  - *Forest* spreads from forest, faster in rain and along rivers, and only
    where the height and slope suit it.
- **Life.** Dodos hatch as the forest grows. They waddle to new spots, won't
  climb cliffs, float (offended) if you drown their ground, and run, flapping,
  from lava. Seabirds arrive from the sea, circle the island, alternate
  wingbeats and glides, and leave at night.
- **Sound is synthesised** with the Web Audio API: the sea (louder as you get
  closer), the ground groaning as it rises, lava hiss and crackle, rain,
  thunder with a delay, seabird cries, eggs, and the dodo's two-note honk.
- **Small things.** The opening descends through dithered cloud. The chrome
  fades while you work. A log notes each first ("A river finds its way down to
  the sea."). Reduced motion skips the intro. Dot size and inks are live.

## What I'd explore next

- **Seasons and a wider sim.** Wind that carries rain clouds over ridges
  (wet windward forest, dry leeward scrub), tides, and erosion that leaves
  sediment as beaches and deltas.
- **Ships.** A sail on the horizon at dawn, the thing that actually ended the
  dodo, and the choice of whether to let it land.
- **Shareable islands.** The heightmap compresses to a few KB. An island
  could live in the URL, and a plate could link back to the island it shows.
- **Paper.** Overprint between inks, a little mis-registration, and paper
  texture under the dither, so a printed plate feels like a real risograph.
- **Hands.** Raise land with an open palm over the webcam and sweep for rain.
  I prototyped camera input earlier in this project and dropped it, because
  the mouse was more precise. With a world this tactile it might earn its
  place back.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
```

Add `?still` to skip the intro, or `?px=4` for bigger dots.

Deploys as a static site: push to `main` and the included GitHub Pages
workflow publishes `dist/`, or import the repo into Vercel or Netlify (build
`npm run build`, output `dist`).
