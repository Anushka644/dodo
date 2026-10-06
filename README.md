# Specimen: Cross-border

**Every browser window is a country. Throw money between them.**

Live: _add your deploy link here_ · Built for the Dodo Payments design engineer brief.

---

## What it is

Open the page and you're in the United States, with a few banknotes of
*The Dodo Reserve* on the floor of the window. Pick one up and throw it
around. It's paper, so it tumbles and lands.

Click **Open a border** and a second window opens next to the first: India.
Throw a note hard at the edge of the first window. It leaves the window,
crosses the real gap on your desktop between the two, and lands in the
second one.

The note doesn't change, but how it's written down does. Each window prints
every note in its own currency and colours. A note caught half-way across the
border reads **$1.00** on one side of the window edge and **₹83.20** on the
other: it converts exactly at the border. It also picks up a passport stamp
for every country it enters, so well-travelled money ends up covered in them.

- **Overlap two windows** and the border between them opens (it glows lime), so money falls freely from one country into the other.
- **Drag a window around** and the money inside it slides and piles against the walls.
- **Close a country** and its money has nowhere to be, so it's *returned to sender*, with a stamp to prove it.
- **Throw too softly** and it bounces off the border. Customs only clears a confident throw, and only toward another country.
- The window's own title bar and tab icon show what it holds: `₹249.60 · India`.

Keys: **P** prints three more notes, **O** opens a border. On a phone, where
there's only one window, tilting the phone tilts the country.

## Why

Dodo's whole job is money crossing borders: one integration, 150+
countries, the local currency on the other side. I wanted to make that
literal and physical, without a chart or a checkout in sight. Your desktop is
the world map, windows are countries, and the gap between two windows is the
border. The toy doesn't explain foreign exchange. It just does it, at the
exact pixel where one country ends.

## How it's built

- **One world, many windows.** Windows on the same origin find each other over a `BroadcastChannel` and report where their viewport sits on the desktop (`screenX/Y`, adjusted for the browser chrome). The oldest visible window runs the physics for the whole desktop and broadcasts every note's position each frame. Every window draws the part of the desk it covers. If the leader closes, the next oldest takes over from the last state it heard.
- **Physics in desktop pixels.** [planck.js](https://github.com/piqnt/planck.js) (Box2D) with notes as rigid bodies. Each window is a box of four kinematic walls that move with the window, which is why dragging a window sloshes its money. A pre-solve contact filter turns walls into borders: a wall disappears where another window overlaps it, and for a hard throw toward another country. Once a note is in the gap, its arc is steered so it lands in the window it was thrown at. A note with nowhere to land within 1.6 s is returned to sender.
- **The note is a material, not a picture.** A shader describes the banknote as paper, offset ink, raised intaglio ink, colour-shifting ink, foil, a security thread and a watermark. The guilloche (the fine wavy line patterns) is solved per pixel from its curve equations. The portrait is a dodo I drew, engraved by the shader. Each country prints from its own Canvas2D plates: currency symbol, amount in words, palette. Passport stamps come from a generated rubber-stamp atlas.
- **Orthographic, on purpose.** Each window projects desktop pixels straight onto its viewport, so a note straddling two windows lines up exactly across the gap. Notes tumble and bow as they fly; the leader computes that too, so every window draws the same motion.
- **Small things.** Sounds are synthesised and only play in the window where something happens: a stamp thunk, a paper flutter, a snap when a payment bounces. The border band glows lime where it's open. Rendering adapts its resolution if frames run long.

## What I'd explore next

- **Other people's desktops.** Swap the BroadcastChannel for a WebSocket and a throw could land on a friend's screen. A real cross-border payment, in about 40 lines.
- **Fees and float.** Let a small cut go missing at each border, then show where it went.
- **Settlement time.** Some borders could hold a note in a visible queue before it's released.
- **Counterfeits.** One note in a hundred has the wrong serial, and only the UV lamp from the earlier version catches it.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

Allow pop-ups so **Open a border** can open the next country. Deploy `dist/`
anywhere static. On Vercel, import the repo and accept the Vite defaults. On
GitHub Pages, enable *Settings → Pages → GitHub Actions*; the included
workflow deploys from `main`.

For testing without moving real windows, `?wx=…&wy=…` fakes a window's desktop
position, and `?c=IN` picks the country.

**Stack:** Vite, React, TypeScript, raw WebGL2, Canvas2D, WebAudio, planck.js.

```
src/
  borders/net.ts       windows find each other; who runs the physics
  borders/world.ts     desktop physics: windows as boxes, customs, returned payments
  borders/engine.ts    per-window loop: sync, render this window's slice of the desk
  borders/countries.ts countries, currencies, indicative rates
  gl/material.glsl     the banknote as materials (front, reverse, stamps)
  gl/sheet.frag        lighting a note
  gl/backdrop.frag     the country behind the glass, and its border
  gl/renderer3d.ts     minimal WebGL2
  note/*               printing plates per country, the drawn dodo, stamp atlas
scripts/tests/world.test.ts   desk physics without a browser (npx tsx …)
```
