import React, { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import CuteComputer from "./CuteComputer";
import type { BotState } from "./CuteComputer";
import PixelEarth from "./PixelEarth";
import Markdown from "./Markdown";
import LatencyChart, { GOAL_MS, isComplete } from "./LatencyChart";
import type { FullLatency, Latency, ServerLatency } from "./LatencyChart";
import { ThinkingOrb } from "thinking-orbs";

const BACKEND_WS = "ws://localhost:5000/ws";
const MIN_AUDIO_BYTES = 1500;

// Interrupting by voice: how loud (0 to 1) and for how long you must talk over the bot.
// If the bot interrupts itself, raise BARGE_IN_LEVEL. If it doesn't hear you, lower it.
const BARGE_IN_LEVEL = 0.06;
const BARGE_IN_MS = 400;
const BARGE_IN_WARMUP_MS = 500; // the mic is ignored for this long after the bot starts talking
const TYPING_QUIET_MS = 800; // and for this long after you press a key, so keyboard clicks don't count

type Connection = "connecting" | "online" | "offline";
type Role = "user" | "assistant" | "error";

interface ChatMessage {
  id: number;
  role: Role;
  text: string;
  streaming?: boolean;
  typed?: boolean;
  stopped?: boolean;
}

const LATENCY_ROWS: [keyof Latency, string][] = [
  ["stt_ms", "Speech to text"],
  ["search_ms", "Knowledge search"],
  ["llm_first_word_ms", "LLM first word"],
  ["first_sentence_ms", "LLM first sentence"],
  ["voice_ms", "First voice clip"],
  ["total_ms", "AI layer total"],
  ["heard_ms", "You heard it after"],
];

// Messages the AI layer sends back through the backend ('connection_lost' comes from this page).
// "turn" is the number of the question they answer, so the page can ignore a reply you stopped.
type ServerMessage = (
  | { type: "turn_start" | "turn_end" | "no_speech" | "connection_lost" }
  | { type: "stt_chunk"; text: string; is_final: boolean }
  | { type: "ai_response_chunk"; text: string; is_final: boolean }
  | { type: "voice_segment"; text: string; audio: string }
  | { type: "latency"; steps: ServerLatency }
  | { type: "error"; message: string }
) & { turn?: number };

// Messages the page sends to the AI layer
type ClientMessage =
  | { type: "audio_chunk"; data: string }
  | { type: "end_audio"; turn: number }
  | { type: "text_message"; text: string; turn: number }
  | { type: "interrupt"; heard?: string };

interface VoiceSegment {
  text: string;
  audio: string;
}

// The spoken reply: its sentences wait in a queue and each one types out while it plays
interface VoiceState {
  queue: VoiceSegment[];
  audio: HTMLAudioElement | null;
  timer: ReturnType<typeof setInterval> | undefined;
  messageId: number | null;
  shown: string;
  finalText: string | null;
}

const ICONS = {
  listen: [
    "..##..",
    "..##..",
    "..##..",
    "#.##.#",
    "#.##.#",
    ".####.",
    "..##..",
    ".####.",
  ],
  think: [
    ".#.#.#.",
    "#######",
    "#.....#",
    "##.#.##",
    "#.....#",
    "#######",
    ".#.#.#.",
  ],
  speak: [
    "...#....",
    "..##.#..",
    "####..#.",
    "####.#.#",
    "####.#.#",
    "####..#.",
    "..##.#..",
    "...#....",
  ],
  chat: [
    "########",
    "#......#",
    "#.#.#..#",
    "#......#",
    "########",
    ".##.....",
    ".#......",
  ],
};

type IconShape = keyof typeof ICONS;

const STEPS: { id: BotState; icon: IconShape; title: string; text: string }[] =
  [
    {
      id: "listening",
      icon: "listen",
      title: "Listen",
      text: "Your mic records while the button is on.",
    },
    {
      id: "thinking",
      icon: "think",
      title: "Think",
      text: "Your speech becomes text, then a reply is written.",
    },
    {
      id: "speaking",
      icon: "speak",
      title: "Speak",
      text: "The reply types out while it is read out loud.",
    },
  ];

function sendMessage(ws: WebSocket, payload: ClientMessage) {
  ws.send(JSON.stringify(payload));
}

function withMessage(list: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const last = list[list.length - 1];
  if (
    message.role === "error" &&
    last &&
    last.role === "error" &&
    last.text === message.text
  )
    return list;
  return [...list, message];
}

function updateMessage(
  list: ChatMessage[],
  id: number | null,
  changes: Partial<ChatMessage>,
): ChatMessage[] {
  return list.map((m) => (m.id === id ? { ...m, ...changes } : m));
}

// Reveals a typed reply a few letters at a time, so it types out even when the text arrives in one burst
function useTypewriter(
  text: string,
  animate: boolean,
  frozen: boolean,
): string {
  const [count, setCount] = useState(animate ? 0 : text.length);
  useEffect(() => {
    if (!animate || frozen || count >= text.length) return;
    const step = Math.max(2, Math.ceil((text.length - count) / 100));
    const timer = setTimeout(() => setCount(count + step), 25);
    return () => clearTimeout(timer);
  }, [animate, frozen, text, count]);
  return animate ? text.slice(0, count) : text;
}

function TypedMarkdown({
  text,
  animate,
  frozen,
  onGrow,
}: {
  text: string;
  animate: boolean;
  frozen: boolean;
  onGrow: () => void;
}) {
  const shown = useTypewriter(text, animate, frozen);
  useEffect(() => {
    if (animate) onGrow();
  }, [shown, animate, onGrow]);
  return <Markdown text={shown} />;
}

// Add one streamed piece to the typed reply that is being written
function appendReply(
  list: ChatMessage[],
  piece: string,
  newId: number,
): ChatMessage[] {
  const last = list[list.length - 1];
  if (last && last.role === "assistant" && last.streaming) {
    return [...list.slice(0, -1), { ...last, text: last.text + piece }];
  }
  return [
    ...list,
    { id: newId, role: "assistant", text: piece, streaming: true, typed: true },
  ];
}

// Replace the streamed reply with the complete text from the server
function finishReply(
  list: ChatMessage[],
  fullText: string,
  newId: number,
): ChatMessage[] {
  const last = list[list.length - 1];
  if (last && last.role === "assistant" && last.streaming) {
    return [
      ...list.slice(0, -1),
      { ...last, text: fullText, streaming: false },
    ];
  }
  return [...list, { id: newId, role: "assistant", text: fullText }];
}

// Stop the typing cursor on every message except the spoken reply that is still playing
function stopStreaming(
  list: ChatMessage[],
  keepId: number | null,
): ChatMessage[] {
  return list.map((m) =>
    m.streaming && m.id !== keepId
      ? { ...m, streaming: false, stopped: true }
      : m,
  );
}

function PixelIcon({ shape }: { shape: IconShape }) {
  const rows = ICONS[shape];
  return (
    <svg
      className="pixel-icon"
      viewBox={`0 0 ${rows[0].length} ${rows.length}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {rows.flatMap((row, y) =>
        row
          .split("")
          .map((cell, x) =>
            cell === "#" ? (
              <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" />
            ) : null,
          ),
      )}
    </svg>
  );
}

function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [draft, setDraft] = useState("");
  const [latency, setLatency] = useState<Latency | null>(null);
  const [latencyHistory, setLatencyHistory] = useState<FullLatency[]>([]);
  const [latencyPinned, setLatencyPinned] = useState(false);
  const [voiceInterrupt, setVoiceInterrupt] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);
  const voiceRef = useRef<VoiceState>({
    queue: [],
    audio: null,
    timer: undefined,
    messageId: null,
    shown: "",
    finalText: null,
  });
  const handleMessageRef = useRef<(msg: ServerMessage) => void>(() => {});
  const turnRef = useRef(0);
  const stopPressedAtRef = useRef<number | null>(null);
  const bargeInRef = useRef<() => void>(() => {});
  const lastKeyAtRef = useRef(0);

  const newId = () => {
    idRef.current += 1;
    return idRef.current;
  };

  const addMessage = (role: Role, text: string) => {
    const id = newId();
    setMessages((prev) => withMessage(prev, { id, role, text }));
  };

  // ---------- the bot's voice, with its text typed along ----------
  const finishVoiceIfDone = () => {
    const v = voiceRef.current;
    if (
      v.messageId === null ||
      v.audio ||
      v.queue.length ||
      v.finalText === null
    )
      return;
    const id = v.messageId;
    const text = v.finalText;
    setMessages((prev) => updateMessage(prev, id, { text, streaming: false }));
    v.messageId = null;
    v.finalText = null;
    v.shown = "";
    setIsSpeaking(false);
  };

  const playNextSegment = () => {
    const v = voiceRef.current;
    const segment = v.queue.shift();
    if (!segment) {
      setIsSpeaking(false);
      finishVoiceIfDone();
      return;
    }

    const id = v.messageId;
    const before = v.shown;
    const reveal = (count: number) => {
      v.shown = before + segment.text.slice(0, count);
      const text = v.shown;
      setMessages((prev) => updateMessage(prev, id, { text }));
    };

    // No audio for this sentence (the voice service failed): show its text straight away
    if (!segment.audio) {
      reveal(segment.text.length);
      playNextSegment();
      return;
    }

    const bytes = Uint8Array.from(atob(segment.audio), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
    const audio = new Audio(url);
    v.audio = audio;

    const done = () => {
      if (v.audio !== audio) return;
      clearInterval(v.timer);
      v.timer = undefined;
      v.audio = null;
      URL.revokeObjectURL(url);
      reveal(segment.text.length);
      playNextSegment();
    };

    audio.onplay = () => {
      setIsSpeaking(true);
      if (stopPressedAtRef.current !== null) {
        const heard = Math.round(performance.now() - stopPressedAtRef.current);
        stopPressedAtRef.current = null;
        setLatency((prev) => ({ ...prev, heard_ms: heard }));
      }
      clearInterval(v.timer);
      v.timer = setInterval(() => {
        if (!audio.duration || !Number.isFinite(audio.duration)) return;
        reveal(
          Math.floor(
            segment.text.length *
              Math.min(1, audio.currentTime / audio.duration),
          ),
        );
      }, 60);
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch((err) => {
      console.error("Audio playback error:", err);
      done();
    });
  };

  const enqueueVoiceSegment = (text: string, audio: string) => {
    const v = voiceRef.current;
    if (v.messageId === null) {
      const id = newId();
      v.messageId = id;
      v.shown = "";
      v.finalText = null;
      setMessages((prev) => [
        ...prev,
        { id, role: "assistant", text: "", streaming: true },
      ]);
    }
    v.queue.push({ text, audio });
    if (!v.audio) playNextSegment();
  };

  // The reply stopped coming (error or lost connection): let what arrived play out, then close the message
  const settleVoice = () => {
    const v = voiceRef.current;
    if (v.messageId !== null && v.finalText === null) {
      v.finalText = v.shown + v.queue.map((s) => s.text).join("");
      finishVoiceIfDone();
    }
  };

  // Stop the voice straight away. The chat keeps only what you heard, marked as stopped.
  const stopVoice = () => {
    const v = voiceRef.current;
    const id = v.messageId;
    const heard = v.shown.trim();
    const text = heard
      ? `${heard}\n\n*(stopped)*`
      : "*(stopped before answering)*";
    v.queue = [];
    clearInterval(v.timer);
    v.timer = undefined;
    if (v.audio) {
      const audio = v.audio;
      v.audio = null;
      audio.pause();
      URL.revokeObjectURL(audio.src);
    }
    v.messageId = null;
    v.finalText = null;
    v.shown = "";
    if (id !== null)
      setMessages((prev) =>
        updateMessage(prev, id, { text, streaming: false }),
      );
    setIsSpeaking(false);
  };

  // Stop button, or recording over the bot: stop the voice here and tell the AI layer to stop writing
  const stopReply = () => {
    const v = voiceRef.current;
    const speakingReply = v.messageId !== null;
    const replying = isProcessing || speakingReply;
    const heard = speakingReply ? v.shown.trim() : undefined;
    turnRef.current += 1;
    stopPressedAtRef.current = null;
    const ws = wsRef.current;
    if (replying && ws && ws.readyState === WebSocket.OPEN)
      sendMessage(ws, { type: "interrupt", heard });
    if (speakingReply) stopVoice();
    setMessages((prev) => stopStreaming(prev, null));
    setIsProcessing(false);
  };

  // ---------- messages from the backend ----------
  const handleMessage = (msg: ServerMessage) => {
    if (msg.turn !== undefined && msg.turn !== turnRef.current) return; // a reply you already stopped

    switch (msg.type) {
      case "stt_chunk":
        if (msg.is_final) addMessage("user", msg.text);
        break;

      case "voice_segment":
        enqueueVoiceSegment(msg.text, msg.audio);
        break;

      case "ai_response_chunk": {
        const v = voiceRef.current;
        if (msg.is_final && v.messageId !== null) {
          v.finalText = msg.text;
          finishVoiceIfDone();
          break;
        }
        const id = newId();
        setMessages((prev) =>
          msg.is_final
            ? finishReply(prev, msg.text, id)
            : appendReply(prev, msg.text, id),
        );
        break;
      }

      case "latency":
        setLatency((prev) => ({ ...prev, ...msg.steps }));
        break;

      case "no_speech":
        addMessage(
          "error",
          "I didn't hear any words. Press record and talk for 2 or 3 seconds.",
        );
        setIsProcessing(false);
        break;

      case "turn_end":
        setIsProcessing(false);
        break;

      case "error":
      case "connection_lost":
        settleVoice();
        setMessages((prev) => stopStreaming(prev, voiceRef.current.messageId));
        if (msg.type === "error") addMessage("error", msg.message);
        setIsProcessing(false);
        break;

      default:
        break;
    }
  };

  useEffect(() => {
    handleMessageRef.current = handleMessage;
    bargeInRef.current = () => {
      console.log("[voice interrupt] you talked over the bot");
      startRecording();
    };
  });

  useEffect(() => {
    const onKey = () => {
      lastKeyAtRef.current = performance.now();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Every spoken reply with all its timings goes into the chart (the last 8)
  useEffect(() => {
    if (latency && isComplete(latency))
      setLatencyHistory((prev) => [...prev.slice(-7), latency]);
  }, [latency]);

  // While the bot talks, listen to the mic. If you talk over it for a moment, it stops and records you.
  useEffect(() => {
    if (!isSpeaking || !voiceInterrupt) return;
    let closed = false;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let loudest = 0;

    navigator.mediaDevices
      .getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      .then((s) => {
        if (closed) {
          s.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = s;
        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(s).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        const startedAt = performance.now();
        let loudMs = 0;

        timer = setInterval(() => {
          const now = performance.now();
          if (
            now - startedAt < BARGE_IN_WARMUP_MS ||
            now - lastKeyAtRef.current < TYPING_QUIET_MS
          ) {
            loudMs = 0;
            return;
          }
          analyser.getFloatTimeDomainData(samples);
          let total = 0;
          for (let i = 0; i < samples.length; i += 1)
            total += samples[i] * samples[i];
          const level = Math.sqrt(total / samples.length);
          loudest = Math.max(loudest, level);
          // Short gaps between words only lower the count a little, so normal speech still adds up
          loudMs =
            level > BARGE_IN_LEVEL ? loudMs + 50 : Math.max(0, loudMs - 25);
          if (loudMs >= BARGE_IN_MS) {
            clearInterval(timer);
            bargeInRef.current();
          }
        }, 50);
      })
      .catch((err) =>
        console.error("Voice interrupt could not use the microphone:", err),
      );

    return () => {
      closed = true;
      clearInterval(timer);
      if (stream) stream.getTracks().forEach((track) => track.stop());
      if (context) context.close();
      console.log(
        `[voice interrupt] loudest sound while the bot talked: ${loudest.toFixed(3)} (limit ${BARGE_IN_LEVEL})`,
      );
    };
  }, [isSpeaking, voiceInterrupt]);

  // One WebSocket to the backend (5000) carries voice and typed chat to the AI layer (8000)
  useEffect(() => {
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const connect = () => {
      const ws = new WebSocket(BACKEND_WS);
      socket = ws;
      wsRef.current = ws;
      ws.onopen = () => setConnection("online");
      ws.onmessage = (event) =>
        handleMessageRef.current(JSON.parse(event.data));
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        if (stopped) return;
        setConnection("offline");
        handleMessageRef.current({ type: "connection_lost" });
        retryTimer = setTimeout(connect, 2000);
      };
    };

    connect();

    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      if (socket) socket.close();
    };
  }, []);

  const keepInView = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const nearBottom =
      list.scrollHeight - list.scrollTop - list.clientHeight < 200;
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }, []);

  // Keep the newest text in view while a reply types out, unless you scrolled up to read
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const nearBottom =
      list.scrollHeight - list.scrollTop - list.clientHeight < 200;
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }, [messages, isProcessing]);

  const sendAudio = (blob: Blob) => {
    const ws = wsRef.current;
    if (blob.size < MIN_AUDIO_BYTES) {
      addMessage(
        "error",
        "That recording was too short. Talk for 2 or 3 seconds, then stop.",
      );
      setIsProcessing(false);
      return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      addMessage(
        "error",
        "Not connected to the backend on port 5000. Is it running?",
      );
      setIsProcessing(false);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      turnRef.current += 1;
      sendMessage(ws, { type: "audio_chunk", data: dataUrl.split(",")[1] });
      sendMessage(ws, { type: "end_audio", turn: turnRef.current });
    };
    reader.readAsDataURL(blob);
  };

  const startRecording = async () => {
    stopReply();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        sendAudio(new Blob(chunksRef.current, { type: recorder.mimeType }));
      };
      recorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error("Microphone error:", err);
      addMessage(
        "error",
        "Microphone is blocked. Allow it from the icon in the address bar, then try again.",
      );
    }
  };

  const stopRecording = () => {
    stopPressedAtRef.current = performance.now();
    setLatency(null);
    if (recorderRef.current && recorderRef.current.state !== "inactive")
      recorderRef.current.stop();
    setIsRecording(false);
    setIsProcessing(true);
  };

  const sendText = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || isProcessing) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      addMessage(
        "error",
        "Not connected to the backend on port 5000. Is it running?",
      );
      return;
    }
    stopReply();
    turnRef.current += 1;
    addMessage("user", text);
    setDraft("");
    setIsProcessing(true);
    sendMessage(ws, { type: "text_message", text, turn: turnRef.current });
  };

  const online = connection === "online";
  const botState: BotState = isRecording
    ? "listening"
    : isSpeaking
      ? "speaking"
      : isProcessing
        ? "thinking"
        : "idle";
  const lastMessage = messages[messages.length - 1];
  // The answer being typed out right now: the computer's screen types it too
  const typingReply =
    lastMessage && lastMessage.role === "assistant" && lastMessage.streaming
      ? lastMessage.text
      : "";
  const waitingForReply =
    isProcessing && (!lastMessage || lastMessage.role !== "assistant");

  let statusLabel = "Connected";
  if (connection === "connecting") statusLabel = "Connecting";
  else if (connection === "offline") statusLabel = "Reconnecting";
  else if (botState === "listening") statusLabel = "Recording";
  else if (botState === "thinking") statusLabel = "Processing";
  else if (botState === "speaking") statusLabel = "Speaking";

  const busy = isProcessing || isSpeaking;

  let recordLabel = "Start recording";
  if (isRecording) recordLabel = "Stop recording";
  else if (!online) recordLabel = "Waiting for backend";
  else if (busy) recordLabel = "Interrupt and talk";

  return (
    <div className="page">
      <div className="top">
        <PixelEarth />
        <header className="topbar">
          <div className="topbar-left">
            <span className="label">Voice bot</span>
            <span className="marks" aria-hidden="true">
              × × ×
            </span>
          </div>
          <p className="topbar-right">
            If you can speak,
            <br />
            you can chat.
            <br />
            No typing needed!
          </p>
        </header>

        <section className="hero">
          <h1 className="hero-title">TALK TO HARVEY</h1>
          <div className="hero-intro">
            <p className="label">
              Your voice
              <br />
              assistant <span className="marks">× × ×</span>
            </p>
            <p className="hero-text">
              Press record, say something for a few seconds, and it answers out
              loud while the reply types out. Or type below and it clicks along
              with you.
            </p>
          </div>
        </section>
      </div>

      <main className="band">
        <section className="device device-stage" aria-label="Assistant">
          <div className="device-head">
            <span className="label">Assistant</span>
            <span
              className={`status status-${online ? botState : connection}`}
              role="status"
            >
              {online && botState !== "idle" ? (
                <ThinkingOrb
                  state={
                    botState === "listening"
                      ? "listening"
                      : botState === "speaking"
                        ? "composing"
                        : "working"
                  }
                  size={20}
                  theme="dark"
                  aria-hidden="true"
                />
              ) : (
                <span className="status-dot" aria-hidden="true" />
              )}
              {statusLabel}{" "}
            </span>
          </div>

          <CuteComputer
            state={botState}
            height="clamp(320px, 48vw, 540px)"
            screenText={typingReply}
          />

          <div className="record-row">
            <button
              type="button"
              className={`record-btn ${isRecording ? "is-recording" : ""}`}
              onClick={(e) => {
                e.currentTarget.blur();
                if (isRecording) stopRecording();
                else startRecording();
              }}
              disabled={!isRecording && !online}
            >
              {"{"}
              {recordLabel}
              {"}"}
            </button>
            {busy && !isRecording && (
              <button
                type="button"
                className="record-btn stop-btn"
                onClick={(e) => {
                  e.currentTarget.blur();
                  stopReply();
                }}
              >
                {"{"}
                {isSpeaking ? "Stop talking" : "Cancel"}
                {"}"}
              </button>
            )}
          </div>

          <label className="voice-toggle" htmlFor="voice-interrupt">
            <input
              id="voice-interrupt"
              type="checkbox"
              checked={voiceInterrupt}
              onChange={(e) => {
                setVoiceInterrupt(e.target.checked);
                e.target.blur();
              }}
            />
            Interrupt by talking over the bot (headphones only)
          </label>

          <div className={`latency-wrap${latencyPinned ? " is-pinned" : ""}`}>
            <button
              type="button"
              className="latency-btn"
              aria-expanded={latencyPinned}
              aria-controls="latency-pop"
              onClick={(e) => {
                e.currentTarget.blur();
                setLatencyPinned((pinned) => !pinned);
              }}
            >
              {"{"}Latency{"}"}
            </button>

            <div id="latency-pop" className="latency-pop">
              {latency ? (
                <div
                  className="latency"
                  aria-label="Timing of the last spoken reply"
                >
                  <div className="latency-head">
                    <span className="label">Last spoken reply</span>
                    {latency.heard_ms !== undefined && (
                      <span
                        className={
                          latency.heard_ms <= GOAL_MS
                            ? "latency-ok"
                            : "latency-slow"
                        }
                      >
                        {latency.heard_ms <= GOAL_MS
                          ? "Under 1.5 s"
                          : "Over 1.5 s"}
                      </span>
                    )}
                  </div>
                  <dl className="latency-list">
                    {LATENCY_ROWS.map(([key, name]) => {
                      const value = latency[key];
                      if (value === undefined) return null;
                      return (
                        <div
                          key={key}
                          className={`latency-row${key === "heard_ms" ? " is-total" : ""}`}
                        >
                          <dt>{name}</dt>
                          <dd>{value.toLocaleString()} ms</dd>
                        </div>
                      );
                    })}
                  </dl>
                </div>
              ) : (
                <div className="latency latency-empty">
                  Ask a question by voice to see the timings.
                </div>
              )}
              <LatencyChart history={latencyHistory} />
            </div>
          </div>

          <ol className="steps">
            {STEPS.map((step) => (
              <li
                key={step.id}
                className={`step ${botState === step.id ? "is-active" : ""}`}
              >
                <div className="step-title">
                  <PixelIcon shape={step.icon} />
                  {step.title}
                </div>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="device device-chat" aria-label="Conversation">
          <div className="device-head">
            <span className="label">
              <PixelIcon shape="chat" />
              Conversation
            </span>
            <span className="marks" aria-hidden="true">
              × × ×
            </span>
          </div>

          <div className="chat-list" ref={listRef} aria-live="polite">
            {messages.length === 0 && (
              <p className="chat-empty">
                No messages yet.
                <br />
                Press {"{start recording}"} or type below.
              </p>
            )}
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`msg msg-${msg.role}${msg.streaming ? " is-streaming" : ""}`}
              >
                <span className="msg-who">
                  {msg.role === "user"
                    ? "You"
                    : msg.role === "assistant"
                      ? "Bot"
                      : "Error"}
                </span>
                {msg.role === "assistant" ? (
                  <TypedMarkdown
                    text={msg.text}
                    animate={!!msg.typed}
                    frozen={!!msg.stopped}
                    onGrow={keepInView}
                  />
                ) : (
                  msg.text
                )}
                {msg.streaming && (
                  <span className="stream-cursor" aria-hidden="true" />
                )}
              </div>
            ))}
            {waitingForReply && (
              <div
                className="msg msg-orb"
                role="status"
                aria-label="Bot is thinking"
              >
              <ThinkingOrb state="searching" size={64} theme="dark" style={{ width: 36, height: 36 }} />
                <span className="msg-orb-text">Thinking…</span>
              </div>
            )}
          </div>

          <form className="chat-form" onSubmit={sendText}>
            <label htmlFor="chat-input" className="sr-only">
              Type a message
            </label>
            <input
              id="chat-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type a message..."
              autoComplete="off"
              disabled={isRecording}
            />
            <button
              type="submit"
              className="send-btn"
              disabled={!draft.trim() || isProcessing || !online}
            >
              Send
            </button>
          </form>
        </section>
      </main>

      <footer className="footer">
        <span>Frontend :3000</span>
        <span>Backend :5000</span>
        <span>AI layer :8000</span>
      </footer>
    </div>
  );
}

export default App;
  