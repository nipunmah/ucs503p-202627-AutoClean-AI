import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import "./ChatAssistant.css";
import type { ChatAssistantProps } from "../views/contracts";
import type { AlgorithmRecommendation, ChatMessage } from "../types";
import { errorMessage, sendChatMessage } from "../api/client";
import { useVoice } from "../hooks/useVoice";
import { Button, EmptyState, IconButton, Kbd, Meter } from "./ui";
import type { Tone } from "./ui";
import { Icon } from "./icons";
import type { IconName } from "./icons";

/* =========================================================================
   Rule-based chat assistant drawer. The backend
   (backend/app/core/pipeline/chat_assistant.py) picks an intent by keyword:
     recommend     — algorithm / model / train / predict / classifier / regressor / recommend
     data_quality  — missing / null / clean / quality / complete / nan
     outlier       — outlier / anomaly / extreme / weird value
     summary       — anything else
   checked in that order. The suggested prompts below are phrased so each
   one triggers exactly the intent it is labelled with.
   ========================================================================= */

interface Prompt {
  intent: string;
  label: string;
  text: string;
  detail: string;
  icon: IconName;
}

const PROMPTS: Prompt[] = [
  { intent: "summary", label: "Summarize this dataset", text: "Summarize this dataset", detail: "Rows, column types and total missing values", icon: "table" },
  {
    intent: "data_quality",
    label: "Is my data clean?",
    text: "Is my data clean? Where are the missing values?",
    detail: "Missing values per column, and whether imputation already ran",
    icon: "checkCircle",
  },
  { intent: "outlier", label: "Any outliers?", text: "Are there any outliers?", detail: "Columns with IQR outliers and how the pipeline treats them", icon: "alert" },
  {
    intent: "recommend",
    label: "Which algorithm should I use?",
    text: "Which algorithm should I use?",
    detail: "Problem type, ranked algorithms and fit scores",
    icon: "brain",
  },
];

const INTENT_LABELS: Record<string, string> = {
  recommend: "Algorithm advice",
  data_quality: "Data quality",
  outlier: "Outliers",
  summary: "Summary",
};

/** Matches the question the Models tab sends from a card's "Ask why" button. */
const ASK_WHY_RE = /^why is (.+) recommended\b/i;

interface Msg extends ChatMessage {
  id: number;
  /** Waiting for the backend (renders the typing indicator). */
  pending?: boolean;
  /** For assistant messages: the user question this answers (used for retry + highlighting). */
  question?: string;
}

/* ---------- layout mode (must match the 1280px breakpoint in App.css) ---------- */
const OVERLAY_QUERY = "(max-width: 1280px)";
const overlayMql = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(OVERLAY_QUERY) : null;
const subscribeOverlay = (cb: () => void) => {
  overlayMql?.addEventListener("change", cb);
  return () => overlayMql?.removeEventListener("change", cb);
};
const getOverlay = () => overlayMql?.matches ?? false;

/* ---------- safe mini-markdown: **bold**, `code`, line breaks, bullet lists ---------- */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={key}>{part.slice(1, -1)}</code>;
    return <Fragment key={key}>{part}</Fragment>;
  });
}

const BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;

function RichText({ text }: { text: string }) {
  // The backend appends preprocessing notes as " Also: …" on one line; give them their own paragraph.
  const normalized = text.replace(/\s+Also: /, "\n\nAlso: ");
  const blocks = normalized.split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, b) => {
        const lines = block.split("\n").filter((l) => l.trim() !== "");
        const out: ReactNode[] = [];
        let bullets: string[] = [];
        let para: string[] = [];
        const flushBullets = () => {
          if (!bullets.length) return;
          out.push(
            <ul key={`u${out.length}`} className="chat-md-list">
              {bullets.map((l, i) => (
                <li key={i}>{renderInline(l.replace(BULLET_RE, ""), `${b}-u${out.length}-${i}`)}</li>
              ))}
            </ul>
          );
          bullets = [];
        };
        const flushPara = () => {
          if (!para.length) return;
          out.push(
            <p key={`p${out.length}`}>
              {para.map((l, i) => (
                <Fragment key={i}>
                  {i > 0 && <br />}
                  {renderInline(l, `${b}-p${out.length}-${i}`)}
                </Fragment>
              ))}
            </p>
          );
          para = [];
        };
        for (const line of lines) {
          if (BULLET_RE.test(line)) {
            flushPara();
            bullets.push(line);
          } else {
            flushBullets();
            para.push(line);
          }
        }
        flushPara();
        flushBullets();
        return <Fragment key={b}>{out}</Fragment>;
      })}
    </>
  );
}

