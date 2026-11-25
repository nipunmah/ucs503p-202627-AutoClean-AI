import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent } from "react";

/** Deliberately subtle: a hint of depth, not a gimmick. */
const MAX_TILT_DEG = 2.5;

const reducedMotionQuery =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

/**
 * Pointer-driven 3D tilt for a card element. Plain pointer math, no extra
 * dependency, and cheap:
 * - only reacts to a real mouse (touch/pen never tilt, so scrolling on a
 *   phone can't jitter cards),
 * - does nothing under `prefers-reduced-motion: reduce` (checked live),
 * - writes the transform at most once per animation frame, directly to the
 *   element's style, so it never causes a React re-render.
 */
export function useTilt<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const frame = useRef(0);

  const reset = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const el = ref.current;
    if (el) el.style.transform = "";
  }, []);

  const onPointerMove = useCallback((e: PointerEvent<T>) => {
    if (e.pointerType !== "mouse" || reducedMotionQuery?.matches) return;
    const el = ref.current;
    if (!el) return;
    const { clientX, clientY } = e;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const px = (clientX - rect.left) / rect.width; // 0..1
      const py = (clientY - rect.top) / rect.height; // 0..1
      const rotateY = (px - 0.5) * 2 * MAX_TILT_DEG;
      const rotateX = (0.5 - py) * 2 * MAX_TILT_DEG;
      el.style.transform = `perspective(900px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg)`;
    });
  }, []);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  return { ref, onPointerMove, onPointerLeave: reset };
}
