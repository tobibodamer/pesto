import type { Config } from "../config";
import { http } from "../net";
import type { Vec } from "../pesto/math";
import type { Rect } from "../sense/types";
import { Hrirs } from "./hrir";
import { seenFromChair, Spatializer } from "./space";
import { SilentVoice, spokenText, type Line, type Utterance, type Voice } from "./voice";

const API = "https://api.elevenlabs.io/v1";

/**
 * Pesto's real voice: ElevenLabs speech, rendered binaurally from wherever
 * he is on the screens. Each line is synthesised as soon as it is prepared,
 * so it is usually ready before the previous one has finished.
 */
export class ElevenVoice implements Voice {
  readonly audible = true;

  private ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
  private master: GainNode;
  private space: Spatializer | null = null;
  private throat: AudioNode;
  private ready: Promise<void>;
  private sounds = new Map<string, Promise<AudioBuffer | null>>();
  private previous = "";
  private fallback = new SilentVoice();
  private waiting: (() => Promise<unknown>)[] = [];
  private running = 0;

  constructor(
    private config: Config,
    /** The monitor the listener sits in front of. */
    private screen: () => Rect | null,
  ) {
    this.master = this.ctx.createGain();
    this.master.gain.value = config.voice.volume;
    // Catches the rare peak when speech, a sound and the room pile up.
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 4;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    this.master.connect(limiter).connect(this.ctx.destination);

    const small = smallBody(this.ctx);
    this.throat = small.input;

    this.ready = Hrirs.load(this.ctx).then((hrirs) => {
      this.space = new Spatializer(this.ctx, hrirs, this.master);
      small.output.connect(this.space.input);
    });
    this.ready.catch((err) => console.error("voice:", err));
  }

  prepare(text: string): Line {
    const audio = this.queued(() => this.synthesise(text)).catch((err) => {
      console.warn("voice:", err);
      return null;
    });
    let discarded = false;
    return {
      discard: () => {
        discarded = true;
      },
      play: () => this.play(text, audio, () => discarded),
    };
  }

  cue(name: string) {
    let sound = this.sounds.get(name);
    if (!sound) {
      sound = fetch(`/sfx/${name}.mp3`)
        .then((r) => (r.ok && r.headers.get("content-type")?.includes("audio") ? r.arrayBuffer() : null))
        .then((data) => (data ? this.ctx.decodeAudioData(data) : null))
        .catch(() => null);
      this.sounds.set(name, sound);
    }
    void sound.then((buffer) => {
      if (!buffer || !this.space) return;
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = 0.94 + Math.random() * 0.12;
      const level = this.ctx.createGain();
      level.gain.value = 0.5;
      source.connect(level).connect(this.space.input);
      source.start();
    });
  }

  place(where: Vec, muffled: boolean) {
    if (!this.space) return;
    const seen = seenFromChair(where, this.screen());
    this.space.aim(seen.azimuth, seen.elevation, seen.metres, muffled);
  }

  /** Runs at most two requests at a time, in order: the account allows only a few at once. */
  private queued<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.push(() => job().then(resolve, reject));
      this.pump();
    });
  }

  private pump() {
    while (this.running < 2 && this.waiting.length) {
      this.running++;
      void this.waiting.shift()!().finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async synthesise(text: string): Promise<AudioBuffer> {
    const { voice } = this.config;
    const context = this.previous;
    this.previous = spokenText(text).slice(-100);
    const res = await http(`${API}/text-to-speech/${voice.voiceId}/stream?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": voice.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: voice.model,
        voice_settings: { stability: voice.stability, similarity_boost: 0.75 },
        ...(context ? { previous_text: context } : {}),
      }),
    });
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
    return this.ctx.decodeAudioData(await res.arrayBuffer());
  }

  private play(text: string, audio: Promise<AudioBuffer | null>, discarded: () => boolean): Utterance {
    let source: AudioBufferSourceNode | null = null;
    let gain: GainNode | null = null;
    let analyser: AnalyserNode | null = null;
    let silent: Utterance | null = null;
    let stopped = false;
    let begin!: () => void;
    let end!: () => void;
    const started = new Promise<void>((r) => (begin = r));
    const finished = new Promise<void>((r) => (end = r));
    const samples = new Float32Array(512);

    void (async () => {
      const [buffer] = await Promise.all([audio, this.ready.catch(() => {})]);
      if (stopped || discarded()) return void (begin(), end());
      if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
      if (!buffer || !this.space || this.ctx.state !== "running") {
        // No sound to give: keep the performance in time anyway.
        silent = this.fallback.prepare(text).play();
        begin();
        return void silent.finished.then(end);
      }
      source = this.ctx.createBufferSource();
      source.buffer = buffer;
      gain = this.ctx.createGain();
      analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(gain).connect(this.throat);
      source.connect(analyser);
      source.onended = end;
      source.start();
      begin();
    })();

    return {
      started,
      finished,
      level: () => {
        if (silent) return silent.level();
        if (!analyser) return 0;
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const s of samples) sum += s * s;
        return Math.min(1, Math.sqrt(sum / samples.length) * 7);
      },
      stop: () => {
        stopped = true;
        silent?.stop();
        if (source && gain) {
          const t = this.ctx.currentTime;
          gain.gain.setValueAtTime(1, t);
          gain.gain.linearRampToValueAtTime(0, t + 0.04);
          source.stop(t + 0.05);
        } else end();
      },
    };
  }
}

/**
 * Takes the studio out of a synthesised voice and the size out of the
 * speaker: no chest, a nasal middle, a hard little edge and no air on top.
 * What is left sounds like it comes from a body the size of a cat.
 */
export function smallBody(ctx: BaseAudioContext): { input: AudioNode; output: AudioNode } {
  const stages: [BiquadFilterType, number, number, number][] = [
    ["highpass", 360, 0.8, 0],
    ["highpass", 240, 0.6, 0],
    ["lowshelf", 700, 0, -5],
    ["peaking", 1250, 1.2, 3],
    ["peaking", 3100, 1.0, 5],
    ["lowpass", 7800, 0.6, 0],
  ];
  const nodes = stages.map(([type, hz, q, db]) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = hz;
    f.Q.value = q;
    f.gain.value = db;
    return f;
  });
  for (let i = 1; i < nodes.length; i++) nodes[i - 1].connect(nodes[i]);
  const makeup = ctx.createGain();
  makeup.gain.value = 1.05;
  nodes[nodes.length - 1].connect(makeup);
  return { input: nodes[0], output: makeup };
}
