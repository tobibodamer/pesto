const ELS = [-30, -15, 0, 15, 30];
const AZ_MIN = -90;
const AZ_STEP = 3;
const AZ_COUNT = 61;
const TAPS = 256;

/**
 * Head-related impulse responses of a Neumann KU100 dummy head (SADIE II,
 * University of York), front hemisphere, 48 kHz. Packed by dev/hrir.py.
 * The grid is fine enough that the nearest measurement is used as is; nothing
 * is interpolated, which is what keeps the image from sounding phasey.
 */
export class Hrirs {
  private cache = new Map<number, AudioBuffer>();

  private constructor(
    private ctx: BaseAudioContext,
    private data: Int16Array,
  ) {}

  static async load(ctx: BaseAudioContext, url = "/hrir/ku100.bin"): Promise<Hrirs> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`hrir: ${res.status}`);
    return new Hrirs(ctx, new Int16Array(await res.arrayBuffer()));
  }

  /** Identifies the measurement nearest to a direction. Azimuth is positive to the right, degrees. */
  nearest(azimuth: number, elevation: number): number {
    const a = Math.round((Math.max(-90, Math.min(90, azimuth)) - AZ_MIN) / AZ_STEP);
    let e = 0;
    for (let i = 1; i < ELS.length; i++) if (Math.abs(ELS[i] - elevation) < Math.abs(ELS[e] - elevation)) e = i;
    return e * AZ_COUNT + a;
  }

  buffer(index: number): AudioBuffer {
    let buf = this.cache.get(index);
    if (!buf) {
      buf = this.ctx.createBuffer(2, TAPS, 48000);
      for (let ch = 0; ch < 2; ch++) {
        const out = buf.getChannelData(ch);
        const at = (index * 2 + ch) * TAPS;
        for (let i = 0; i < TAPS; i++) out[i] = this.data[at + i] / 32767;
      }
      this.cache.set(index, buf);
    }
    return buf;
  }
}
