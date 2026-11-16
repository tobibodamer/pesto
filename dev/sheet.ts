// Pose sheets: grids of Pesto in fixed poses, for eyeballing the rig.
import { Puppet } from "../src/pesto/puppet";
import { EMOTIONS, EMOTION_NAMES, REST, applyPose, clonePose, type PartialPose } from "../src/pesto/pose";
import { StickerPainter } from "../src/render/sticker";

declare global {
  interface Window {
    SHEET?: string;
  }
}

interface Cell {
  label: string;
  pose: PartialPose;
  setup?: (p: Puppet) => void;
  /** Sticker border in character units; the sheet's usual one when left out. */
  border?: number;
}

const BORDER = 1.5;

const SETS: Record<string, { scale: number; cell: [number, number]; cells: Cell[] }> = {
  hero: {
    scale: 3.2,
    cell: [700, 640],
    cells: [
      { label: "neutral", pose: {} },
      { label: "smug, looking right", pose: { ...EMOTIONS.smug, yaw: 0.5, gazeX: 0.7, tilt: 0.08 } },
    ],
  },
  // Close on the hands and feet in the poses that show them.
  limbs: {
    scale: 2.6,
    cell: [470, 470],
    cells: [
      { label: "rest", pose: {} },
      { label: "point right", pose: { handRX: 56, handRY: -66, pointR: 1, yaw: 0.5, gazeX: 0.8, lean: 0.1 } },
      { label: "point up-left", pose: { handLX: -42, handLY: -98, pointL: 1, yaw: -0.4, gazeX: -0.6, gazeY: -0.6 } },
      { label: "grabby", pose: { handLX: -9, handLY: -47, handRX: 9, handRY: -45, ...EMOTIONS.curious } },
      { label: "wave", pose: { handRX: 40, handRY: -90, tilt: 0.09, ...EMOTIONS.happy } },
      { label: "walking right", pose: { facing: 0.82, yaw: 0.42, footLX: 4, footLY: 0, footRX: -4, footRY: -5, handLX: -6, handLY: -30, handRX: 20, handRY: -32 } },
    ],
  },
  // Close on the places where a part could read as stuck on: raised arms, half-shut lids, a turning body.
  seams: {
    scale: 2.6,
    cell: [470, 470],
    cells: [
      { label: "shrug", pose: { handLX: -47, handLY: -54, handRX: 47, handRY: -54, headY: 3, tilt: 0.13, browRaise: 0.6, smile: 0.05 } },
      { label: "arms up over his head", pose: { handLX: -30, handLY: -98, handRX: 34, handRY: -92, pitch: -0.2 } },
      { label: "sleepy, brows up", pose: { ...EMOTIONS.sleepy, browRaise: 0.6, yaw: 0.5 } },
      { label: "facing 0.25", pose: { facing: 0.25 } },
      { label: "facing 0.35", pose: { facing: 0.35 } },
      { label: "facing 0.45, hand at chest", pose: { facing: 0.45, handRX: 8, handRY: -44 } },
    ],
  },
  // The lids at every stage of closing, and the pupil under them.
  eyes: {
    scale: 2.6,
    cell: [470, 470],
    cells: [
      { label: "rest", pose: {} },
      { label: "looking up", pose: { gazeY: -1 } },
      { label: "sleepy", pose: EMOTIONS.sleepy },
      { label: "sleepy, looking up", pose: { ...EMOTIONS.sleepy, gazeY: -1 } },
      { label: "half shut, looking aside", pose: { lidL: 0.5, lidR: 0.5, gazeX: 0.8 } },
      { label: "nearly shut", pose: { lidL: 0.86, lidR: 0.86 } },
      { label: "glare", pose: EMOTIONS.glare },
      { label: "smug", pose: { ...EMOTIONS.smug, gazeX: 0.6 } },
      { label: "sad", pose: EMOTIONS.sad },
      { label: "happy", pose: EMOTIONS.happy },
      { label: "scared", pose: EMOTIONS.scared },
      { label: "asleep", pose: EMOTIONS.asleep },
    ],
  },
  border: {
    scale: 2.1,
    cell: [470, 430],
    cells: [4.4, 1.5, 0, 4.4, 1.5, 0].map((border) => ({
      label: border ? `border ${border}` : "no border",
      pose: { ...EMOTIONS.curious, yaw: 0.35, gazeX: 0.5 },
      border,
    })),
  },
  actual: {
    scale: 0.8,
    cell: [150, 150],
    cells: EMOTION_NAMES.map((name) => ({ label: name, pose: EMOTIONS[name] })),
  },
  emotions: {
    scale: 1.25,
    cell: [250, 250],
    cells: EMOTION_NAMES.map((name) => ({ label: name, pose: EMOTIONS[name] })),
  },
  turns: {
    scale: 1.25,
    cell: [250, 250],
    cells: [
      ...[-1, -0.6, -0.3, 0, 0.3, 0.6, 1].map((v) => ({ label: `yaw ${v}`, pose: { yaw: v, gazeX: v } })),
      ...[-1, -0.5, 0.5, 1].map((v) => ({ label: `pitch ${v}`, pose: { pitch: v, gazeY: v } })),
      ...[-1, -0.6, -0.3, 0.3, 0.6, 1].map((v) => ({ label: `facing ${v}`, pose: { facing: v, yaw: v * 0.7, gazeX: v * 0.5 } })),
      { label: "gaze up-left", pose: { gazeX: -1, gazeY: -1 } },
      { label: "gaze down-right", pose: { gazeX: 1, gazeY: 1 } },
      { label: "tilt", pose: { tilt: 0.25, ...EMOTIONS.curious } },
      { label: "nightcap glare", pose: EMOTIONS.glare, setup: (p) => (p.hat = "nightcap") },
      { label: "bottlecap", pose: EMOTIONS.smug, setup: (p) => (p.hat = "bottlecap") },
      { label: "point right", pose: { handRX: 52, handRY: -62, pointR: 1, yaw: 0.5, gazeX: 0.8, lean: 0.12 } },
      { label: "point up-left", pose: { handLX: -40, handLY: -96, pointL: 1, yaw: -0.4, gazeX: -0.6, gazeY: -0.6 } },
      { label: "hands at chest", pose: { handLX: -8, handLY: -46, handRX: 8, handRY: -46 } },
      { label: "sitting", pose: { lift: -6, footLX: -13, footLY: 24, footRX: 13, footRY: 24, handLX: -29, handLY: -10, handRX: 29, handRY: -10 } },
      { label: "hands up", pose: { handLX: -34, handLY: -92, handRX: 34, handRY: -92, ...EMOTIONS.delighted } },
      { label: "squash", pose: { squash: 0.3 } },
      { label: "stretch", pose: { squash: -0.2 } },
    ],
  },
};

