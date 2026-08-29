import * as React from "react";
import { cn } from "@/lib/utils";

const CONTROL =
  "w-full rounded-md border border-line bg-[var(--bg-subtle)] px-2.5 py-1.5 text-[13px] text-fg " +
  "placeholder:text-faint transition-colors " +
  "hover:border-[var(--border-strong)] focus:border-[var(--accent)] focus:outline-none " +
  "focus:ring-2 focus:ring-[var(--accent-soft)] disabled:opacity-50";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(CONTROL, "h-8", className)} {...props} />;
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(CONTROL, "min-h-20 resize-y leading-relaxed", className)}
      {...props}
    />
  );
});

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cn(CONTROL, "h-8 cursor-pointer appearance-none pr-7", className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238b8d98' stroke-width='2.5' stroke-linecap='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 8px center",
      }}
      {...props}
    >
      {children}
    </select>
  );
});

export function Label({
  className,
  children,
  hint,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement> & { hint?: string }) {
  return (
    <label className={cn("block space-y-1.5", className)} {...props}>
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-muted">{children}</span>
        {hint ? <span className="text-[11px] text-faint">{hint}</span> : null}
      </span>
    </label>
  );
}

/** Label + control + optional help/error text, stacked. */
export function Field({
  label,
  hint,
  help,
  error,
  children,
  className,
}: {
  label: string;
  hint?: string;
  help?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-muted">{label}</span>
        {hint ? <span className="text-[11px] text-faint">{hint}</span> : null}
      </div>
      {children}
      {error ? (
        <p className="text-[11px] text-red-400">{error}</p>
      ) : help ? (
        <p className="text-[11px] text-faint">{help}</p>
      ) : null}
    </div>
  );
}
