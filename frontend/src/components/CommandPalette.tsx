import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Icon, type IconName } from "./icons";
import { Kbd } from "./ui";

export interface Command {
  id: string;
  label: string;
  group: string;
  icon: IconName;
  hint?: string;
  disabled?: boolean;
  run: () => void;
}

/** Subsequence fuzzy score: higher is better, -1 = no match. */
function fuzzyScore(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx * 2 - (t.length - q.length) * 0.1;
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - (found - ti);
    ti = found + 1;
  }
  return score;
}

export default function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      window.setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const results = useMemo(() => {
    const enabled = commands.filter((c) => !c.disabled);
    if (!query.trim()) return enabled;
    return enabled
      .map((c) => ({ c, s: Math.max(fuzzyScore(query, c.label), fuzzyScore(query, `${c.group} ${c.label}`) - 50) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  }, [commands, query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const exec = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    // let the palette unmount before running (focus moves etc.)
    window.setTimeout(c.run, 0);
  };

  let lastGroup = "";
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="palette-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <motion.div
            className="palette"
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.14 }}
          >
            <div className="palette-input">
              <Icon name="search" size={16} />
              <input
                ref={inputRef}
                value={query}
                placeholder="Type a command or dataset name…"
                aria-label="Search commands"
                aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActive((a) => Math.min(a + 1, results.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActive((a) => Math.max(a - 1, 0));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    exec(results[active]);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    onClose();
                  }
                }}
              />
              <Kbd>Esc</Kbd>
            </div>
            <div className="palette-list" ref={listRef} role="listbox">
              {results.length === 0 && <div className="palette-empty">No matching commands.</div>}
              {results.map((c, i) => {
                const showGroup = !query.trim() && c.group !== lastGroup;
                lastGroup = c.group;
                return (
                  <div key={c.id}>
                    {showGroup && <div className="palette-group">{c.group}</div>}
                    <div
                      id={`cmd-${c.id}`}
                      role="option"
                      aria-selected={i === active}
                      data-index={i}
                      className={`palette-item${i === active ? " active" : ""}`}
                      onMouseMove={() => setActive(i)}
                      onClick={() => exec(c)}
                    >
                      <Icon name={c.icon} size={15} />
                      <span className="palette-label">{c.label}</span>
                      {c.hint && <span className="palette-hint">{c.hint}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
