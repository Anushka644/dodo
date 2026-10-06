// Shared shapes for the cross-border version.
//
// DESK SPACE: the whole desktop, in CSS pixels, origin at the top-left of the
// primary screen, y down — the same space as window.screenX/Y. Every browser
// window is a rectangle in desk space; notes live in desk space too, so a
// note can be half in one window and half in another.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** one passport stamp on a note, in note space (u ∈ [0, ASPECT], v ∈ [0, 1]) */
export interface Stamp {
  /** country index into COUNTRIES, or -1 for "returned to sender" */
  c: number;
  u: number;
  v: number;
  /** rotation, radians */
  r: number;
}

export interface NoteState {
  id: number;
  /** centre, desk px */
  x: number;
  y: number;
  /** in-plane rotation, radians */
  a: number;
  /** visual tumble about the note's long axis, radians (from the leader, so every window agrees) */
  flip: number;
  /** visual bend (air pushing on the paper), −1..1 */
  bend: number;
  vx: number;
  vy: number;
  /** country index of the window it last entered */
  home: number;
  stamps: Stamp[];
  /** draw order: higher is on top */
  z: number;
  /** between windows, in nobody's country */
  transit: boolean;
}

export interface PeerInfo {
  id: string;
  /** Date.now() when the window opened: the oldest live window simulates */
  born: number;
  country: number;
  rect: Rect;
  visible: boolean;
  /** performance.now() when we last heard from it (local clock) */
  seen: number;
}

export type Msg =
  | { t: 'hello'; from: string; born: number; country: number; rect: Rect; visible: boolean }
  | { t: 'rect'; from: string; born: number; country: number; rect: Rect; visible: boolean }
  | { t: 'bye'; from: string }
  | { t: 'state'; from: string; seq: number; notes: NoteState[] }
  | { t: 'input'; from: string; kind: 'down' | 'move' | 'up'; pid: number; x: number; y: number }
  | { t: 'cmd'; from: string; kind: 'print'; count: number }
  | { t: 'event'; from: string; kind: 'stamp' | 'returned' | 'thud'; note: number; country: number; x: number; y: number; strength: number };

/** a banknote's size on the desk, CSS px */
export const NOTE_W = 300;
