import { useEffect, useRef, useState, type ReactNode } from "react";
import { downloadUrl } from "../api/client";
import { Icon } from "./icons";
import { Button, Field, Segmented } from "./ui";

/** Anchored popover: closes on outside click and Escape. */
export function Popover({
  trigger,
  children,
  align = "right",
  open: controlledOpen,
  onOpenChange,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [innerOpen, setInnerOpen] = useState(false);
  const open = controlledOpen ?? innerOpen;
  const setOpen = (v: boolean) => {
    if (controlledOpen === undefined) setInnerOpen(v);
    onOpenChange?.(v);
  };
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className="popover-anchor" ref={ref}>
      {trigger({ open, toggle: () => setOpen(!open) })}
      {open && <div className={`popover popover-${align}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function DownloadMenu({ datasetId, compact }: { datasetId: string; compact?: boolean }) {
  const formats: { f: "csv" | "xlsx" | "json"; label: string; desc: string }[] = [
    { f: "csv", label: "CSV", desc: "Comma-separated, universal" },
    { f: "xlsx", label: "Excel", desc: ".xlsx workbook" },
    { f: "json", label: "JSON", desc: "Array of records" },
  ];
  return (
    <Popover
      trigger={({ open, toggle }) => (
        <Button icon="download" size="sm" variant="secondary" onClick={toggle} aria-expanded={open} aria-haspopup="menu">
          {compact ? undefined : "Download"}
        </Button>
      )}
    >
      {(close) => (
        <div className="menu" role="menu">
          {formats.map(({ f, label, desc }) => (
            <a key={f} role="menuitem" className="menu-item" href={downloadUrl(datasetId, f)} download onClick={close}>
              <Icon name="file" size={15} />
              <span>
                <strong>{label}</strong>
                <small>{desc}</small>
              </span>
            </a>
          ))}
        </div>
      )}
    </Popover>
  );
}

export function SyntheticMenu({
  disabled,
  busy,
  rows,
  onGenerate,
}: {
  disabled: boolean;
  busy: boolean;
  rows: number;
  onGenerate: (opts: { nRows: number; seed: number | null; augment: boolean }) => Promise<unknown>;
}) {
  const [nRows, setNRows] = useState(100);
  const [augment, setAugment] = useState<"augment" | "standalone">("augment");
  const [seed, setSeed] = useState("");
  const valid = Number.isFinite(nRows) && nRows >= 1 && nRows <= 100_000;
  const seedNum = seed.trim() === "" ? null : Number(seed);
  const seedValid = seedNum === null || Number.isInteger(seedNum);

  return (
    <Popover
      trigger={({ open, toggle }) => (
        <Button icon="flask" size="sm" variant="secondary" onClick={toggle} disabled={disabled} aria-expanded={open}>
          Synthetic
        </Button>
      )}
    >
      {(close) => (
        <form
          className="popover-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || !seedValid) return;
            void onGenerate({ nRows, seed: seedNum, augment: augment === "augment" }).then(close);
          }}
        >
          <div className="popover-title">Generate synthetic rows</div>
          <p className="popover-text">
            Samples each column from this dataset's own distribution. Useful for augmenting small datasets ({rows.toLocaleString()} rows now).
          </p>
          <Segmented
            ariaLabel="Synthetic mode"
            size="sm"
            value={augment}
            onChange={setAugment}
            options={[
              { value: "augment", label: "Append to dataset" },
              { value: "standalone", label: "Synthetic only" },
            ]}
          />
          <div className="popover-grid">
            <Field label="Rows" htmlFor="syn-rows">
              <input
                id="syn-rows"
                className="input input-sm"
                type="number"
                min={1}
                max={100000}
                value={Number.isFinite(nRows) ? nRows : ""}
                onChange={(e) => setNRows(e.target.valueAsNumber)}
              />
            </Field>
            <Field label="Seed (optional)" htmlFor="syn-seed">
              <input id="syn-seed" className="input input-sm" inputMode="numeric" placeholder="random" value={seed} onChange={(e) => setSeed(e.target.value)} />
            </Field>
          </div>
          {!valid && <div className="field-error">Enter between 1 and 100,000 rows.</div>}
          {!seedValid && <div className="field-error">Seed must be a whole number.</div>}
          <Button type="submit" variant="primary" size="sm" icon="sparkles" loading={busy} disabled={!valid || !seedValid}>
            Generate {valid ? nRows.toLocaleString() : ""} rows
          </Button>
        </form>
      )}
    </Popover>
  );
}
