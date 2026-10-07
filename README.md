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

**Lend a hand** puts your own hand into the world. The webcam watches it, and
a giant printed hand reaches into the island where you see yours in the
mirror, coming out of a cloud the way hands do in old emblem books and on the
corners of sea charts. Reach towards the screen and it lowers. Hold it palm up
and low beside a dodo, and wait: the curious ones climb aboard. Carry them
across the water; tip your hand and they slide off and flutter down (they
still can't fly). Your hand casts a real shadow. Wiggle your fingers and it
rains under your hand alone, and the forest grows there. Lay it on the sea
and rings spread out, glowing at night.

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
| **1–5** · **P** · **[ ]** | inks · print pattern · dot size |
| **H** | back home |
| **Lend a hand** (webcam) | palm up and low: dodos climb on · tip: they slide off · wiggle fingers: rain · touch the sea: ripples |

On a touchscreen: one finger sculpts, two fingers turn and zoom.

## Why

The dodo is Dodo's mascot, and also the most famous thing humans ever made
extinct. A toy where you give it back its island felt kinder than another
logo animation. The brief asked for something interactive that feels
finished, so the goal was a small world with cause and effect you can feel in
the first ten seconds (press, and the sea boils), and a slower loop that
rewards staying (rain, forest, rivers, eggs, birds, the log filling up).

It's also built the way the brief suggested, out of shaders. Paper Shaders'
dithering was the starting point for the look. Paper Shaders are 2D image and
pattern effects, though, and an island you can sculpt needs a raymarched 3D
world with a simulation under it, so the world has its own shader, with
dithering as the whole renderer. Paper Shaders does appear where it fits:
the camera mirror is your webcam printed live through its `HalftoneDots`
shader, in the island's own inks.

The hand came last. The camera isn't a replacement for the mouse here. It
adds the one thing a mouse can't: you are physically in the world, and the
dodos react to you.

## How it's built

No 3D engine: React for the chrome, one WebGL2 canvas, and about 5,000 lines
of TypeScript and GLSL.

- **The world is one fragment shader.** It raymarches a heightfield (the land
  you sculpt), an analytic sea with swells and a reef break, tree canopies,
  soft shadows, cloud shadows, signed-distance dodos, billowing volumetric
  smoke, and seabirds projected into screen space and drawn as inked "M"s. It
  renders at print resolution, one texel per dot, and outputs no colour: only
  tone, depth, material and a glow mask.
- **The print is a second pass.** Each material (sea, sand, rock, forest,
  dodo, sky, smoke) prints from its own six-ink ramp, from key to paper,
  like a risograph run with a separate drum for each spot colour. Areas print
  as flat ink. Only the transition between two neighbouring inks is screened,
  with round halftone dots drawn at full screen resolution and each material
  at its own screen angle, so gradients turn into tidy dot bands instead of
  noise. Key black is kept for contours, birds and eyes. A faint paper tooth
  and uneven ink density finish it. The "Day" palette follows the sun from
  dawn through dusk to night. **P** cycles halftone, grain, Bayer and lines.
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
- **The hand.** MediaPipe's hand landmarker runs on the webcam (GPU, falling
  back to CPU), with its runtime and model served from this site, and a One
  Euro filter on the landmarks. Its metric 3D landmarks become 21 joints in the
  world, turned so a hand shown to the camera leans back into the scene palm
  towards you, and placed where the hand appears in the mirror: a bigger
  hand in the frame is closer to the camera, so it reaches further in. In the
  shader it's a signed-distance hand (tapered finger bones, a fleshier palm,
  a cloud cuff) that casts soft shadows on land, sea and dodos and
  materialises in dithered patches. The palm becomes a little floor dodos can
  stand on. Finger wiggle, measured in the palm's own frame so moving the
  hand doesn't count, becomes a local shower that feeds the forest and rivers.
  Contact with the sea starts ripples.
- **Sound is synthesised** with the Web Audio API: the sea (louder as you get
  closer), the ground groaning as it rises, lava hiss and crackle, rain,
  thunder with a delay, seabird cries, eggs, the dodo's two-note honk, a
  whoosh when your hand arrives, and plinks when it touches the water.
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
- **Two hands.** Cup both hands to carry water and pour it into a crater
  lake, or shelter the dodos from a storm.
- **The hand as weather and time.** Hold it over the sun for an eclipse that
  sends the birds home; a fist closing slowly to bring on dusk.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
```

The camera needs a secure context: `localhost` is fine, and a deployed site
must be on HTTPS (GitHub Pages, Vercel and Netlify all are). Add `?still` to
skip the intro, or `?px=3` for bigger dots. Dots default to
2 CSS px; if frames run long for a few seconds on a slow GPU, it steps up to
3 by itself.

Deploys as a static site: push to `main` and the included GitHub Pages
workflow publishes `dist/`, or import the repo into Vercel or Netlify (build
`npm run build`, output `dist`).
