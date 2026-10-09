"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Reveal-on-scroll wrapper.
 *
 * The landing page's motion is deliberately tiny: content fades in and lifts a
 * few pixels as it enters the viewport (the same treatment the reference design
 * uses). It is driven by IntersectionObserver rather than a scroll listener, and
 * it resolves to "visible" immediately when the visitor prefers reduced motion —
 * or when the observer is unavailable — so content can never get stuck hidden.
 */
export function Reveal({
  children,
  delay = 0,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  /** Stagger in milliseconds. */
  delay?: number;
  className?: string;
  as?: "div" | "section" | "li";
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    if (
      typeof IntersectionObserver === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      // Nothing to observe: show the content on the next frame. (CSS already
      // shows it for reduced motion, so this is only for old browsers.)
      const frame = window.requestAnimationFrame(() => setVisible(true));
      return () => window.cancelAnimationFrame(frame);
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.disconnect();
            return;
          }
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.1 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <Tag
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- one ref type for three tags
      ref={ref as any}
      className={cn("landing-reveal", className)}
      data-visible={visible ? "true" : "false"}
      style={delay > 0 ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </Tag>
  );
}
