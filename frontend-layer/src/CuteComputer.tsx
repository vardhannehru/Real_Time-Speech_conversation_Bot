import React, { useEffect, useRef } from 'react';
import { MODE_DRAWS, resolvePreset } from 'thinking-orbs';

const TAU = Math.PI * 2;
const GLOW = '#A6F46B';
const GLOW_RGB = '166,244,107';
const ACCENT = '#A6F46B';

// Keyboard click loudness: 1 is normal. Use up to 1.2 for louder clicks, or 0.5 for softer ones.
const CLICK_VOLUME = 1;

// How long a finished answer stays on the screen before the face comes back (seconds)
const SCREEN_HOLD_S = 6;

export type BotState = 'idle' | 'listening' | 'thinking' | 'speaking';

type Point = [number, number];
type ClickKind = 'key' | 'space' | 'up' | 'click';

interface KeyInfo {
  code: string;
  w: number;
  r: number;
  u: number;
  down: boolean;
  press: number;
  flash: number;
}

interface CuteComputerProps {
  state?: BotState;
  height?: number | string;
  sound?: boolean;
  screenText?: string; // the answer while it is being typed out
}

const KB_ROWS: [string, number][][] = [
  [['ControlLeft', 1.5], ['AltLeft', 1.25], ['Space', 6.5], ['AltRight', 1.25], ['ControlRight', 1.5]],
  [['ShiftLeft', 2], ['KeyZ', 1], ['KeyX', 1], ['KeyC', 1], ['KeyV', 1], ['KeyB', 1], ['KeyN', 1], ['KeyM', 1], ['Comma', 1], ['Period', 1], ['Slash', 1]],
  [['CapsLock', 1.25], ['KeyA', 1], ['KeyS', 1], ['KeyD', 1], ['KeyF', 1], ['KeyG', 1], ['KeyH', 1], ['KeyJ', 1], ['KeyK', 1], ['KeyL', 1], ['Enter', 1.75]],
  [['Tab', 1], ['KeyQ', 1], ['KeyW', 1], ['KeyE', 1], ['KeyR', 1], ['KeyT', 1], ['KeyY', 1], ['KeyU', 1], ['KeyI', 1], ['KeyO', 1], ['KeyP', 1], ['BracketLeft', 1]],
  [['Backquote', 1], ['Digit1', 1], ['Digit2', 1], ['Digit3', 1], ['Digit4', 1], ['Digit5', 1], ['Digit6', 1], ['Digit7', 1], ['Digit8', 1], ['Digit9', 1], ['Digit0', 1], ['Backspace', 1]],
];

