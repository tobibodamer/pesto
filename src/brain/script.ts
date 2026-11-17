/**
 * The performance script: what the big model writes when Pesto acts.
 *
 * It is plain speech with stage directions mixed in, so one streamed reply
 * carries talking, moving and showing in the order they should happen:
 *
 *   <emote as="smug"/> Oh, we're doing this again? <go to="w2"/> Cool.
 *   Cool cool cool. <point at="cursor"/> That. Right there.
 *   <sign>23 min.</sign>
 *
 * - Bare text is spoken.
 * - `<name attr="value"/>` is a stage direction.
 * - `<sign>…</sign>` and `<note>…</note>` carry text he shows instead of says;
 *   `<agent>…</agent>`, `<reply>…</reply>` and `<timer>…</timer>` carry what he passes on.
 * Anything the parser does not recognise is dropped, never spoken.
 */

export type ScriptItem =
  | { kind: "say"; text: string }
  | { kind: "do"; name: string; attrs: Record<string, string>; body?: string };

/** Tags whose content is shown, not spoken. */
const BLOCKS = new Set(["sign", "note", "agent", "reply", "timer"]);

const ATTR = /([a-zA-Z_][\w-]*)\s*=\s*"([^"]*)"/g;
/** A sentence end followed by whitespace: a good place to hand speech to the voice. */
const SENTENCE = /([.!?…]["')\]]?)\s+/;

function parseTag(raw: string): { name: string; attrs: Record<string, string>; closing: boolean; selfClosing: boolean } | null {
  const m = /^<\s*(\/)?\s*([a-zA-Z][\w-]*)([^>]*)>$/.exec(raw);
  if (!m) return null;
  const attrs: Record<string, string> = {};
  for (const a of m[3].matchAll(ATTR)) attrs[a[1]] = a[2];
  return { name: m[2].toLowerCase(), attrs, closing: !!m[1], selfClosing: /\/\s*>$/.test(raw) };
}

/**
 * Incremental parser. Feed it text as it streams in; it calls `emit` for
 * each item as soon as it is complete, so the first sentence can be spoken
 * while the rest is still being written.
 */
export class ScriptParser {
  private buffer = "";
  private speech = "";
  private block: { name: string; attrs: Record<string, string>; text: string } | null = null;

  constructor(private emit: (item: ScriptItem) => void) {}

  feed(chunk: string) {
    this.buffer += chunk;
    this.drain(false);
  }

  /** Call when the stream ends, to flush whatever is left. */
  end() {
    this.drain(true);
    this.flushSpeech();
    if (this.block) {
      this.emit({ kind: "do", name: this.block.name, attrs: this.block.attrs, body: this.block.text.trim() });
      this.block = null;
    }
  }

  private drain(final: boolean) {
    for (;;) {
      const lt = this.buffer.indexOf("<");
      if (lt < 0) {
        this.text(this.buffer);
        this.buffer = "";
        break;
      }
      this.text(this.buffer.slice(0, lt));
      this.buffer = this.buffer.slice(lt);
      const gt = this.buffer.indexOf(">");
      if (gt < 0) {
        // Either a tag still arriving, or a stray "<" in ordinary speech.
        if (final || this.buffer.length > 200 || /^<[^a-zA-Z/]/.test(this.buffer)) {
          this.text(this.buffer[0]);
          this.buffer = this.buffer.slice(1);
          continue;
        }
        break;
      }
      const raw = this.buffer.slice(0, gt + 1);
      this.buffer = this.buffer.slice(gt + 1);
      const tag = parseTag(raw);
      if (!tag) continue;
      this.tag(tag);
    }
    if (!this.block) this.splitSentences();
  }

  private text(s: string) {
    if (!s) return;
    if (this.block) this.block.text += s;
    else this.speech += s;
  }

  private tag(tag: NonNullable<ReturnType<typeof parseTag>>) {
    if (this.block) {
      if (tag.closing && tag.name === this.block.name) {
        this.emit({ kind: "do", name: this.block.name, attrs: this.block.attrs, body: this.block.text.trim() });
        this.block = null;
      }
      return;
    }
    if (tag.closing) return;
    // A direction ends the sentence in progress: it happens between words.
    this.flushSpeech();
    if (BLOCKS.has(tag.name) && !tag.selfClosing) this.block = { name: tag.name, attrs: tag.attrs, text: "" };
    else this.emit({ kind: "do", name: tag.name, attrs: tag.attrs });
  }

  private splitSentences() {
    for (;;) {
      const m = SENTENCE.exec(this.speech);
      if (!m) break;
      const end = m.index + m[1].length;
      const sentence = this.speech.slice(0, end);
      this.speech = this.speech.slice(m.index + m[0].length);
      this.say(sentence);
    }
  }

  private flushSpeech() {
    this.say(this.speech);
    this.speech = "";
  }

  private say(text: string) {
    // Models reach for markdown emphasis no matter what; it must not be read out or shown.
    const clean = text.replace(/[*_`#]+/g, "").replace(/\s+/g, " ").trim();
    if (clean) this.emit({ kind: "say", text: clean });
  }
}

/** Parses a complete script in one go. */
export function parseScript(text: string): ScriptItem[] {
  const items: ScriptItem[] = [];
  const parser = new ScriptParser((item) => items.push(item));
  parser.feed(text);
  parser.end();
  return items;
}