const plainText = (text: string) => text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");

function scoreTone(score: number): Tone {
  if (score >= 0.7) return "success";
  if (score >= 0.5) return "accent";
  if (score >= 0.35) return "warning";
  return "danger";
}

/* ---------- recommendation list inside a reply ---------- */
function RecList({ recs, question }: { recs: AlgorithmRecommendation[]; question?: string }) {
  const asked = question ? ASK_WHY_RE.exec(question.trim())?.[1]?.toLowerCase() ?? null : null;
  const ranked = useMemo(() => {
    const sorted = [...recs].sort((a, b) => b.score - a.score);
    let rank = 0;
    return sorted.map((rec, i) => {
      if (i === 0 || rec.score !== sorted[i - 1].score) rank = i + 1;
      const tied = sorted.some((o, j) => j !== i && o.score === rec.score);
      return { rec, rank, tied };
    });
  }, [recs]);
  const askedFound = asked ? ranked.some(({ rec }) => rec.algorithm.toLowerCase() === asked) : false;

  return (
    <div className="chat-recs">
      <div className="chat-recs-head">Top {ranked.length} from the recommender</div>
      <ol className="chat-recs-list">
        {ranked.map(({ rec, rank, tied }) => {
          const pct = Math.round(rec.score * 100);
          const focus = asked !== null && rec.algorithm.toLowerCase() === asked;
          return (
            <li key={rec.algorithm} className={`chat-rec${focus ? " chat-rec-focus" : ""}`}>
              <div className="chat-rec-row">
                <span className="chat-rec-rank">#{rank}</span>
                <span className="chat-rec-name">
                  {rec.algorithm}
                  {tied && <span className="chat-rec-tied"> · tied</span>}
                </span>
                <span className="chat-rec-score">{pct}%</span>
              </div>
              <Meter value={rec.score} tone={scoreTone(rec.score)} height={4} label={`${rec.algorithm} fit score ${pct}%`} />
              {focus && (rec.reasons.length > 0 || rec.caveats.length > 0) && (
                <ul className="chat-rec-points">
                  {rec.reasons.map((r, i) => (
                    <li key={`r${i}`} className="chat-rec-reason">
                      <Icon name="check" size={12} />
                      <span>{r}</span>
                    </li>
                  ))}
                  {rec.caveats.map((c, i) => (
                    <li key={`c${i}`} className="chat-rec-caveat">
                      <Icon name="alert" size={12} />
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
      {asked && !askedFound && (
        <p className="chat-recs-note">
          The algorithm you asked about isn't in this list. The assistant only returns its top 5, and it always scores against the auto-detected
          target, which can differ from a target picked on the Models tab. The Models tab shows the full ranking with every reason.
        </p>
      )}
    </div>
  );
}

/* ---------- one message ---------- */
const MessageView = memo(function MessageView({
  msg,
  canSpeak,
  onSpeak,
  onRetry,
}: {
  msg: Msg;
  canSpeak: boolean;
  onSpeak: (text: string) => void;
  onRetry: (msg: Msg) => void;
}) {
  if (msg.role === "user") {
    return (
      <li className="chat-msg chat-msg-user">
        <span className="sr-only">You: </span>
        <div className="chat-bubble">{msg.text}</div>
      </li>
    );
  }
  if (msg.pending) {
    return (
      <li className="chat-msg chat-msg-assistant">
        <div className="chat-bubble chat-typing">
          <span className="sr-only">Assistant is typing…</span>
          <span className="chat-dot" aria-hidden="true" />
          <span className="chat-dot" aria-hidden="true" />
          <span className="chat-dot" aria-hidden="true" />
        </div>
      </li>
    );
  }
  if (msg.error) {
    return (
      <li className="chat-msg chat-msg-assistant">
        <div className="chat-bubble chat-bubble-error" role="alert">
          <Icon name="alert" size={14} className="chat-error-icon" />
          <div className="chat-error-body">
            <span>{msg.text}</span>
            {msg.question && (
              <Button size="sm" variant="ghost" icon="refresh" onClick={() => onRetry(msg)}>
                Retry
              </Button>
            )}
          </div>
        </div>
      </li>
    );
  }
  return (
    <li className="chat-msg chat-msg-assistant">
      <span className="sr-only">Assistant: </span>
      <div className="chat-bubble chat-md">
        <RichText text={msg.text} />
        {msg.recommendations && msg.recommendations.length > 0 && <RecList recs={msg.recommendations} question={msg.question} />}
      </div>
      <div className="chat-msg-meta">
        {msg.intent && <span className="chat-intent">{INTENT_LABELS[msg.intent] ?? msg.intent}</span>}
        {canSpeak && (
          <IconButton icon="speaker" label="Read this reply aloud" size={24} className="chat-meta-btn" onClick={() => onSpeak(plainText(msg.text))} />
        )}
      </div>
    </li>
  );
});

/* =========================================================================
   Drawer
   ========================================================================= */
export default function ChatAssistant({ open, onOpenChange, datasetId, datasetName, pendingQuestion, onPendingConsumed }: ChatAssistantProps) {
  const [threads, setThreads] = useState<Record<string, Msg[]>>({});
  const [input, setInput] = useState("");
  const [speakReplies, setSpeakReplies] = useState(false);
  const overlay = useSyncExternalStore(subscribeOverlay, getOverlay, () => false);

  const seq = useRef(0);
  const mounted = useRef(true);
  const consumedQuestion = useRef<number | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const voiceBase = useRef("");
  // Read inside async callbacks without re-creating them.
  const live = useRef({ datasetId, open, speakReplies });
  useEffect(() => {
    live.current = { datasetId, open, speakReplies };
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const thread = useMemo(() => (datasetId ? threads[datasetId] ?? [] : []), [threads, datasetId]);
  const busy = thread.some((m) => m.pending);

  /* ---------- voice ---------- */
  const sendRef = useRef<(dsId: string, text: string) => void>(() => undefined);
  const voice = useVoice({
    onInterim: (t) => setInput(voiceBase.current ? `${voiceBase.current} ${t}` : t),
    onFinal: (t) => {
      const text = voiceBase.current ? `${voiceBase.current} ${t}` : t;
      voiceBase.current = "";
      const dsId = live.current.datasetId;
      if (dsId) {
        setInput("");
        sendRef.current(dsId, text);
      } else {
        setInput(text);
      }
    },
  });
  const { speak, cancelSpeak, stopListening, abortListening, startListening, listening } = voice;

  /* ---------- messaging ---------- */
  const patch = useCallback((dsId: string, id: number, next: Partial<Msg>) => {
    setThreads((t) => {
      const list = t[dsId];
      // The thread may have been cleared while the request was in flight: drop the reply.
      if (!list || !list.some((m) => m.id === id)) return t;
      return { ...t, [dsId]: list.map((m) => (m.id === id ? { ...m, ...next } : m)) };
    });
  }, []);

  const request = useCallback(
    (dsId: string, question: string, replyId: number) => {
      sendChatMessage(dsId, question)
        .then((reply) => {
          if (!mounted.current) return;
          patch(dsId, replyId, {
            pending: false,
            error: false,
            text: reply.reply,
            intent: reply.intent,
            recommendations: reply.recommendations ?? undefined,
            question,
          });
          const now = live.current;
          if (now.speakReplies && now.open && now.datasetId === dsId) speak(plainText(reply.reply));
        })
        .catch((e: unknown) => {
          if (!mounted.current) return;
          patch(dsId, replyId, { pending: false, error: true, text: errorMessage(e), question });
        });
    },
    [patch, speak]
  );

  const send = useCallback(
    (dsId: string, text: string) => {
      const question = text.trim();
      if (!question) return;
      const userMsg: Msg = { id: ++seq.current, role: "user", text: question };
      const replyMsg: Msg = { id: ++seq.current, role: "assistant", text: "", pending: true, question };
      setThreads((t) => ({ ...t, [dsId]: [...(t[dsId] ?? []), userMsg, replyMsg] }));
      request(dsId, question, replyMsg.id);
    },
    [request]
  );
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  const retry = useCallback(
    (msg: Msg) => {
      const dsId = live.current.datasetId;
      if (!dsId || !msg.question) return;
      patch(dsId, msg.id, { pending: true, error: false, text: "" });
      request(dsId, msg.question, msg.id);
    },
    [patch, request]
  );

  const submit = () => {
    if (!datasetId || busy || !input.trim()) return;
    if (listening) stopListening();
    voiceBase.current = "";
    send(datasetId, input);
    setInput("");
  };

  const clearThread = () => {
    if (!datasetId) return;
    cancelSpeak();
    setThreads((t) => ({ ...t, [datasetId]: [] }));
    inputRef.current?.focus();
  };

  /* ---------- queued question from elsewhere in the app (sent exactly once) ---------- */
  useEffect(() => {
    if (!pendingQuestion || !datasetId) return;
    if (consumedQuestion.current === pendingQuestion.id) return;
    consumedQuestion.current = pendingQuestion.id;
    send(datasetId, pendingQuestion.text);
    onPendingConsumed();
  }, [pendingQuestion, datasetId, send, onPendingConsumed]);

  /* ---------- stop voice when closing or switching datasets ----------
     abort (not stop) so a half-heard question is discarded instead of being sent
     to the newly selected dataset or from a closed drawer. */
  useEffect(() => {
    if (!open) {
      cancelSpeak();
      abortListening();
      voiceBase.current = "";
    }
  }, [open, cancelSpeak, abortListening]);
  useEffect(() => {
    cancelSpeak();
    abortListening();
    voiceBase.current = "";
  }, [datasetId, cancelSpeak, abortListening]);

  /* ---------- focus management ---------- */
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const aside = asideRef.current;
    const raf = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(raf);
      const active = document.activeElement;
      const focusInside = !active || active === document.body || (aside?.contains(active) ?? false);
      if (previous && previous.isConnected && focusInside) previous.focus({ preventScroll: true });
    };
  }, [open]);

  /* ---------- Escape closes (anywhere in overlay mode; from inside the panel when docked) ---------- */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const inside = asideRef.current?.contains(document.activeElement) ?? false;
      if (!overlay && !inside) return;
      e.preventDefault();
      if (listening) {
        // Escape cancels voice input without sending; restore what was typed before the mic started.
        abortListening();
        setInput(voiceBase.current);
        voiceBase.current = "";
      } else onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, overlay, listening, abortListening, onOpenChange]);

  /* ---------- auto-scroll to newest ---------- */
  const lastMsg = thread[thread.length - 1];
  useEffect(() => {
    const el = logRef.current;
    if (!el || !open) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [thread.length, lastMsg?.pending, lastMsg?.id, open, datasetId]);

  /* ---------- textarea autosize ---------- */
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [input, open]);

  const onInputKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const toggleMic = () => {
    if (listening) {
      stopListening();
      return;
    }
    voiceBase.current = input.trim();
    startListening();
  };

  const toggleSpeakReplies = () => {
    setSpeakReplies((on) => {
      if (on) cancelSpeak();
      return !on;
    });
  };

  const lastIntent = [...thread].reverse().find((m) => m.role === "assistant" && m.intent)?.intent;
  const followUps = PROMPTS.filter((p) => p.intent !== lastIntent);
  const noDataset = !datasetId;

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          key="chat"
          ref={asideRef}
          className={`chat-drawer${overlay ? " chat-drawer-overlay" : ""}`}
          aria-label="Data assistant"
          initial={overlay ? { x: "100%" } : { opacity: 0 }}
          animate={overlay ? { x: 0 } : { opacity: 1 }}
          exit={overlay ? { x: "100%" } : undefined}
          transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
        >
          {/* ---------- header ---------- */}
          <header className="chat-head">
            <span className="chat-head-icon" aria-hidden="true">
              <Icon name="sparkles" size={16} />
            </span>
            <div className="chat-head-text">
              <h2 className="chat-title">Data assistant</h2>
              <p className="chat-context" title={datasetName ?? undefined}>
                {datasetName ? (
                  <>
                    Talking about <strong>{datasetName}</strong>
                  </>
                ) : (
                  "No dataset selected"
                )}
              </p>
            </div>
            <div className="chat-head-actions">
              {voice.isSynthesisSupported && (
                <IconButton
                  icon="speaker"
                  label="Read replies aloud"
                  active={speakReplies}
                  onClick={toggleSpeakReplies}
                />
              )}
              <IconButton icon="trash" label="Clear this conversation" onClick={clearThread} disabled={thread.length === 0} />
              <IconButton icon="x" label="Close assistant" onClick={() => onOpenChange(false)} />
            </div>
          </header>

          {/* ---------- conversation ---------- */}
          <div
            className="chat-log"
            ref={logRef}
            role="log"
            aria-live="polite"
            aria-label={noDataset ? "Conversation" : `Conversation about ${datasetName ?? "this dataset"}`}
          >
            {noDataset ? (
              <EmptyState icon="database" title="No dataset to talk about">
                Upload or select a dataset in the library. Every question is answered against whichever dataset is selected.
              </EmptyState>
            ) : thread.length === 0 ? (
              <div className="chat-intro">
                <p className="chat-intro-text">
                  Ask about <strong>{datasetName}</strong>. Answers are computed from its column profile, cleaning audit trail and the algorithm
                  recommender — real numbers, rule-based, no LLM.
                </p>
                <ul className="chat-starters" aria-label="Suggested questions">
                  {PROMPTS.map((p) => (
                    <li key={p.intent}>
                      <button type="button" className="chat-starter" onClick={() => send(datasetId, p.text)}>
                        <Icon name={p.icon} size={16} className="chat-starter-icon" />
                        <span className="chat-starter-text">
                          <span className="chat-starter-label">{p.label}</span>
                          <span className="chat-starter-detail">{p.detail}</span>
                        </span>
                        <Icon name="arrowRight" size={14} className="chat-starter-go" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <ol className="chat-thread">
                {thread.map((m) => (
                  <MessageView key={m.id} msg={m} canSpeak={voice.isSynthesisSupported} onSpeak={speak} onRetry={retry} />
                ))}
              </ol>
            )}
          </div>

          {/* ---------- composer ---------- */}
          <div className="chat-compose">
            {!noDataset && thread.length > 0 && !busy && (
              <div className="chat-chips" aria-label="Follow-up questions">
                {followUps.map((p) => (
                  <button key={p.intent} type="button" className="chat-chip" onClick={() => send(datasetId, p.text)} title={p.detail}>
                    {p.label}
                  </button>
                ))}
              </div>
            )}
            {voice.error && (
              <div className="chat-voice-error" role="status">
                <span>{voice.error}</span>
                <IconButton icon="x" label="Dismiss" size={22} onClick={voice.clearError} />
              </div>
            )}
            <form
              className={`chat-input-wrap${listening ? " chat-listening" : ""}`}
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <label htmlFor="chat-input" className="sr-only">
                Ask about this dataset
              </label>
              <textarea
                id="chat-input"
                ref={inputRef}
                className="chat-input"
                rows={1}
                value={input}
                placeholder={noDataset ? "Select a dataset first" : listening ? "Listening…" : "Ask about missing values, outliers, models…"}
                disabled={noDataset}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onInputKeyDown}
              />
              {voice.isRecognitionSupported && (
                <IconButton
                  icon={listening ? "stop" : "mic"}
                  label="Voice input"
                  active={listening}
                  disabled={noDataset}
                  onClick={toggleMic}
                  className="chat-mic"
                />
              )}
              <IconButton
                type="submit"
                icon="send"
                label={busy ? "Waiting for the answer" : "Send"}
                disabled={noDataset || busy || !input.trim()}
                className="chat-send"
              />
            </form>
            <p className="chat-hint">
              <Kbd>Enter</Kbd> to send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> for a new line ·{" "}
              <Kbd>Esc</Kbd> to close
            </p>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
