/**
 * Shared UI primitives. Every view should build from these + the CSS tokens
 * in index.css rather than inventing its own button/card/badge styles.
 * Styles live in App.css under the "Primitives" section.
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { KIND_LABELS } from "../lib/format";
import type { ColumnKind } from "../types";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

/* ---------- Button ---------- */
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  iconRight,
  loading = false,
  disabled,
  children,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  const iconSize = size === "sm" ? 14 : 16;
  return (
    <button
      type={type}
      className={`btn btn-${variant} btn-${size}${className ? " " + className : ""}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={iconSize} /> : icon ? <Icon name={icon} size={iconSize} /> : null}
      {children !== undefined && children !== null && children !== false && <span>{children}</span>}
      {iconRight && !loading && <Icon name={iconRight} size={iconSize} />}
    </button>
  );
}

/** Square icon-only button. `label` is required for accessibility. */
export function IconButton({
  icon,
  label,
  active,
  size = 32,
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; active?: boolean; size?: number }) {
  return (
    <button
      type={type}
      className={`icon-btn${active ? " active" : ""}${className ? " " + className : ""}`}
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : active}
      style={{ width: size, height: size }}
      {...rest}
    >
      <Icon name={icon} size={Math.round(size * 0.5)} />
    </button>
  );
}

/* ---------- Badges ---------- */
export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function KindBadge({ kind }: { kind: ColumnKind }) {
  return <span className={`kind-badge kind-${kind}`}>{KIND_LABELS[kind] ?? kind}</span>;
}

/* ---------- Card ---------- */
interface CardProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: IconName;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  padded?: boolean;
}

export function Card({ title, subtitle, icon, actions, children, className, padded = true }: CardProps) {
  return (
    <section className={`card${padded ? "" : " card-flush"}${className ? " " + className : ""}`}>
      {(title || actions) && (
        <header className="card-header">
          <div className="card-title-wrap">
            {icon && (
              <span className="card-icon">
                <Icon name={icon} size={16} />
              </span>
            )}
            <div>
              {title && <h3 className="card-title">{title}</h3>}
              {subtitle && <p className="card-subtitle">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/* ---------- Stat tile ---------- */
export function Stat({
  label,
  value,
  hint,
  tone = "neutral",
  icon,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  icon?: IconName;
}) {
  return (
    <div className={`stat stat-${tone}`}>
      <div className="stat-label">
        {icon && <Icon name={icon} size={14} />}
        {label}
      </div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

/* ---------- Callout ---------- */
export function Callout({
  tone = "info",
  title,
  children,
  icon,
  action,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  icon?: IconName;
  action?: ReactNode;
}) {
  const defaultIcon: IconName =
    tone === "danger" || tone === "warning" ? "alert" : tone === "success" ? "checkCircle" : "info";
  return (
    <div className={`callout callout-${tone}`} role={tone === "danger" ? "alert" : undefined}>
      <Icon name={icon ?? defaultIcon} size={16} className="callout-icon" />
      <div className="callout-body">
        {title && <div className="callout-title">{title}</div>}
        {children && <div className="callout-text">{children}</div>}
      </div>
      {action && <div className="callout-action">{action}</div>}
    </div>
  );
}

/* ---------- Empty state ---------- */
export function EmptyState({
  icon = "database",
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon name={icon} size={22} />
      </div>
      <div className="empty-title">{title}</div>
      {children && <div className="empty-text">{children}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

/* ---------- Loading ---------- */
export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label="Loading" />;
}

export function Skeleton({ width = "100%", height = 14, radius }: { width?: number | string; height?: number | string; radius?: number }) {
  return <span className="skeleton" style={{ width, height, borderRadius: radius }} aria-hidden="true" />;
}

/** Block of skeleton lines used while a view's data loads. */
export function SkeletonBlock({ lines = 4 }: { lines?: number }) {
  return (
    <div className="skeleton-block" aria-busy="true">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={`${90 - ((i * 17) % 40)}%`} />
      ))}
    </div>
  );
}

/* ---------- Meter (horizontal bar) ---------- */
export function Meter({
  value,
  tone = "accent",
  label,
  height = 6,
}: {
  /** 0..1 */
  value: number;
  tone?: Tone;
  label?: string;
  height?: number;
}) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100;
  return (
    <div
      className={`meter meter-${tone}`}
      style={{ height }}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-label={label}
    >
      <div className="meter-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ---------- Form controls ---------- */
export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <label className={`switch-row${disabled ? " disabled" : ""}`} htmlFor={id}>
      <span className="switch-text">
        <span className="switch-label">{label}</span>
        {description && <span className="switch-desc">{description}</span>}
      </span>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="switch-input"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
    </label>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  size = "md",
}: {
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  size?: "sm" | "md";
}) {
  return (
    <div className={`segmented segmented-${size}`} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? "active" : ""}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Keyboard hint chip, e.g. <Kbd>Ctrl</Kbd><Kbd>K</Kbd> */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
