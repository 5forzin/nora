"use client";

import { useEffect, useState } from "react";
import { TotvsSymbol } from "./totvs-symbol";

type Variant = "brand" | "paper";

type Props = {
  /** Total logo height in pixels (default 28). */
  size?: number;
  /** Shows the Nora wordmark next to the symbol (default true). */
  showWordmark?: boolean;
  /** "brand" uses ink on a light background; "paper" uses canvas on a dark background. */
  variant?: Variant;
  /** Fades in on mount without changing the symbol's shape. */
  animate?: boolean;
  className?: string;
};

export function NoraLogo({
  size = 28,
  showWordmark = true,
  variant = "brand",
  animate = true,
  className = "",
}: Props) {
  const [mounted, setMounted] = useState(!animate);

  useEffect(() => {
    if (!animate) return;
    const t = setTimeout(() => setMounted(true), 60);
    return () => clearTimeout(t);
  }, [animate]);

  return (
    <span
      className={`inline-flex items-center ${className}`}
      style={{
        height: size,
        gap: Math.round(size * 0.4),
        color: variant === "paper" ? "var(--canvas)" : "var(--ink)",
        opacity: !animate || mounted ? 1 : 0,
        transition: animate ? "opacity 0.3s ease" : undefined,
      }}
      aria-label="Nora"
      role="img"
    >
      <TotvsSymbol size={size} />
      {showWordmark && (
        <span
          style={{
            fontFamily: "var(--font-sans), system-ui, sans-serif",
            fontWeight: 600,
            fontSize: Math.round(size * 0.95),
            letterSpacing: "-0.01em",
            lineHeight: 1,
          }}
        >
          Nora
        </span>
      )}
    </span>
  );
}
