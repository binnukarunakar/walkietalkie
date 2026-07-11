/**
 * Instant replay: each received transmission is captured with MediaRecorder
 * into an in-memory ring (client only — nothing ever leaves the browser).
 * The recorder is injectable so the ring semantics are unit-testable.
 */

export const REPLAY_CAPACITY = 10;
export const REPLAY_MIN_DURATION_MS = 200;
/** Ask the recorder to emit a chunk this often while recording. */
const CHUNK_INTERVAL_MS = 1000;

export interface ReplayEntry {
  id: string;
  callsign: string;
  /** Epoch ms when the transmission started. */
  startedAt: number;
  durationMs: number;
  blob: Blob;
  mimeType: string;
}

/** The slice of MediaRecorder we depend on. */
export interface ChunkRecorder {
  start(timesliceMs?: number): void;
  stop(): void;
  readonly mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
}

export type RecorderFactory = (stream: MediaStream) => ChunkRecorder;

function pickRecorderMimeType(): string | undefined {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c));
}

function defaultRecorderFactory(stream: MediaStream): ChunkRecorder {
  const mimeType = pickRecorderMimeType();
  const recorder = new MediaRecorder(stream, mimeType === undefined ? undefined : { mimeType });
  // Thin adapter: MediaRecorder's BlobEvent-typed handler properties are not
  // structurally assignable to the minimal ChunkRecorder shape.
  const adapter: ChunkRecorder = {
    start: (timesliceMs) => recorder.start(timesliceMs),
    stop: () => recorder.stop(),
    get mimeType() {
      return recorder.mimeType;
    },
    ondataavailable: null,
    onstop: null,
  };
  recorder.ondataavailable = (ev) => adapter.ondataavailable?.(ev);
  recorder.onstop = () => adapter.onstop?.();
  return adapter;
}

/**
 * Records one transmission at a time. `start` on floor grant to a remote
 * peer, `stop` on floor release; `stop` resolves the finished entry, or null
 * when the take was too short to be worth replaying.
 */
export class TransmissionRecorder {
  private recorder: ChunkRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private callsign = "";
  private seq = 0;

  constructor(
    private readonly factory: RecorderFactory = defaultRecorderFactory,
    private readonly now: () => number = Date.now,
  ) {}

  get recording(): boolean {
    return this.recorder !== null;
  }

  start(stream: MediaStream, callsign: string): void {
    this.discard();
    let recorder: ChunkRecorder;
    try {
      recorder = this.factory(stream);
    } catch {
      return; // MediaRecorder unavailable — replay is a nice-to-have, not a failure
    }
    // The handler closes over the array itself (not `this.chunks`) so the
    // final chunk MediaRecorder flushes between stop() and onstop still lands
    // in the take being finalized.
    const chunks: Blob[] = [];
    this.recorder = recorder;
    this.chunks = chunks;
    this.startedAt = this.now();
    this.callsign = callsign;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunks.push(e.data);
      }
    };
    try {
      recorder.start(CHUNK_INTERVAL_MS);
    } catch {
      this.recorder = null;
    }
  }

  stop(): Promise<ReplayEntry | null> {
    const recorder = this.recorder;
    if (recorder === null) {
      return Promise.resolve(null);
    }
    const { startedAt, callsign, chunks } = this;
    this.recorder = null;
    this.chunks = [];

    return new Promise((resolve) => {
      recorder.onstop = () => {
        const durationMs = this.now() - startedAt;
        if (durationMs < REPLAY_MIN_DURATION_MS || chunks.length === 0) {
          resolve(null);
          return;
        }
        this.seq += 1;
        resolve({
          id: `tx-${String(this.seq)}-${String(startedAt)}`,
          callsign,
          startedAt,
          durationMs,
          blob: new Blob(chunks, { type: recorder.mimeType }),
          mimeType: recorder.mimeType,
        });
      };
      try {
        recorder.stop();
      } catch {
        resolve(null);
      }
    });
  }

  /** Abort any in-flight recording without producing an entry. */
  discard(): void {
    const recorder = this.recorder;
    this.recorder = null;
    this.chunks = [];
    if (recorder !== null) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      try {
        recorder.stop();
      } catch {
        // already stopped
      }
    }
  }
}

/** Newest-first ring append with a hard capacity. */
export function appendReplay(
  list: readonly ReplayEntry[],
  entry: ReplayEntry,
  capacity: number = REPLAY_CAPACITY,
): ReplayEntry[] {
  return [entry, ...list].slice(0, capacity);
}
