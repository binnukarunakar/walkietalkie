import { describe, expect, it } from "vitest";
import {
  REPLAY_CAPACITY,
  REPLAY_MIN_DURATION_MS,
  TransmissionRecorder,
  appendReplay,
  type ChunkRecorder,
  type ReplayEntry,
} from "../src/lib/replay";

class FakeRecorder implements ChunkRecorder {
  readonly mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  started = false;
  stopped = false;

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
    // MediaRecorder flushes a final chunk before firing onstop.
    this.ondataavailable?.({ data: new Blob(["audio-bytes"]) });
    this.onstop?.();
  }
}

function makeRecorder(clock: { now: number }): {
  recorder: TransmissionRecorder;
  instances: FakeRecorder[];
} {
  const instances: FakeRecorder[] = [];
  const recorder = new TransmissionRecorder(
    () => {
      const fake = new FakeRecorder();
      instances.push(fake);
      return fake;
    },
    () => clock.now,
  );
  return { recorder, instances };
}

const STREAM = {} as MediaStream;

describe("TransmissionRecorder", () => {
  it("records a transmission into a replay entry", async () => {
    const clock = { now: 1_000 };
    const { recorder } = makeRecorder(clock);

    recorder.start(STREAM, "Bravo");
    expect(recorder.recording).toBe(true);

    clock.now = 4_500;
    const entry = await recorder.stop();
    expect(entry).not.toBeNull();
    expect(entry?.callsign).toBe("Bravo");
    expect(entry?.startedAt).toBe(1_000);
    expect(entry?.durationMs).toBe(3_500);
    expect(entry?.blob.size).toBeGreaterThan(0);
    expect(recorder.recording).toBe(false);
  });

  it("discards takes shorter than the minimum duration", async () => {
    const clock = { now: 0 };
    const { recorder } = makeRecorder(clock);

    recorder.start(STREAM, "Alpha");
    clock.now = REPLAY_MIN_DURATION_MS - 1;
    expect(await recorder.stop()).toBeNull();
  });

  it("stop without start resolves null", async () => {
    const { recorder } = makeRecorder({ now: 0 });
    expect(await recorder.stop()).toBeNull();
  });

  it("starting a new take discards the previous in-flight one", () => {
    const clock = { now: 0 };
    const { recorder, instances } = makeRecorder(clock);

    recorder.start(STREAM, "Alpha");
    recorder.start(STREAM, "Bravo");
    expect(instances).toHaveLength(2);
    expect(instances[0]?.stopped).toBe(true);
    expect(recorder.recording).toBe(true);
  });

  it("survives a recorder factory that throws", async () => {
    const recorder = new TransmissionRecorder(
      () => {
        throw new Error("MediaRecorder unsupported");
      },
      () => 0,
    );
    recorder.start(STREAM, "Alpha");
    expect(recorder.recording).toBe(false);
    expect(await recorder.stop()).toBeNull();
  });
});

describe("appendReplay", () => {
  function entry(id: number): ReplayEntry {
    return {
      id: `tx-${String(id)}`,
      callsign: "X",
      startedAt: id,
      durationMs: 1_000,
      blob: new Blob(["x"]),
      mimeType: "audio/webm",
    };
  }

  it("prepends newest first", () => {
    const list = appendReplay(appendReplay([], entry(1)), entry(2));
    expect(list.map((e) => e.id)).toEqual(["tx-2", "tx-1"]);
  });

  it("caps at capacity, dropping the oldest", () => {
    let list: ReplayEntry[] = [];
    for (let i = 1; i <= REPLAY_CAPACITY + 3; i += 1) {
      list = appendReplay(list, entry(i));
    }
    expect(list).toHaveLength(REPLAY_CAPACITY);
    expect(list[0]?.id).toBe(`tx-${String(REPLAY_CAPACITY + 3)}`);
    expect(list.at(-1)?.id).toBe("tx-4");
  });
});
