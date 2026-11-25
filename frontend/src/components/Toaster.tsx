import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Toast } from "../hooks/useWorkspace";
import { Icon, type IconName } from "./icons";

const ICONS: Record<string, IconName> = {
  success: "checkCircle",
  warning: "alert",
  danger: "alert",
  info: "info",
  accent: "sparkles",
  neutral: "info",
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    if (!toast.duration) return;
    const t = window.setTimeout(() => onDismiss(toast.id), toast.duration);
    return () => window.clearTimeout(t);
  }, [toast.id, toast.duration, onDismiss]);

  return (
    <motion.div
      layout
      className={`toast toast-${toast.tone}`}
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, transition: { duration: 0.15 } }}
      transition={{ duration: 0.18 }}
      role={toast.tone === "danger" ? "alert" : "status"}
    >
      <Icon name={ICONS[toast.tone] ?? "info"} size={16} className="toast-icon" />
      <div className="toast-body">
        <div className="toast-title">{toast.title}</div>
        {toast.message && <div className="toast-msg">{toast.message}</div>}
        {toast.action && (
          <button
            type="button"
            className="toast-action"
            onClick={() => {
              toast.action?.onClick();
              onDismiss(toast.id);
            }}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button type="button" className="toast-close" aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)}>
        <Icon name="x" size={14} />
      </button>
    </motion.div>
  );
}

export default function Toaster({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toaster" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
        ))}
      </AnimatePresence>
    </div>
  );
}
