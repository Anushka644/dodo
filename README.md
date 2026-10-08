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

**Lend your face** and you become the island's weather. Smile and the sun
comes out; at night, it rises for you. Frown and the sky breaks into rain.
Tilt your head and the sun goes with it, like turning a dial: towards your
right shoulder the day runs on into sunset and night, towards your left back
to morning.
Puff out your cheeks and blow: your face flies up into a corner of the sky as
a wind head, the cheek-puffed face that blows the winds on old sea charts,
and lines of breath stream across the island, whitecaps break on the sea, the
clouds race and the smoke leans. Open wide and roar, and the mountain answers
with an eruption. Move your head and the island shifts, as if it sat behind
the glass. A small legend by the mirror shows how strongly the camera sees
each expression, and lights up the ones that count.

The whole world is drawn as a print: four inks and one fluorescent spot
colour, put down through an ordered dither, like an engraving that happens to
be alive. **Print** mounts the current view as a plate from an old natural
history, with a caption of what's on the island.

| | |
|---|---|
| **Press and hold** on the sea or land | raise land (it erupts) |
| **Shift-drag** | carve land away |
| **Hold the space bar** or the rain button | rain, storms |
| **Drag the sky** | move the sun; below the horizon is night |
| **⌘-drag** (Ctrl-drag), arrows · **scroll** · **double-click** | turn · zoom · fly to a spot |
| **Click a dodo** | say hello |
| **1–5** · **P** · **[ ]** | inks · print pattern · dot size |
| **H** | back home |
| **Lend your face** (webcam) | smile: sun · frown: rain · tilt your head: time of day · puff and blow: wind · open wide: eruption · move your head: look around |

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
shader, in the island's own inks; and when you blow, that printed face becomes
the wind head in the sky.

The camera isn't a replacement for the mouse here. The mouse makes the land;
your face makes the weather. An expression is something everyone already
knows how to do, and "a smile brings out the sun" needs no instructions.

## How it's built

No 3D engine: React for the chrome, one WebGL2 canvas, and about 4,500 lines
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
- **The face.** MediaPipe's face landmarker runs on the webcam (GPU, falling
  back to CPU), with its runtime and model served from this site. Its
  blendshapes (smile, brow-down and mouth-frown, cheek-puff and pucker,
  jaw-open) are eased, and each expression has two thresholds, one to switch
  on and a lower one to switch off, so nothing flickers. A frown reads small
  in MediaPipe's numbers and every face rests differently, so it's measured
  as the rise above your own resting face. A blow has to be held (talking
  rounds the lips too); a laugh or a yawn is not a roar. Head tilt is the
  slope of the line between the eyes. Expressions drive the same weather as
  the mouse and keyboard (rain, sun, the day's clock), plus
  a wind that runs through the shader: cloud drift, chop and whitecaps, the
  lean of the smoke, slanted rain, and engraved breath lines streaming from
  the wind head. The head's position in the mirror turns the view, and leaning
  in brings the island closer, measured against where your face first settled.
- **Sound is synthesised** with the Web Audio API: the sea (louder as you get
  closer), the ground groaning as it rises, lava hiss and crackle, rain,
  thunder with a delay, seabird cries, eggs, the dodo's two-note honk, and
  wind that rises and gusts while you blow.
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
- **More of the face.** A wink at night that sends a shooting star across; a
  sun in the sky that wears your expression; the dodos turning to look at the
  wind head when it appears.
- **Sound in.** Hum low to make the ground rumble, whistle to call the birds
  home.

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
