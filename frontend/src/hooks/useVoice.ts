import { useCallback, useEffect, useRef, useState } from "react";

/*
 * Voice I/O on top of the browser's native Web Speech APIs. No dependency.
 *
 * The SpeechRecognition interface isn't part of TypeScript's DOM lib (it's
 * non-standard / webkit-prefixed in Chromium and Safari), so we declare the
 * minimal shape we actually use.
 */
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  0: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/* Feature detection happens once; support can't change during a page's life. */
const RecognitionCtor = getRecognitionCtor();
export const isRecognitionSupported = RecognitionCtor !== null;
export const isSynthesisSupported =
  typeof window !== "undefined" && "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function";

const ERROR_MESSAGES: Record<string, string> = {
  "not-allowed": "Microphone access was blocked. Allow it in your browser's site settings to use voice input.",
  "service-not-allowed": "Speech recognition isn't available in this browser context.",
  "audio-capture": "No microphone was found.",
  network: "Speech recognition needs a network connection in this browser.",
  "no-speech": "Didn't catch anything — try again and speak after the mic turns on.",
};

interface UseVoiceOptions {
  /** Called with the live (not yet final) transcript while the user speaks. */
  onInterim?: (transcript: string) => void;
  /** Called once with the final transcript when the user stops speaking. */
  onFinal: (transcript: string) => void;
  lang?: string;
}

/**
 * Callbacks are read through refs, so passing inline functions is fine: the
 * recognition instance is created once (lazily, on first use) and never
 * recreated because a callback identity changed. Listening and speech are
 * both stopped on unmount.
 */
export function useVoice({ onInterim, onFinal, lang = "en-US" }: UseVoiceOptions) {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onInterimRef = useRef(onInterim);
  const onFinalRef = useRef(onFinal);
  const langRef = useRef(lang);

  useEffect(() => {
    onInterimRef.current = onInterim;
    onFinalRef.current = onFinal;
    langRef.current = lang;
  });

  const getRecognition = useCallback((): SpeechRecognitionLike | null => {
    if (!RecognitionCtor) return null;
    if (recognitionRef.current) return recognitionRef.current;
    const recognition = new RecognitionCtor();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) final += text;
        else interim += text;
      }
      if (final.trim()) onFinalRef.current(final.trim());
      else if (interim) onInterimRef.current?.(interim);
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = (event) => {
      setListening(false);
      if (event.error === "aborted") return;
      setError(ERROR_MESSAGES[event.error] ?? `Voice input failed (${event.error}).`);
    };
    recognitionRef.current = recognition;
    return recognition;
  }, []);

  const startListening = useCallback(() => {
    const recognition = getRecognition();
    if (!recognition) return;
    if (isSynthesisSupported) window.speechSynthesis.cancel();
    setError(null);
    recognition.lang = langRef.current;
    try {
      recognition.start();
      setListening(true);
    } catch {
      // start() throws InvalidStateError if a session is already running; that session keeps its state.
    }
  }, [getRecognition]);

  /** Stop and deliver what was heard so far (onFinal may still fire). */
  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  /** Stop and discard: no further onInterim/onFinal for this session. */
  const abortListening = useCallback(() => {
    const recognition = recognitionRef.current;
    if (recognition) {
      try {
        recognition.abort();
      } catch {
        /* not running */
      }
    }
    setListening(false);
  }, []);

  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  const cancelSpeak = useCallback(() => {
    utteranceRef.current = null;
    if (isSynthesisSupported) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const speak = useCallback((text: string) => {
    if (!isSynthesisSupported || !text.trim()) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = langRef.current;
    utterance.rate = 1.02;
    // cancel() fires end/error on the previous utterance asynchronously; ignore those for a superseded one.
    const done = () => {
      if (utteranceRef.current !== utterance) return;
      utteranceRef.current = null;
      setSpeaking(false);
    };
    utterance.onend = done;
    utterance.onerror = done;
    utteranceRef.current = utterance;
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  useEffect(
    () => () => {
      const recognition = recognitionRef.current;
      if (recognition) {
        recognition.onresult = null;
        recognition.onend = null;
        recognition.onerror = null;
        try {
          recognition.abort();
        } catch {
          /* not running */
        }
        recognitionRef.current = null;
      }
      utteranceRef.current = null;
      if (isSynthesisSupported) window.speechSynthesis.cancel();
    },
    []
  );

  return {
    isRecognitionSupported,
    isSynthesisSupported,
    listening,
    speaking,
    error,
    clearError,
    startListening,
    stopListening,
    abortListening,
    speak,
    cancelSpeak,
  };
}
