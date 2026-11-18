import type { ListenMove } from "../../pesto/listening";
import type { Emotion } from "../../pesto/pose";
import type { ReactionName } from "../director";
import type { JournalEntry } from "../journal";

/** What is going on when he decides what to do about it. */
export interface Scene {
  out: boolean;
  sitting: boolean;
  /** Music or a video is playing and can be heard. */
  playing: boolean;
  /** The event that brought this on, or null at a check-in with nothing new. */
  trigger: JournalEntry | null;
  /** The regular check-in while they are at the keyboard. */
  checkIn: boolean;
  /** Seconds since he last spoke, Infinity if he has not. */
  spokeAgo: number;
  /** What he can do from where he is, each with what it is for. */
  reactions: Partial<Record<ReactionName | "none", string>>;
}

export interface Verdict {
  reaction: ReactionName | "none";
  feeling: Emotion | null;
  /** Whether this is worth waking the mind to say something. */
  speak: boolean;
  /** How likely it is, 0..1, that they are procrastinating. Null when this backend cannot tell. */
  slacking: number | null;
}

/** What he was doing when they said his name. */
export interface CallScene {
  asleep: boolean;
  hidden: boolean;
  busy: boolean;
  mood: Emotion;
  spokeAgo: number;
  hour: number;
}

export interface Taken {
  sound: string | null;
  feeling: Emotion | null;
}

/** Something that makes his quick, wordless decisions. */
export interface Backend {
  /** How the debug trace names it. */
  readonly label: string;
  react(scene: Scene): Promise<Verdict>;
  /** The sound he makes, if any, and his face, when called by name. */
  called(scene: CallScene): Promise<Taken>;
  /** A key of ASIDES to show while they are still talking, or null to keep listening. */
  aside(soFar: string, last: string | null): Promise<string | null>;
  /** How likely, 0..1, a reply without his name was meant for him. Null leaves it to the word and time rules. */
  replying(heard: string, hisLast: string): Promise<number | null>;
}

export const FEELINGS: Partial<Record<Emotion, string>> = {
  neutral: "nothing in particular",
  curious: "interested, wants to know more",
  happy: "glad about what is happening",
  smug: "amused at the person's expense, told-you-so",
  annoyed: "disapproving of what the person is doing",
  grumpy: "properly fed up",
  surprised: "caught off guard",
  sad: "let down or ignored",
  sleepy: "it is late and he is tired",
  unsure: "does not know what to make of it",
};

export type Aside = { describe: string; move?: ListenMove; emotion?: Emotion; seconds?: number };

/**
 * What he can do while someone is still talking to him, without interrupting
 * them: a face, a small movement, or both. All of it is silent. Each says
 * what kind of sentence brings it on and then what he does, in that order
 * and without hedging: the model sorts what was said far more surely than it
 * judges whether he would react, and how sure it has to be is decided here.
 */
export const ASIDES: Record<string, Aside> = {
  none: { describe: "An ordinary request, question, greeting or remark, so he just keeps listening." },
  nod: { describe: "They explain their reasons or make a fair point, so he nods.", move: "nod" },
  intrigued: { describe: "Food, a treat or a secret, so he leans in.", move: "lean", emotion: "curious" },
  puzzled: { describe: "Confusing or self-contradicting, so he tilts his head.", move: "puzzle", emotion: "unsure", seconds: 2.5 },
  pondering: { describe: "A riddle or a hard question for him, so he looks up, thinking.", emotion: "thinking", seconds: 3 },
  attentive: { describe: "Exact codes, numbers or steps to remember, so he concentrates.", emotion: "focused", seconds: 3.5 },
  overwhelmed: { describe: "A flood of jargon or tangled technical detail, so his head spins.", emotion: "dizzy", seconds: 3 },
  amused: { describe: "A funny thing that happened, so he grins.", emotion: "happy", seconds: 2.5 },
  content: { describe: "They say they like him, so he settles, pleased.", emotion: "pleased", seconds: 3 },
  delighted: { describe: "Really good news, so he lights up.", emotion: "delighted", seconds: 2.5 },
  proud: { describe: "Praise or thanks for him, so he preens.", emotion: "proud", seconds: 3 },
  smug: { describe: "They admit he was right or that they made a silly mistake, so he smirks.", emotion: "smug", seconds: 3 },
  deadpan: { describe: "A worn-out joke or a bad pun, so he stares blankly.", emotion: "neutral", seconds: 2.5 },
  sorry: { describe: "Sad news, a loss or a death, so his ears droop.", emotion: "sad", seconds: 4 },
  wincing: { describe: "They hurt themselves, or something gross, so he winces.", emotion: "strained", seconds: 2.5 },
  alarmed: { describe: "Sudden danger, a disaster or an accident, so he pulls back, wide-eyed.", move: "recoil", emotion: "surprised", seconds: 2 },
  worried: { describe: "They are in trouble or afraid of what is coming, so he looks anxious.", emotion: "scared", seconds: 3 },
  disapproving: { describe: "A plan that is clearly a bad idea, so he shakes his head.", move: "shake", emotion: "annoyed", seconds: 2.5 },
  offended: { describe: "An insult to him, his can or raccoons, so he glares.", emotion: "glare", seconds: 3 },
  grumpy: { describe: "Nagging, or a chore for him, so he scowls.", emotion: "grumpy", seconds: 3 },
  guilty: { describe: "They accuse him of doing or breaking something, so he looks caught out.", emotion: "guilty", seconds: 3.5 },
  bored: { describe: "Rambling about something dull, so his eyelids sag.", emotion: "sleepy", seconds: 3.5 },
  dozing: { describe: "Endless tedious droning, so he nods off.", emotion: "asleep", seconds: 2 },
};

/** Picks a key at random in proportion to its weight. */
export function weighted<T extends string>(weights: Partial<Record<T, number>>, rand: () => number): T | null {
  const entries = Object.entries(weights).filter(([, w]) => (w as number) > 0) as [T, number][];
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return null;
  let r = rand() * total;
  for (const [k, w] of entries) if ((r -= w) < 0) return k;
  return entries[entries.length - 1][0];
}
