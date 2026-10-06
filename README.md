# Specimen

**A banknote you can hold up to the light.**

Live: _add your deploy link here_ · Built for the Dodo Payments design engineer brief.

---

## What it is

You move a light over a banknote. That's the only interaction.

Change the kind of light and the note answers differently, because every
layer is a real anti-counterfeiting technique and each one only responds to
the right light:

| Tool | What it shows |
| --- | --- |
| **1 · Lamp** | Raking light. The intaglio ink is raised, so the type and the engraved portrait catch the light as you move. The foil throws colour and the numeral shifts from green to gold. Scroll to raise or lower the lamp. |
| **2 · Loupe** | ×5 (scroll to change). The thin lines around the border and on the thread are microtext. Read them. |
| **3 · Ultraviolet** | The paper goes dark, as genuine paper does. Fibres, serials, a thread, a hidden dodo and a hidden line of text glow. |
| **4 · Backlight** | The paper itself has a portrait (a watermark), the reverse side shows through, and two half-flowers printed on opposite sides line up into one. |

**Type a name** and the note is re-minted for its bearer. The serial, the
inks and the shape of every guilloche pattern are derived from the name, and
the patterns flow into their new shape as you type. **Sit** turns on the
camera and engraves you into the portrait, live. **Keep** saves your note as a PNG.

## Why a banknote

Dodo moves money that never touches paper, so I went the other way and made
the most physical form money has ever taken. Banknotes are also the most
over-designed objects most people carry: guilloche, intaglio, microprint and
fluorescent fibres all exist so that ordinary people can check, by eye, that
something is real. That felt close to what a payments company sells.

The dodo is the joke: an extinct bird backing a currency. Dodo's lime green
appears nowhere on the note until you switch on the UV lamp. Then it's
everywhere, along with the line _"Some things only show up in the right light."_

## Choices worth mentioning

- **Materials, not images.** One fragment shader describes the note as paper, offset ink, raised intaglio ink, colour-shifting ink, foil, an embedded thread, fibres and a watermark, then lights it. The four tools don't swap pictures. They're four lighting models over the same materials.
- **Guilloche solved, not drawn.** A rosette is a family of curves `r = R(θ) + A·sin(kθ + φ)`. Solving for `φ` at every pixel gives a smooth field whose level sets *are* the curves (two solutions, so two families that interlace). It stays crisp under the loupe, costs no geometry, and because the shape parameters are continuous the pattern morphs as you type without tearing.
- **Printing plates.** Type is set in Canvas2D, one single-channel texture per print process (intaglio, colour-shift, UV ink, watermark, reverse, letterpress), mirroring how notes are actually printed. The shader decides how each plate reacts to each light.
- **Engraving.** The portrait is a drawn dodo stored as tone + form + silhouette. Line thickness carries tone, and the lines bend around the form like a real engraver's would. The live camera runs through the same function.
- **Paper Shaders.** I started from the suggested library and read through `ShaderMount`. I needed live canvas and video textures and a single lighting model across every layer, so I wrote one custom WebGL2 shader rather than stacking separate shaders.
- **Small things.** The lamp has a little weight (a critically damped spring). The UV tube flickers on and hums. The note's shadow slides as the lamp moves. There's a centre fold that catches the light. The loupe has its own LED ring. On touch, the lamp and lens float above your finger so you can see what's underneath. On tall screens the note turns upright. Arrow keys steer the lamp. Reduced motion skips the ceremony. Sounds are synthesised, with no audio files. It renders only when something changes and lowers its resolution if frames run long.

## What I'd explore next

- **Tilt.** On phones, drive the foil and colour-shifting ink from the gyroscope, so you literally tilt the note.
- **Spot the fake.** A second note that looks identical under the lamp but fails under UV or backlight. Same toy, now a game.
- **Flip it over.** The reverse is already printed (you can see it when backlit). Make it a side you can turn to.
- **Real diffraction.** Spectral rendering for the foil, and a kinegram that animates as the lamp crosses it.
- **Print it.** Export at plate resolution, separated by process, ready for a riso.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

Deploy `dist/` anywhere static. On Vercel, import the repo and accept the
Vite defaults. On GitHub Pages, enable *Settings → Pages → GitHub Actions*;
the included workflow deploys on every push to `main`.

**Stack:** Vite, React, TypeScript, WebGL2 (one fragment shader), Canvas2D, WebAudio. No runtime dependencies beyond React and the fonts (IM Fell English, Bodoni Moda, Pinyon Script, IBM Plex Mono).

```
src/
  gl/note.frag       the whole note: materials + four lighting models
  gl/renderer.ts     minimal WebGL2 wrapper
  note/plates.ts     Canvas2D printing plates (type, serials, UV ink, watermark, reverse)
  note/dodo.ts       the sitter: a drawn dodo as tone / form / silhouette
  note/seed.ts       name → serial, inks, guilloche parameters
  note/layout.ts     one layout shared by the plates and the shader
  engine.ts          input, springs, flicker, the press, the loop
  sound.ts           synthesised switch, ballast hum, numbering ticks
  App.tsx            the chrome
```