// Markdown symbols look messy on a tiny screen: keep just the words, and bullets as dots
function toScreenText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, '')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '• ')
    .replace(/[*`]/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// The key on the drawn keyboard for a typed character
const CHAR_KEYS: Record<string, string> = { ' ': 'Space', '\n': 'Enter', '.': 'Period', ',': 'Comma', '?': 'Slash', '/': 'Slash' };
function keyCodeFor(ch: string): string {
  if (CHAR_KEYS[ch]) return CHAR_KEYS[ch];
  if (/[a-z]/i.test(ch)) return `Key${ch.toUpperCase()}`;
  if (/[0-9]/.test(ch)) return `Digit${ch}`;
  return '';
}

const KEY_ALIAS: Record<string, string> = {
  ShiftRight: 'ShiftLeft', MetaLeft: 'AltLeft', MetaRight: 'AltRight', OSLeft: 'AltLeft', OSRight: 'AltRight',
  Semicolon: 'KeyL', Quote: 'Enter', NumpadEnter: 'Enter', Minus: 'Digit0', Equal: 'Backspace', Delete: 'Backspace',
  BracketRight: 'BracketLeft', Backslash: 'BracketLeft', Escape: 'Backquote',
  ArrowLeft: 'ControlRight', ArrowRight: 'ControlRight', ArrowUp: 'ControlRight', ArrowDown: 'ControlRight',
};

export default function CuteComputer({ state = 'idle', height = 300, sound = true, screenText = '' }: CuteComputerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  const soundRef = useRef(sound);
  const screenTextRef = useRef('');

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { soundRef.current = sound; }, [sound]);
  useEffect(() => { screenTextRef.current = toScreenText(screenText); }, [screenText]);

  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const S = { t: 0, listen: 0, think: 0, speak: 0, level: 0, blink: 0, nextBlink: 2.2, text: 0 };
    const C = { yaw: 0, pitch: 0, lx: 0, ly: 0 };
    const MS = { dx: 0, dy: 0 };
    const MB = { press: 0 };
    const PTR = { x: 0, y: 0, vx: 0.5, vy: 0.5, active: false };
    const TYPE = { text: '', at: -10, u: 0.5 };
    const SCREEN = { text: '', live: false, endedAt: 0 };
    let wrapped = { key: '', lines: [] as string[] };
    let realT = 0;

    const keyMap: Record<string, KeyInfo> = {};
    const keyList: KeyInfo[] = [];
    KB_ROWS.forEach((row, r) => {
      let acc = 0;
      row.forEach(([code, w]) => {
        const key: KeyInfo = { code, w, r, u: (acc + w / 2) / 12, down: false, press: 0, flash: 0 };
        acc += w;
        keyMap[code] = key;
        keyList.push(key);
      });
    });

    let W = 0;
    let H = 0;
    const resize = () => {
      const rect = cvs.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = rect.width;
      H = rect.height;
      cvs.width = Math.max(1, Math.round(W * dpr));
      cvs.height = Math.max(1, Math.round(H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(cvs);
    resize();

    // ---------- keyboard sounds ----------
    let audioCtx: AudioContext | null = null;
    let noise: AudioBuffer | null = null;
    const getAudio = (): AudioContext | null => {
      if (!audioCtx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        audioCtx = new Ctor();
        const len = Math.floor(audioCtx.sampleRate * 0.08);
        noise = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
        const data = noise.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    };

    const playClick = (kind: ClickKind) => {
      if (!soundRef.current) return;
      const ac = getAudio();
      if (!ac) return;
      const now = ac.currentTime;
      const vol = (kind === 'up' ? 0.35 : kind === 'click' ? 0.8 : 1) * CLICK_VOLUME;
      const src = ac.createBufferSource();
      src.buffer = noise;
      src.playbackRate.value = 0.85 + Math.random() * 0.3;
      const bp = ac.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = kind === 'space' ? 1400 : kind === 'up' ? 3200 : kind === 'click' ? 3000 : 2200 + Math.random() * 800;
      bp.Q.value = 0.9;
      const gain = ac.createGain();
      gain.gain.setValueAtTime(vol, now);
      const decay = kind === 'space' ? 0.12 : kind === 'key' ? 0.07 : kind === 'click' ? 0.06 : 0.05;
      gain.gain.exponentialRampToValueAtTime(0.0008, now + decay);
      src.connect(bp);
      bp.connect(gain);
      gain.connect(ac.destination);
      src.start(now);
      src.stop(now + 0.12);
      if (kind === 'key' || kind === 'space') {
        const osc = ac.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(kind === 'space' ? 110 : 170 + Math.random() * 50, now);
        osc.frequency.exponentialRampToValueAtTime(55, now + 0.05);
        const oscGain = ac.createGain();
        oscGain.gain.setValueAtTime((kind === 'space' ? 0.45 : 0.35) * CLICK_VOLUME, now);
        oscGain.gain.exponentialRampToValueAtTime(0.0008, now + 0.06);
        osc.connect(oscGain);
        oscGain.connect(ac.destination);
        osc.start(now);
        osc.stop(now + 0.08);
      }
    };

    // ---------- your real keyboard and mouse ----------
    const keyFor = (e: KeyboardEvent): KeyInfo => {
      const code = KEY_ALIAS[e.code] || e.code;
      if (keyMap[code]) return keyMap[code];
      const ch = (e.key || 'a').charCodeAt(0) || 97;
      return keyList[ch % keyList.length];
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!SCREEN.live) SCREEN.text = '';
      const key = keyFor(e);
      if (!key.down) key.flash = 1;
      key.down = true;
      if (e.code === 'Space' && e.target === document.body) e.preventDefault();
      if (!e.repeat) playClick(key.code === 'Space' ? 'space' : 'key');
      TYPE.at = realT;
      TYPE.u = key.u;
      if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey) TYPE.text = (TYPE.text + e.key).slice(-24);
      else if (e.key === 'Backspace') TYPE.text = TYPE.text.slice(0, -1);
      else if (e.key === 'Enter') TYPE.text = '';
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keyFor(e).down = false;
      playClick('up');
    };
    const onBlur = () => {
      keyList.forEach((key) => { key.down = false; });
    };
    const onPointerMove = (e: PointerEvent) => {
      const rect = cvs.getBoundingClientRect();
      PTR.x = e.clientX - rect.left;
      PTR.y = e.clientY - rect.top;
      PTR.vx = e.clientX / Math.max(1, window.innerWidth);
      PTR.vy = e.clientY / Math.max(1, window.innerHeight);
      PTR.active = true;
    };
    const onPointerDown = () => {
      MB.press = 1;
      playClick('click');
    };
    const onMouseLeave = () => { PTR.active = false; };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerdown', onPointerDown);
    document.documentElement.addEventListener('mouseleave', onMouseLeave);

    // ---------- the answer on the screen ----------
    const syncScreen = () => {
      const next = screenTextRef.current;
      if (!next) {
        if (SCREEN.live) {
          SCREEN.live = false;
          SCREEN.endedAt = performance.now();
        }
        return;
      }
      if (next !== SCREEN.text) {
        const added = next.startsWith(SCREEN.text) ? next.slice(SCREEN.text.length) : '';
        for (let i = Math.max(0, added.length - 3); i < added.length; i++) {
          const key = keyMap[keyCodeFor(added[i])];
          if (key) key.flash = 1;
        }
        SCREEN.text = next;
      }
      SCREEN.live = true;
    };

    // Break the text into lines that fit the screen (only when the text or size changes)
    const wrapLines = (text: string, maxW: number): string[] => {
      const cacheKey = `${ctx.font}|${Math.round(maxW)}|${text}`;
      if (wrapped.key === cacheKey) return wrapped.lines;
      const lines: string[] = [];
      text.split('\n').forEach((para) => {
        let line = '';
        para.split(' ').forEach((word) => {
          const test = line ? `${line} ${word}` : word;
          if (!line || ctx.measureText(test).width <= maxW) line = test;
          else {
            lines.push(line);
            line = word;
          }
        });
        lines.push(line);
      });
      wrapped = { key: cacheKey, lines };
      return lines;
    };

    // ---------- drawing helpers ----------
    const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
    const poly = (pts: Point[], fill: string) => {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    };
    const hull = (points: Point[]): Point[] => {
      const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
      const lower: Point[] = [];
      const upper: Point[] = [];
      for (let i = 0; i < pts.length; i++) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
        lower.push(pts[i]);
      }
      for (let i = pts.length - 1; i >= 0; i--) {
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
        upper.push(pts[i]);
      }
      upper.pop();
      lower.pop();
      return lower.concat(upper);
    };
    const rrect = (x: number, y: number, w: number, h: number, r: number) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    };
    const box = (
      x: number, y: number, w: number, h: number, ox: number, oy: number,
      front: string, top: string, side: string, r: number,
    ) => {
      const fTL: Point = [x, y];
      const fTR: Point = [x + w, y];
      const fBR: Point = [x + w, y + h];
      const fBL: Point = [x, y + h];
      const bTL: Point = [x + ox, y + oy];
      const bTR: Point = [x + w + ox, y + oy];
      const bBR: Point = [x + w + ox, y + h + oy];
      const bBL: Point = [x + ox, y + h + oy];
      poly(hull([fTL, fTR, fBR, fBL, bTL, bTR, bBR, bBL]), side);
      if (oy < 0) poly([fTL, fTR, bTR, bTL], top);
      rrect(x, y, w, h, r);
      ctx.fillStyle = front;
      ctx.fill();
    };
    const shadow = (x: number, y: number, rx: number, ry: number, a: number) => {
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
      ctx.fillStyle = `rgba(0,0,0,${a})`;
      ctx.fill();
    };
    const blinkScale = (dt: number) => {
      if (reduced) return 1;
      S.nextBlink -= dt;
      if (S.nextBlink <= 0 && S.blink <= 0) {
        S.blink = 0.17;
        S.nextBlink = 2.4 + Math.random() * 3.2;
      }
      if (S.blink > 0) {
        const p = Math.max(0, Math.min(1, 1 - S.blink / 0.17));
        S.blink -= dt;
        return 1 - Math.sin(p * Math.PI) * 0.9;
      }
      return 1;
    };

    // ---------- the scene ----------
    const draw = (dt: number, current: BotState) => {
      const t = S.t;
      const cx = W / 2;
      const cy = H / 2;
      const k = Math.min(H * 1.9, W * 1.02);
      let g: CanvasGradient;

      ctx.fillStyle = '#171717';
      ctx.fillRect(0, 0, W, H);
      g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.7);
      g.addColorStop(0, 'rgba(255,255,255,0.05)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      const py0 = cy + k * 0.08;

      // desk
      ctx.beginPath(); ctx.ellipse(cx, py0 + k * 0.025, k * 0.46, k * 0.145, 0, 0, TAU); ctx.fillStyle = '#09090B'; ctx.fill();
      ctx.beginPath(); ctx.ellipse(cx, py0, k * 0.46, k * 0.145, 0, 0, TAU); ctx.fillStyle = '#1B1B21'; ctx.fill();
      ctx.save();
      ctx.beginPath(); ctx.ellipse(cx, py0, k * 0.46, k * 0.145, 0, 0, TAU); ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.045)';
      ctx.lineWidth = 1;
      for (let n = -7; n <= 7; n++) {
        ctx.beginPath(); ctx.moveTo(cx + n * k * 0.07 - k * 0.25, py0 - k * 0.16); ctx.lineTo(cx + n * k * 0.07 + k * 0.25, py0 + k * 0.16); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx + n * k * 0.07 + k * 0.25, py0 - k * 0.16); ctx.lineTo(cx + n * k * 0.07 - k * 0.25, py0 + k * 0.16); ctx.stroke();
      }
      const lampX = cx - k * 0.3;
      const lampY = py0 - k * 0.04;
      g = ctx.createRadialGradient(lampX + k * 0.12, py0, 0, lampX + k * 0.12, py0, k * 0.26);
      g.addColorStop(0, `rgba(${GLOW_RGB},${0.2 + 0.12 * S.speak + 0.1 * S.level})`);
      g.addColorStop(1, `rgba(${GLOW_RGB},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(cx - k * 0.5, py0 - k * 0.2, k, k * 0.4);
      ctx.restore();

      // lamp
      shadow(lampX, lampY + k * 0.01, k * 0.05, k * 0.016, 0.4);
      ctx.beginPath(); ctx.ellipse(lampX, lampY, k * 0.045, k * 0.016, 0, 0, TAU); ctx.fillStyle = '#6DAA3F'; ctx.fill();
      ctx.beginPath(); ctx.ellipse(lampX, lampY - k * 0.006, k * 0.045, k * 0.015, 0, 0, TAU); ctx.fillStyle = ACCENT; ctx.fill();
      const hx = lampX + k * 0.05;
      const hy = lampY - k * 0.24;
      ctx.strokeStyle = '#8FD957';
      ctx.lineWidth = Math.max(2, k * 0.009);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(lampX, lampY - k * 0.01); ctx.lineTo(lampX - k * 0.035, lampY - k * 0.15); ctx.lineTo(hx - k * 0.01, hy + k * 0.005); ctx.stroke();
      g = ctx.createRadialGradient(hx + k * 0.04, hy + k * 0.06, 0, hx + k * 0.04, hy + k * 0.06, k * 0.08);
      g.addColorStop(0, `rgba(214,255,184,${0.55 + 0.3 * S.speak})`);
      g.addColorStop(1, 'rgba(214,255,184,0)');
      ctx.fillStyle = g;
      ctx.fillRect(hx - k * 0.06, hy - k * 0.04, k * 0.2, k * 0.2);
      ctx.beginPath();
      ctx.moveTo(hx - k * 0.04, hy - k * 0.01);
      ctx.lineTo(hx + k * 0.03, hy - k * 0.055);
      ctx.lineTo(hx + k * 0.1, hy + k * 0.045);
      ctx.quadraticCurveTo(hx + k * 0.03, hy + k * 0.085, hx - k * 0.02, hy + k * 0.05);
      ctx.closePath();
      ctx.fillStyle = ACCENT;
      ctx.fill();
      ctx.beginPath(); ctx.ellipse(hx + k * 0.045, hy + k * 0.055, k * 0.018, k * 0.01, -0.6, 0, TAU); ctx.fillStyle = '#EFFFE3'; ctx.fill();

      // plant
      const ptx = cx + k * 0.215;
      const pty = py0 - k * 0.075;
      shadow(ptx, pty + k * 0.045, k * 0.035, k * 0.012, 0.4);
      for (let n = 0; n < 6; n++) {
        const la = -Math.PI / 2 + (n - 2.5) * 0.42 + Math.sin(t * 1.2 + n) * 0.06;
        ctx.save();
        ctx.translate(ptx + Math.cos(la) * k * 0.035, pty - k * 0.005 + Math.sin(la) * k * 0.035);
        ctx.rotate(la);
        ctx.beginPath();
        ctx.ellipse(0, 0, k * 0.036, k * 0.012, 0, 0, TAU);
        ctx.fillStyle = n % 2 ? '#5E9F6F' : '#79B886';
        ctx.fill();
        ctx.restore();
      }
      poly([[ptx - k * 0.026, pty], [ptx + k * 0.026, pty], [ptx + k * 0.02, pty + k * 0.045], [ptx - k * 0.02, pty + k * 0.045]], '#E7DFD1');
      ctx.beginPath(); ctx.ellipse(ptx, pty, k * 0.026, k * 0.007, 0, 0, TAU); ctx.fillStyle = '#F4EEE4'; ctx.fill();

      // where the computer looks
      const baseY = py0 - k * 0.03;
      const monCY = baseY - k * 0.15;
      let tnx: number;
      let tny: number;
      if (PTR.active) {
        tnx = clamp((PTR.x - cx) / (W * 0.42), -1, 1);
        tny = clamp((PTR.y - monCY) / (H * 0.42), -1, 1);
      } else {
        tnx = 0.35 * Math.sin(t * 0.4);
        tny = 0.15 * Math.sin(t * 0.53 + 1);
      }
      if (realT - TYPE.at < 1.2) {
        tnx = (TYPE.u - 0.5) * 1.2;
        tny = 0.75;
      }
      if (current === 'thinking') {
        tnx = 0.55 + 0.25 * Math.sin(t * 2.2);
        tny = -0.85;
      }
      const sm = 1 - Math.exp(-dt * 6);
      const se = 1 - Math.exp(-dt * 10);
      C.yaw += (tnx - C.yaw) * sm;
      C.pitch += (tny - C.pitch) * sm;
      C.lx += (tnx - C.lx) * se;
      C.ly += (tny - C.ly) * se;

      // computer base
      shadow(cx + k * 0.02, baseY + k * 0.075, k * 0.19, k * 0.03, 0.45);
      box(cx - k * 0.15, baseY, k * 0.3, k * 0.07, k * 0.025, -k * 0.03, '#EFE9DE', '#F8F4EC', '#D3CBBC', k * 0.01);
      ctx.fillStyle = ACCENT; rrect(cx - k * 0.13, baseY + k * 0.022, k * 0.035, k * 0.012, k * 0.004); ctx.fill();
      ctx.fillStyle = '#CFC7B8'; rrect(cx + k * 0.02, baseY + k * 0.03, k * 0.09, k * 0.008, k * 0.004); ctx.fill();

      // monitor
      const fw = k * 0.27 * (1 - 0.1 * Math.abs(C.yaw));
      const fh = k * 0.22;
      const mx = cx + C.yaw * k * 0.03;
      const my = monCY + C.pitch * k * 0.015;
      const D = k * 0.1;
      const ox = D * (0.28 - 0.85 * C.yaw);
      const oy = -D * (0.32 + 0.45 * C.pitch);
      ctx.fillStyle = '#CFC7B8';
      ctx.fillRect(cx - k * 0.03, my + fh / 2 - k * 0.01, k * 0.06, baseY - (my + fh / 2) + k * 0.01);
      const fx = mx - fw / 2;
      const fy = my - fh / 2;
      box(fx, fy, fw, fh, ox, oy, '#EFE9DE', '#F8F4EC', '#D3CBBC', k * 0.018);

      // screen
      const sx = fx + k * 0.017;
      const sy = fy + k * 0.017;
      const sw = fw - k * 0.034;
      const sh = fh * 0.72;
      rrect(sx, sy, sw, sh, k * 0.014);
      ctx.fillStyle = '#131619';
      ctx.fill();
      ctx.save();
      rrect(sx, sy, sw, sh, k * 0.014);
      ctx.clip();
      g = ctx.createRadialGradient(sx + sw / 2, sy + sh / 2, 0, sx + sw / 2, sy + sh / 2, sw * 0.7);
      g.addColorStop(0, `rgba(${GLOW_RGB},${0.1 + 0.08 * S.speak + 0.08 * S.level})`);
      g.addColorStop(1, `rgba(${GLOW_RGB},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(sx, sy, sw, sh);

      syncScreen();
      const answerOnScreen =
        SCREEN.text !== '' &&
        (SCREEN.live || (current === 'idle' && performance.now() - SCREEN.endedAt < SCREEN_HOLD_S * 1000));
      S.text += ((answerOnScreen ? 1 : 0) - S.text) * (1 - Math.exp(-dt * 8));
           const orbMix = Math.max(S.listen, S.think) * (1 - S.text);
      ctx.globalAlpha = (1 - S.text) * (1 - orbMix);

      // face
      const ex = sx + sw / 2 + C.lx * sw * 0.16;
      const ey = sy + sh * 0.44 + C.ly * sh * 0.14;
      const eyeW = k * 0.02;
      const eyeH = Math.max(k * 0.005, k * 0.056 * (1 + 0.15 * S.listen - 0.22 * S.speak) * blinkScale(dt));
      const gap = k * 0.034;
      ctx.fillStyle = GLOW;
      ctx.shadowColor = `rgba(${GLOW_RGB},0.85)`;
      ctx.shadowBlur = k * 0.03;
      rrect(ex - gap - eyeW / 2, ey - eyeH / 2, eyeW, eyeH, Math.min(eyeW, eyeH) / 2); ctx.fill();
      rrect(ex + gap - eyeW / 2, ey - eyeH / 2, eyeW, eyeH, Math.min(eyeW, eyeH) / 2); ctx.fill();
      const mouthY = ey + k * 0.048;
      if (S.speak > 0.5) {
        const mh = k * 0.006 + S.level * k * 0.026;
        const mw = k * 0.03;
        rrect(ex - mw / 2, mouthY - mh / 2, mw, mh, Math.min(mw, mh) / 2);
        ctx.fill();
      } else {
        ctx.strokeStyle = GLOW;
        ctx.lineWidth = Math.max(1.5, k * 0.005);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(ex, mouthY - k * 0.014, k * 0.014, Math.PI * 0.2, Math.PI * 0.8);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;

      // the answer, typed out in small letters with the newest lines at the bottom
      if (S.text > 0.02 && SCREEN.text) {
        const size = Math.max(7, Math.round(k * 0.0135));
        const pad = k * 0.012;
        const lineH = size * 1.3;
        ctx.font = `${size}px Consolas, 'Courier New', monospace`;
        ctx.textBaseline = 'top';
        const lines = wrapLines(SCREEN.text, sw - pad * 2);
        const fit = Math.max(1, Math.floor((sh - pad * 2) / lineH));
        const shown = lines.slice(-fit);
        const caret = SCREEN.live && Math.floor(realT * 2.5) % 2 ? '_' : '';
        ctx.fillStyle = `rgba(${GLOW_RGB},${0.92 * S.text})`;
        ctx.shadowColor = `rgba(${GLOW_RGB},0.45)`;
        ctx.shadowBlur = k * 0.005;
        shown.forEach((line, i) => {
          const text = i === shown.length - 1 ? line + caret : line;
          ctx.fillText(text, sx + pad, sy + pad + i * lineH);
        });
        ctx.shadowBlur = 0;
      }
      // orb on the screen: "listening" while you talk, "solving" while the answer is being worked out
      if (orbMix > 0.02) {
        const orb = resolvePreset(S.listen >= S.think ? 'listening' : 'solving', 64);
        const scale = (sh * 0.62) / 64;
        ctx.save();
        ctx.globalAlpha = orbMix;
        ctx.translate(sx + sw / 2 - 32 * scale, sy + sh * 0.46 - 32 * scale);
        ctx.scale(scale, scale);
        MODE_DRAWS[orb.mode](ctx, 64, t * orb.speed, true, orb.opts);
        ctx.restore();
      }

      // listening: sound bars
      if (S.listen > 0.02) {
        for (let n = 0; n < 5; n++) {
          const bh = (k * 0.006 + S.level * k * 0.026 * (0.5 + 0.5 * Math.sin(realT * 9 + n * 1.3))) * S.listen;
          ctx.fillStyle = `rgba(${GLOW_RGB},${0.8 * S.listen})`;
          ctx.fillRect(sx + sw / 2 - k * 0.034 + n * k * 0.015, sy + sh - k * 0.014 - bh, k * 0.008, bh);
        }
      }
      // thinking: dots
      if (S.think > 0.02) {
        for (let n = 0; n < 3; n++) {
          const da = 0.25 + 0.75 * Math.max(0, Math.sin(t * 5 - n * 0.9));
          ctx.fillStyle = `rgba(${GLOW_RGB},${da * S.think * (1 - S.text)})`;
          ctx.beginPath();
          ctx.arc(sx + sw / 2 + (n - 1) * k * 0.018, sy + sh - k * 0.02, k * 0.005, 0, TAU);
          ctx.fill();
        }
      }
      // what you typed
      if (realT - TYPE.at < 2.5 && TYPE.text && current === 'idle') {
        ctx.fillStyle = `rgba(${GLOW_RGB},${Math.min(1, (2.5 - (realT - TYPE.at)) * 1.5) * 0.85})`;
        ctx.font = `${Math.max(9, Math.round(k * 0.02))}px Consolas, monospace`;
        ctx.textBaseline = 'top';
        const caret = Math.floor(realT * 2.5) % 2 ? '_' : ' ';
        ctx.fillText(`> ${TYPE.text.slice(-12)}${caret}`, sx + k * 0.014, sy + k * 0.012);
      }
      ctx.restore();

      ctx.fillStyle = ACCENT;
      ctx.beginPath(); ctx.arc(fx + fw - k * 0.035, fy + fh - k * 0.03, k * 0.008, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#CFC7B8';
      ctx.lineWidth = Math.max(1, k * 0.004);
      for (let n = 0; n < 3; n++) {
        ctx.beginPath();
        ctx.moveTo(fx + k * 0.025 + n * k * 0.012, fy + fh - k * 0.04);
        ctx.lineTo(fx + k * 0.025 + n * k * 0.012, fy + fh - k * 0.02);
        ctx.stroke();
      }

      // books
      const bx = cx - k * 0.39;
      const by = py0 + k * 0.035;
      shadow(bx + k * 0.08, by + k * 0.025, k * 0.09, k * 0.02, 0.45);
      box(bx, by, k * 0.13, k * 0.02, k * 0.03, -k * 0.035, '#256F69', '#3BA79E', '#1E5B56', k * 0.003);
      box(bx + k * 0.008, by - k * 0.02, k * 0.12, k * 0.02, k * 0.03, -k * 0.035, '#E4DCCB', '#F3EDE2', '#CFC6B4', k * 0.003);
      box(bx - k * 0.004, by - k * 0.04, k * 0.125, k * 0.02, k * 0.03, -k * 0.035, '#8FD957', ACCENT, '#6DAA3F', k * 0.003);

      // keyboard
      const kfl: Point = [cx - k * 0.175, py0 + k * 0.11];
      const kfr: Point = [cx + k * 0.125, py0 + k * 0.11];
      const kox = k * 0.045;
      const koy = -k * 0.078;
      shadow(cx - k * 0.01, py0 + k * 0.1, k * 0.17, k * 0.035, 0.45);
      ctx.strokeStyle = '#DCD5C8';
      ctx.lineWidth = Math.max(1, k * 0.004);
      ctx.beginPath();
      ctx.moveTo(cx - k * 0.02 + kox * 0.5, kfl[1] + koy);
      ctx.bezierCurveTo(cx - k * 0.02, py0, cx + k * 0.05, py0, cx + k * 0.06, baseY + k * 0.07);
      ctx.stroke();
      poly([kfl, kfr, [kfr[0], kfr[1] + k * 0.012], [kfl[0], kfl[1] + k * 0.012]], '#CFC7B8');
      poly([kfl, kfr, [kfr[0] + kox, kfr[1] + koy], [kfl[0] + kox, kfl[1] + koy]], '#EEE8DD');
      const tick = Math.floor(t * 7);
      const unit = ((kfr[0] - kfl[0]) * 0.92) / 12;
      const keyH = k * 0.0085;
      const decay = Math.exp(-dt * 16);
      keyList.forEach((key, n) => {
        key.flash *= decay;
        key.press = key.down ? 1 : key.press * decay;
        let kp = Math.max(key.press, key.flash);
        if (current === 'thinking' && (n * 7 + tick * 31) % 19 === 0) kp = Math.max(kp, 0.8);
        const kv = 0.1 + ((key.r + 0.5) / KB_ROWS.length) * 0.8;
        const ku = 0.04 + key.u * 0.92;
        const kx = kfl[0] + (kfr[0] - kfl[0]) * ku + kox * kv;
        const ky = kfl[1] + koy * kv;
        const kw = key.w * unit - k * 0.004;
        const special = key.code === 'Enter' || key.code === 'Backspace';
        ctx.fillStyle = '#B8B0A2';
        ctx.fillRect(kx - kw / 2, ky - keyH / 2 + k * 0.0032, kw, keyH);
        if (kp > 0.15) ctx.fillStyle = special ? '#E3FFCF' : ACCENT;
        else ctx.fillStyle = special ? ACCENT : '#DDD6C9';
        ctx.fillRect(kx - kw / 2, ky - keyH / 2 + kp * k * 0.0028, kw, keyH);
      });

      // mouse
      MS.dx += (PTR.vx - 0.5 - MS.dx) * se;
      MS.dy += (PTR.vy - 0.5 - MS.dy) * se;
      MB.press *= decay;
      const msx = cx + k * 0.21 + MS.dx * k * 0.08;
      const msy = py0 + k * 0.085 + MS.dy * k * 0.035;
      ctx.strokeStyle = '#DCD5C8';
      ctx.lineWidth = Math.max(1, k * 0.0035);
      ctx.beginPath();
      ctx.moveTo(msx - k * 0.004, msy - k * 0.013);
      ctx.quadraticCurveTo(msx - k * 0.01, msy - k * 0.05, kfr[0] + kox * 0.95, kfr[1] + koy * 0.95);
      ctx.stroke();
      shadow(msx + k * 0.004, msy + k * 0.01, k * 0.026, k * 0.011, 0.45);
      ctx.beginPath(); ctx.ellipse(msx, msy, k * 0.022, k * 0.014, -0.3, 0, TAU); ctx.fillStyle = '#EFE9DE'; ctx.fill();
      if (MB.press > 0.05) {
        ctx.save();
        ctx.beginPath(); ctx.ellipse(msx, msy, k * 0.022, k * 0.014, -0.3, 0, TAU); ctx.clip();
        ctx.fillStyle = `rgba(${GLOW_RGB},${0.85 * MB.press})`;
        ctx.fillRect(msx - k * 0.03, msy - k * 0.03, k * 0.03, k * 0.028);
        ctx.restore();
      }
      ctx.strokeStyle = '#CFC7B8';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(msx - k * 0.01, msy - k * 0.008); ctx.lineTo(msx + k * 0.005, msy); ctx.stroke();

      // mug with steam
      const mgx = cx + k * 0.3;
      const mgy = py0;
      shadow(mgx, mgy + k * 0.055, k * 0.035, k * 0.012, 0.45);
      ctx.strokeStyle = '#E8E2D6';
      ctx.lineWidth = Math.max(2, k * 0.008);
      ctx.beginPath(); ctx.arc(mgx + k * 0.027, mgy + k * 0.025, k * 0.014, -Math.PI / 2, Math.PI / 2); ctx.stroke();
      ctx.fillStyle = '#F2EEE6';
      ctx.fillRect(mgx - k * 0.026, mgy, k * 0.052, k * 0.052);
      ctx.beginPath(); ctx.ellipse(mgx, mgy + k * 0.052, k * 0.026, k * 0.008, 0, 0, Math.PI); ctx.fill();
      ctx.fillStyle = ACCENT;
      ctx.fillRect(mgx - k * 0.026, mgy + k * 0.02, k * 0.052, k * 0.012);
      ctx.beginPath(); ctx.ellipse(mgx, mgy, k * 0.026, k * 0.008, 0, 0, TAU); ctx.fillStyle = '#FBF8F2'; ctx.fill();
      ctx.beginPath(); ctx.ellipse(mgx, mgy + k * 0.001, k * 0.02, k * 0.005, 0, 0, TAU); ctx.fillStyle = '#6B4A34'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = Math.max(1.2, k * 0.004);
      ctx.lineCap = 'round';
      for (let n = 0; n < 2; n++) {
        const st = (t * 0.35 + n * 0.5) % 1;
        const s0x = mgx - k * 0.008 + n * k * 0.016;
        const s0y = mgy - k * 0.01 - st * k * 0.05;
        ctx.globalAlpha = Math.sin(st * Math.PI);
        ctx.beginPath();
        ctx.moveTo(s0x, s0y);
        ctx.quadraticCurveTo(s0x + k * 0.01, s0y - k * 0.02, s0x, s0y - k * 0.04);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    // ---------- animation loop ----------
    let last = performance.now();
    let rafId = 0;
    const frame = (now: number) => {
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      realT += dt;
      const current = stateRef.current;
      S.t += dt * (reduced ? 0.3 : 1);
      const ease = 1 - Math.exp(-dt * 5);
      S.listen += ((current === 'listening' ? 1 : 0) - S.listen) * ease;
      S.think += ((current === 'thinking' ? 1 : 0) - S.think) * ease;
      S.speak += ((current === 'speaking' ? 1 : 0) - S.speak) * ease;
      const wave = Math.max(0, 0.45 * Math.sin(realT * 8.3) + 0.35 * Math.sin(realT * 13.1 + 1.2) + 0.3 * Math.sin(realT * 2.9 + 0.4));
      const active = current === 'listening' || current === 'speaking';
      const target = active ? Math.min(1, wave) * (reduced ? 0.3 : 1) : 0;
      S.level += (target - S.level) * (1 - Math.exp(-dt * 12));
      if (W > 0 && H > 0) draw(dt, current);
      rafId = requestAnimationFrame(frame);
    };
    rafId = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerdown', onPointerDown);
      document.documentElement.removeEventListener('mouseleave', onMouseLeave);
      if (audioCtx) audioCtx.close();
    };
  }, []);

  return (
    <div className="computer-stage" style={{ height }}>
      <canvas ref={canvasRef} className="computer-canvas" role="img" aria-label={`Cute computer assistant, ${state}`} />
    </div>
  );
}
