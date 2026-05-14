'use client';

/**
 * The main chatbox on the landing page.
 *
 * Features:
 *   - Free-text input with submit-on-Enter.
 *   - Microphone button using the Web Speech API (SpeechRecognition).
 *     Falls back gracefully on unsupported browsers (no mic button shown).
 *   - On submit, POSTs to /api/chat, then router.push() to the returned URL.
 *
 * Why Web Speech API: it's built into Chrome/Edge/Safari, free, no key,
 * and runs in the browser (no audio leaves the device until transcribed).
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

// Minimal SpeechRecognition typing — TS doesn't ship these by default.
interface SpeechRecognitionLike {
  start: () => void;
  stop: () => void;
  onresult: (e: SpeechRecognitionEvent) => void;
  onerror: (e: Event) => void;
  onend: () => void;
  continuous: boolean;
  interimResults: boolean;
  lang: string;
}
interface SpeechRecognitionEvent extends Event {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}

export function ChatBox({ initialValue = '' }: { initialValue?: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initialValue);
  const [submitting, setSubmitting] = useState(false);
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const recogRef = useRef<SpeechRecognitionLike | null>(null);

  // Sync external changes (e.g. when a cuisine chip is tapped).
  useEffect(() => setValue(initialValue), [initialValue]);

  // Detect Web Speech API availability on mount.
  useEffect(() => {
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return;
    setSpeechSupported(true);
    const recog = new Ctor();
    recog.continuous = false;
    recog.interimResults = true;
    recog.lang = 'en-US';
    recog.onresult = (e) => {
      const transcript = Array.from({ length: e.results.length }, (_, i) =>
        e.results[i][0]?.transcript ?? ''
      ).join('');
      setValue(transcript);
    };
    recog.onerror = () => setListening(false);
    recog.onend = () => setListening(false);
    recogRef.current = recog;
  }, []);

  function toggleMic() {
    const r = recogRef.current;
    if (!r) return;
    if (listening) {
      r.stop();
      setListening(false);
    } else {
      setValue('');
      r.start();
      setListening(true);
    }
  }

  async function submit() {
    const text = value.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      const data = (await res.json()) as { searchUrl?: string; error?: string };
      if (data.searchUrl) router.push(data.searchUrl);
      else alert(data.error ?? 'Something went wrong');
    } catch (err) {
      alert('Network error');
    } finally {
      setSubmitting(false);
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="w-full">
      <div className="flex items-end gap-2 rounded-3xl border border-gray-200 bg-white p-3 shadow-sm focus-within:border-brand-red focus-within:ring-2 focus-within:ring-brand-red/20">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKey}
          rows={1}
          placeholder="Ask anything — e.g. romantic Italian in Central tonight at 8"
          className="flex-1 resize-none bg-transparent px-2 py-2 text-base outline-none placeholder:text-gray-400"
        />
        {speechSupported && (
          <button
            onClick={toggleMic}
            aria-label={listening ? 'Stop recording' : 'Start voice input'}
            className={`h-10 w-10 shrink-0 rounded-full transition ${
              listening
                ? 'bg-brand-red text-white animate-pulse'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            🎤
          </button>
        )}
        <button
          onClick={submit}
          disabled={!value.trim() || submitting}
          className="h-10 w-10 shrink-0 rounded-full bg-brand-red text-white shadow disabled:bg-gray-300 hover:opacity-90 active:scale-95 transition"
          aria-label="Send"
        >
          {submitting ? '…' : '↑'}
        </button>
      </div>
    </div>
  );
}
