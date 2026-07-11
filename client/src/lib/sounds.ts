/**
 * Radio sound design, fully synthesized in WebAudio — no audio asset files
 * (project hard rule). Every effect is a short oscillator/noise envelope
 * scheduled against the shared AudioContext and routed to the sfx output the
 * AudioGraph provides, so effects bypass the radio-voice filter chain.
 */

/** Short enveloped tone. Returns when scheduled, not when done. */
function blip(
  ctx: BaseAudioContext,
  out: AudioNode,
  type: OscillatorType,
  freqHz: number,
  at: number,
  durationS: number,
  peak: number,
): void {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = freqHz;

  const gain = ctx.createGain();
  const attackEnd = at + 0.008;
  const sustainEnd = Math.max(attackEnd, at + durationS - 0.015);
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(peak, attackEnd);
  gain.gain.setValueAtTime(peak, sustainEnd);
  gain.gain.linearRampToValueAtTime(0.0001, at + durationS);

  osc.connect(gain);
  gain.connect(out);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
  osc.start(at);
  osc.stop(at + durationS + 0.01);
}

function noiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

/** Rising two-blip chirp: "you have the floor, talk now". */
export function playTalkChirp(ctx: BaseAudioContext, out: AudioNode): void {
  const t = ctx.currentTime;
  blip(ctx, out, "sine", 523, t, 0.06, 0.18);
  blip(ctx, out, "sine", 880, t + 0.07, 0.08, 0.18);
}

/** Classic descending roger beep, heard when a received transmission ends. */
export function playRogerBeep(ctx: BaseAudioContext, out: AudioNode): void {
  const t = ctx.currentTime;
  blip(ctx, out, "square", 1046, t, 0.07, 0.07);
  blip(ctx, out, "square", 784, t + 0.08, 0.09, 0.07);
}

/** Low double bonk: floor denied, someone else is transmitting. */
export function playBusyBonk(ctx: BaseAudioContext, out: AudioNode): void {
  const t = ctx.currentTime;
  blip(ctx, out, "square", 233, t, 0.12, 0.12);
  blip(ctx, out, "square", 196, t + 0.14, 0.16, 0.12);
}

/** ~90 ms band-limited static burst — the squelch closing after a transmission. */
export function playSquelchTail(ctx: BaseAudioContext, out: AudioNode): void {
  const durationS = 0.09;
  const t = ctx.currentTime;

  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, durationS);

  const bandpass = ctx.createBiquadFilter();
  bandpass.type = "bandpass";
  bandpass.frequency.value = 1800;
  bandpass.Q.value = 0.7;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.2, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + durationS);

  src.connect(bandpass);
  bandpass.connect(gain);
  gain.connect(out);
  src.onended = () => {
    src.disconnect();
    bandpass.disconnect();
    gain.disconnect();
  };
  src.start(t);
  src.stop(t + durationS);
}
