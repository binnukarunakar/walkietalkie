import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { radio } from "../lib/radio";
import { useSettings } from "../state/settings";

/**
 * Wires hold-to-talk: returns pointer handlers for the on-screen key and
 * binds the PTT key (configurable, default Space) globally while mounted.
 * The key is ignored when focus is in a text input. Multi-touch safe: the
 * transmission ends only when the LAST pointer lifts.
 */
export function usePushToTalk(): {
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
  onPointerCancel: (e: ReactPointerEvent) => void;
} {
  const heldByKey = useRef(false);
  const pointersDown = useRef<Set<number>>(new Set());
  const pttKey = useSettings((s) => s.pttKey);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== pttKey || e.repeat || isTypingTarget(e.target)) {
        return;
      }
      e.preventDefault();
      if (!heldByKey.current && pointersDown.current.size === 0) {
        heldByKey.current = true;
        radio.pressTalk();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== pttKey || !heldByKey.current) {
        return;
      }
      e.preventDefault();
      heldByKey.current = false;
      if (pointersDown.current.size === 0) {
        radio.releaseTalk();
      }
    };
    const onBlur = () => {
      if (heldByKey.current || pointersDown.current.size > 0) {
        heldByKey.current = false;
        pointersDown.current.clear();
        radio.releaseTalk();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [pttKey]);

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events (tests) and some browsers have no active pointer.
    }
    const wasIdle = pointersDown.current.size === 0;
    pointersDown.current.add(e.pointerId);
    if (wasIdle && !heldByKey.current) {
      radio.pressTalk();
    }
  }, []);

  const onPointerUp = useCallback((e: ReactPointerEvent) => {
    if (!pointersDown.current.delete(e.pointerId)) {
      return;
    }
    if (pointersDown.current.size === 0 && !heldByKey.current) {
      radio.releaseTalk();
    }
  }, []);

  return { onPointerDown, onPointerUp, onPointerCancel: onPointerUp };
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
