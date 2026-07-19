import type { Transition, Variants } from "framer-motion";

/**
 * The app's single motion vocabulary. Every animated component draws from
 * here so durations, easings, and distances stay one system (ui-craft), and
 * every entry answers "what does this communicate?" (impeccable-taste):
 *   rise      — content appeared
 *   listItem  — an entry joined/left a live collection
 *   shake     — request rejected
 *   press     — physical key feedback
 * Framer Motion respects prefers-reduced-motion globally via MotionConfig
 * in main.tsx — no per-component gating needed.
 */

/** Snappy ease-out — the emikowalski curve. */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

export const transitions = {
  fast: { duration: 0.15, ease: EASE_OUT } satisfies Transition,
  base: { duration: 0.25, ease: EASE_OUT } satisfies Transition,
  spring: { type: "spring", stiffness: 500, damping: 32 } satisfies Transition,
} as const;

/** Screen/section entrance: fade + 8px rise. */
export const rise: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { ...transitions.base, staggerChildren: 0.04, delayChildren: 0.05 },
  },
  exit: { opacity: 0, transition: transitions.fast },
};

/** Child of a `rise` parent — inherits the stagger. */
export const riseChild: Variants = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: transitions.base },
};

/** Live-collection rows (roster, transmission log). */
export const listItem: Variants = {
  hidden: { opacity: 0, x: -6 },
  visible: { opacity: 1, x: 0, transition: transitions.base },
  exit: { opacity: 0, x: 6, transition: transitions.fast },
};

/** Denied/rejected: a short lateral shake, the classic "no". */
export const shake: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    x: [0, -5, 5, -3, 3, 0],
    transition: { duration: 0.35, ease: "easeOut" },
  },
  exit: { opacity: 0, transition: transitions.fast },
};

/** PTT key press feedback. */
export const pressScale = { scale: 0.97 } as const;
