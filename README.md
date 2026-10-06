# Specimen

**Money you can hold.**

Live: _add your deploy link here_ · Built for the Dodo Payments design engineer brief.

---

## What it is

Turn on your camera and a banknote of *The Dodo Reserve* jumps into your hand.
Not near your hand. Into it. It's a sheet of paper with real physics, and your
webcam is the controller:

| Your hand | The money |
| --- | --- |
| **Open hand** | The note flies to your palm and rests there. Turn your wrist and the foil throws rainbow light while the numeral shifts from green to gold. |
| **Pinch** | Pick it up by a corner. It dangles and swings like paper. Let go mid-swing and it tumbles to the ground. |
| **Two hands** | Hold both ends and pull it taut. Pull too hard and it slips out of one grip. |
| **Fist** | Crumple it into a ball. Open your hand and it un-crumples, keeping its creases. |
| **Point** | Your fingertip becomes a UV torch. The room goes dark, and the fibres, serials and a hidden lime dodo glow. |
| **Raise it** | Hold it up to the light and the watermark appears in the paper. |
| **Rub thumb across fingers** | The universal sign for money. You print some. It rains. *Inflation* climbs in the corner. |

No camera? The mouse stands in for a hand: drag to hold and fling, hold
**Space** to print, **Shift** (or right-click) for UV, **C** to crumple,
scroll to bring it closer, and press **R** or double-click to call the note back.

## Why

Dodo moves money that never touches paper, so I made the most physical money
I could: something you'd want to grab, fold and throw. The joke is that it's
an extinct bird backing a currency, and the gesture everybody makes for
"money" actually makes money. Dodo's lime green appears nowhere until you
switch on the UV torch. Then it's everywhere, along with a hidden line:
*"Some things only show up in the right light."*

## How it's built

- **The note is a material, not a picture.** One shader describes the banknote as paper, offset ink, raised intaglio ink, colour-shifting ink, foil, an embedded thread, fluorescent fibres and a watermark, evaluated at the mesh's UVs. The guilloche (the fine wavy line patterns) is solved per pixel from its curve equation, so it stays crisp at any distance and morphs when you type a new name into *Issued to*. The portrait is a dodo I drew, engraved by the shader.
- **The paper is a simulation.** Each note is a Verlet particle grid with stretch, shear and bend constraints and per-triangle air drag, which is what makes it flutter rather than drop. Pins hold it to your pinch, a soft rigid-pose attach seats it on your palm, palms are colliders that catch falling notes, and crumpling leaves a permanent wrinkle map the shader turns into creases.
- **Your room is in it.** The webcam is drawn behind everything as a live engraving, in the same line language as the note's portrait. The foil reflects it, and a light at the top of the frame is what you hold notes up to.
- **Hands.** MediaPipe's hand landmarker (self-hosted model and WASM, lazy-loaded only when you choose the camera) feeds a pure-TypeScript gesture tracker: pinch with hysteresis, rotation-invariant finger extension, palm orientation from world landmarks, and the "money" rub detected as thumb oscillation along the fingers. Everything passes through One Euro filters, so it's steady at rest without lagging a flick.
- **Small things.** Sounds are synthesised (paper flutter, a note-counting machine while you print, crumpling). There's a printing-press intro. When the UV torch flickers on, the interface steps back. The webcam image never leaves the page. Rendering adapts its resolution if frames run long. Reduced motion skips the ceremony.

## What I'd explore next

- **Pass it on.** Two people, two browsers: pinch a note off the edge of your screen and it lands in someone else's hand. Payments, literally.
- **Spot the fake.** A counterfeit that looks right in your palm but fails under the UV torch.
- **Hand occlusion.** Segment the hand so your fingers wrap *over* the note instead of only behind it.
- **Tearing.** Pull hard enough with two hands and it rips along the paper fibres.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

The camera needs `localhost` or HTTPS. Deploy `dist/` anywhere static. On
Vercel, import the repo and accept the Vite defaults. On GitHub Pages, enable
*Settings → Pages → GitHub Actions*; the included workflow deploys from `main`.

**Stack:** Vite, React, TypeScript, raw WebGL2, Canvas2D, WebAudio, MediaPipe Tasks Vision.

```
src/
  engine.ts          hands → gestures → paper physics → render; mouse fallback
  contracts.ts       shared types and coordinate conventions
  gl/material.glsl   the banknote as materials (front and reverse)
  gl/sheet.frag      lighting a sheet: key light, room reflections, backlight, UV torch
  gl/backdrop.frag   the webcam as a live engraving
  gl/renderer3d.ts   minimal WebGL2: one backdrop pass, one mesh per note
  physics/paper.ts   Verlet paper: constraints, aerodynamics, pins, colliders, crumple
  sense/hands.ts     MediaPipe hand landmarker, smoothed and mirrored
  sense/gestures.ts  pinch / point / fist / open / rub, palm orientation
  note/*             printing plates, the drawn dodo, name → serial, inks and guilloche
  sound.ts, paperSound.ts   synthesised sounds
scripts/tests/       physics and gesture tests (npx tsx scripts/tests/<file>.ts)
```