const name = window.SHEET ?? new URLSearchParams(location.search).get("set") ?? "emotions";
const set = SETS[name] ?? SETS.emotions;
const [cw, ch] = set.cell;
const cols = Math.max(1, Math.floor((window.innerWidth + 40) / cw));
const rows = Math.ceil(set.cells.length / cols);

const canvas = document.createElement("canvas");
canvas.width = cols * cw;
canvas.height = rows * ch;
document.body.appendChild(canvas);
const ctx = canvas.getContext("2d")!;

// Half light, half dark, to check the sticker reads on both.
ctx.fillStyle = "#86aee9";
ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.fillStyle = "#1d2330";
ctx.fillRect(0, Math.floor(rows / 2) * ch, canvas.width, canvas.height);

const painter = new StickerPainter(cw, ch);
set.cells.forEach((cell, i) => {
  const puppet = new Puppet();
  puppet.twitchy = false;
  puppet.target = applyPose(clonePose(REST), cell.pose);
  cell.setup?.(puppet);
  puppet.time = 3;
  puppet.settle(2);
  const x = (i % cols) * cw;
  const y = Math.floor(i / cols) * ch;
  painter.paint(
    ctx,
    x,
    y,
    (c) => {
      c.translate(cw / 2, ch - 34 * set.scale * 0.6 - 14);
      c.scale(set.scale, set.scale);
      puppet.draw(c);
    },
    { border: (cell.border ?? BORDER) * set.scale, shadow: true },
  );
  ctx.font = "600 13px system-ui";
  ctx.fillStyle = y >= Math.floor(rows / 2) * ch ? "#fff" : "#10203a";
  ctx.fillText(cell.label, x + 8, y + 18);
});
