/**
 * Small, mobile-first UI kit. Server-component safe (no hooks here); client
 * pieces live in ./ui-client.tsx.
 */
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { twMerge } from "tailwind-merge";

/**
 * Join class names; later Tailwind classes win over conflicting earlier ones
 * (e.g. cx("w-full", "w-28") → "w-28"), so callers can override kit defaults.
 */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return twMerge(parts.filter(Boolean).join(" "));
}

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("mx-auto w-full max-w-xl px-4 pb-28 pt-4", className)}>{children}</div>;
}

export function PageHeader({ title, subtitle, action }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-bold leading-tight">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function Card({ children, className, ...rest }: ComponentProps<"section">) {
  return (
    <section className={cx("lf-card rounded-2xl border border-line bg-surface p-4 shadow-sm", className)} {...rest}>
      {children}
    </section>
  );
}

export function CardTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="lf-card-title text-sm font-semibold uppercase tracking-wide text-muted">{children}</h2>
      {action}
    </div>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
const buttonBase =
  "lf-btn inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";
const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-brand text-brand-ink hover:opacity-90",
  secondary: "border border-line bg-surface text-ink hover:bg-surface-2",
  ghost: "text-brand hover:bg-brand-soft",
  danger: "bg-neg text-brand-ink hover:opacity-90",
};

export function buttonClass(variant: ButtonVariant = "primary", extra?: string): string {
  return cx(buttonBase, buttonVariants[variant], extra);
}

export function Button({ variant = "primary", className, ...rest }: ComponentProps<"button"> & { variant?: ButtonVariant }) {
  return <button className={buttonClass(variant, className)} {...rest} />;
}

export function LinkButton({
  variant = "primary",
  className,
  ...rest
}: ComponentProps<typeof Link> & { variant?: ButtonVariant }) {
  return <Link className={buttonClass(variant, className)} {...rest} />;
}

type BadgeTone = "neutral" | "brand" | "accent" | "pos" | "neg" | "warn";
const badgeTones: Record<BadgeTone, string> = {
  neutral: "bg-surface-2 text-muted",
  brand: "bg-brand-soft text-brand",
  accent: "bg-accent-soft text-accent",
  pos: "bg-surface-2 text-pos",
  neg: "bg-surface-2 text-neg",
  warn: "bg-warn-soft text-warn",
};

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: BadgeTone; className?: string }) {
  return (
    <span className={cx("inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-semibold", badgeTones[tone], className)}>
      {children}
    </span>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line p-6 text-center">
      <p className="font-semibold">{title}</p>
      {children ? <div className="mt-1 text-sm text-muted">{children}</div> : null}
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "error" | "success"; children: ReactNode }) {
  const tones = {
    info: "border-line bg-brand-soft text-ink",
    warn: "border-line bg-warn-soft text-ink",
    error: "border-neg/40 bg-surface text-neg",
    success: "border-pos/40 bg-surface text-pos",
  } as const;
  return <div className={cx("rounded-xl border px-3 py-2 text-sm", tones[tone])}>{children}</div>;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  "block w-full min-h-11 rounded-xl border border-line bg-surface px-3 py-2 text-ink placeholder:text-muted focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30";

export function Input(props: ComponentProps<"input">) {
  return <input {...props} className={cx(inputClass, props.className)} />;
}

export function Select(props: ComponentProps<"select">) {
  return <select {...props} className={cx(inputClass, props.className)} />;
}

export function Textarea(props: ComponentProps<"textarea">) {
  return <textarea {...props} className={cx(inputClass, "min-h-24", props.className)} />;
}

/** Points with sign coloring. */
export function Points({ value, className, signed }: { value: number; className?: string; signed?: boolean }) {
  const r = Math.round(value * 100) / 100;
  const text = Number.isInteger(r) ? r.toFixed(0) : r.toFixed(2).replace(/0$/, "");
  return (
    <span className={cx("tabular-nums", r > 0 && signed && "text-pos", r < 0 && "text-neg", className)}>
      {signed && r > 0 ? "+" : ""}
      {text}
    </span>
  );
}

export function ListRow({ children, href, className }: { children: ReactNode; href?: string; className?: string }) {
  const cls = cx("flex min-h-12 items-center gap-3 border-b border-line py-2 last:border-b-0", className);
  if (href)
    return (
      <Link href={href} className={cx(cls, "active:bg-surface-2")}>
        {children}
      </Link>
    );
  return <div className={cls}>{children}</div>;
}

export function Tabs({ items }: { items: { href: string; label: string; active: boolean }[] }) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto rounded-xl bg-surface-2 p-1">
      {items.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={cx(
            "flex min-h-11 flex-1 items-center justify-center whitespace-nowrap rounded-lg px-3 text-center text-sm font-semibold",
            t.active ? "bg-surface text-ink shadow-sm" : "text-muted",
          )}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
