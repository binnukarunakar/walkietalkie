/**
 * Real FRS (Family Radio Service) channel plan. Channels 1-22, frequency in
 * MHz. Channels 8-14 are the 467 MHz interstitials, the rest 462 MHz.
 * Displayed in the UI to give rooms the feel of a real handheld.
 */
export const FRS_CHANNELS: ReadonlyMap<number, number> = new Map([
  [1, 462.5625],
  [2, 462.5875],
  [3, 462.6125],
  [4, 462.6375],
  [5, 462.6625],
  [6, 462.6875],
  [7, 462.7125],
  [8, 467.5625],
  [9, 467.5875],
  [10, 467.6125],
  [11, 467.6375],
  [12, 467.6625],
  [13, 467.6875],
  [14, 467.7125],
  [15, 462.55],
  [16, 462.575],
  [17, 462.6],
  [18, 462.625],
  [19, 462.65],
  [20, 462.675],
  [21, 462.7],
  [22, 462.725],
]);

export const CHANNEL_MIN = 1;
export const CHANNEL_MAX = 22;

/** CTCSS-style privacy codes. 0 = open (no code). */
export const CODE_MIN = 0;
export const CODE_MAX = 38;

export function frequencyLabel(channel: number): string {
  const mhz = FRS_CHANNELS.get(channel);
  return mhz === undefined ? `CH ${channel}` : `${mhz.toFixed(4)} MHz`;
}

/** Canonical room key for a (channel, privacy code) pair. */
export function roomKey(channel: number, code: number): string {
  return `${channel}:${code}`;
}
