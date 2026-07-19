import { useEffect, useRef, type JSX } from "react";
import { useReducedMotion } from "framer-motion";
import { radio } from "../lib/radio";
import { useRadioStore } from "../state/store";

const BAR_COUNT = 14;
/** Per-bar decay per frame — higher bars fall a touch faster (waterfall feel). */
const DECAY = 0.82;

/**
 * Live audio meter driven by the real WebAudio graph: your mic while
 * transmitting, the incoming voice bus while receiving. Motion that
 * communicates — "am I being heard" / "is audio actually flowing" — and the
 * per-frame work is transform-only (scaleY on compositor).
 * Under prefers-reduced-motion it renders a static level readout instead.
 */
export function SignalMeter(): JSX.Element | null {
  const transmitting = useRadioStore((s) => s.transmitting);
  const floorHolder = useRadioStore((s) => s.floorHolder);
  const selfId = useRadioStore((s) => s.selfId);
  const reduced = useReducedMotion() ?? false;
  const barsRef = useRef<HTMLDivElement>(null);
  const levelsRef = useRef<number[]>(Array.from({ length: BAR_COUNT }, () => 0));

  const receiving = floorHolder !== null && floorHolder !== selfId;
  const active = transmitting || receiving;
  const source: "mic" | "receive" = transmitting ? "mic" : "receive";

  useEffect(() => {
    const bars = barsRef.current;
    if (bars === null || !active || reduced) {
      return;
    }
    let frame = 0;
    const tick = (): void => {
      const level = radio.meterLevel(source);
      const levels = levelsRef.current;
      for (let i = 0; i < BAR_COUNT; i += 1) {
        // Center bars respond to lower levels than edge bars — classic VU fan.
        const threshold = Math.abs(i - (BAR_COUNT - 1) / 2) / (BAR_COUNT / 2);
        const target = level > threshold * 0.85 ? level : 0;
        levels[i] = Math.max(target, (levels[i] ?? 0) * DECAY);
        const bar = bars.children[i];
        if (bar instanceof HTMLElement) {
          bar.style.transform = `scaleY(${String(Math.max(0.12, levels[i] ?? 0))})`;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      for (const bar of bars.children) {
        if (bar instanceof HTMLElement) {
          bar.style.transform = "scaleY(0.12)";
        }
      }
      levelsRef.current = levelsRef.current.map(() => 0);
    };
  }, [active, source, reduced]);

  return (
    <div
      className="signal-meter"
      data-active={active}
      data-source={transmitting ? "mic" : "receive"}
      aria-hidden="true"
    >
      <div className="signal-bars" ref={barsRef}>
        {Array.from({ length: BAR_COUNT }, (_, i) => (
          <span key={i} className="signal-bar" />
        ))}
      </div>
    </div>
  );
}
