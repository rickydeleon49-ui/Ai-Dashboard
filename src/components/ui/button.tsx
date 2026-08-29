import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg" | "icon";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] shadow-sm border border-transparent",
  secondary:
    "bg-[var(--bg-subtle)] text-fg border border-line hover:bg-[var(--bg-hover)] hover:border-[var(--border-strong)]",
  outline:
    "bg-transparent text-fg border border-line hover:bg-[var(--bg-subtle)] hover:border-[var(--border-strong)]",
  ghost: "bg-transparent text-muted border border-transparent hover:bg-[var(--bg-subtle)] hover:text-fg",
  danger:
    "bg-transparent text-red-400 border border-red-500/25 hover:bg-red-500/10 hover:border-red-500/40",
};

const SIZES: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[13px] gap-1.5 rounded-md",
  md: "h-8 px-3 text-[13px] gap-1.5 rounded-md",
  lg: "h-9.5 px-4 text-sm gap-2 rounded-lg",
  icon: "h-8 w-8 justify-center rounded-md",
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const buttonClasses = (variant: Variant = "secondary", size: Size = "md") =>
  cn(
    "inline-flex items-center font-medium whitespace-nowrap transition-colors duration-150",
    "disabled:opacity-50 disabled:pointer-events-none select-none",
    VARIANTS[variant],
    SIZES[size],
  );

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button({ className, variant = "secondary", size = "md", ...props }, ref) {
    return (
      <button
        ref={ref}
        className={cn(buttonClasses(variant, size), className)}
        {...props}
      />
    );
  },
);
