import React, { useEffect, useRef } from "react";

const OCEAN = ["#1B4470", "#265F92", "#3582BC", "#5DB0D6"];
const LAND = ["#2B612C", "#3B8436", "#58A745", "#8CCB57"];
const CLOUD = ["#CFD6CC", "#F2F1E6"];
const RIM = "#EADDB6";

function hash(x: number, y: number, z: number): number {
  let h =
    Math.imul(x, 374761393) ^
    Math.imul(y, 668265263) ^
    Math.imul(z, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const u = smooth(x - xi);
  const v = smooth(y - yi);
  const w = smooth(z - zi);
  const a = lerp(hash(xi, yi, zi), hash(xi + 1, yi, zi), u);
  const b = lerp(hash(xi, yi + 1, zi), hash(xi + 1, yi + 1, zi), u);
  const c = lerp(hash(xi, yi, zi + 1), hash(xi + 1, yi, zi + 1), u);
  const d = lerp(hash(xi, yi + 1, zi + 1), hash(xi + 1, yi + 1, zi + 1), u);
  return lerp(lerp(a, b, v), lerp(c, d, v), w);
}

function fbm(x: number, y: number, z: number): number {
  return (
    noise3(x, y, z) * 0.6 +
    noise3(x * 2.1 + 5.2, y * 2.1, z * 2.1) * 0.3 +
    noise3(x * 4.3, y * 4.3 + 1.7, z * 4.3) * 0.1
  );
}

export default function PixelEarth() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    let W = 0;
    let H = 0;
    let rot = 0;

    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      if (W === 0 || H === 0) return;
      const cell = Math.max(6, Math.round(Math.min(W, 1400) / 130));

      // dark pixel squares fading down from the top
      const fadeRows = Math.ceil((H * 0.32) / cell);
      const cols = Math.ceil(W / cell);
      for (let j = 0; j < fadeRows; j++) {
        const density = 0.38 * (1 - j / fadeRows);
        for (let i = 0; i < cols; i++) {
          if (hash(i, j, 7) < density) {
            ctx.fillStyle = hash(i, j, 9) < 0.5 ? "#0C0C0C" : "#202020";
            ctx.fillRect(i * cell, j * cell, cell + 0.5, cell + 0.5);
          }
        }
      }

      // the globe, rising from the bottom edge
      const R = Math.min(W * 0.33, H * 0.95);
      const cx = W * 0.72;
      const cy = H + R * 0.1;
      const rimInner = (1 - (1.5 * cell) / R) ** 2;
      const x0 = Math.floor((cx - R) / cell) * cell;
      const y0 = Math.max(0, Math.floor((cy - R) / cell) * cell);

      for (let gy = y0; gy < H; gy += cell) {
        for (let gx = x0; gx < cx + R; gx += cell) {
          const px = (gx + cell / 2 - cx) / R;
          const py = (cy - gy - cell / 2) / R;
          const d2 = px * px + py * py;
          if (d2 > 1) continue;

          let color = RIM;
          if (d2 < rimInner) {
            const pz = Math.sqrt(1 - d2);
            const lat = Math.asin(py);
            const lon = Math.atan2(px, pz) + rot;
            const cl = Math.cos(lat);
            const sy = Math.sin(lat);
            const shade = pz < 0.35 ? 0 : pz < 0.7 ? 1 : 2;
            const cloudLon = lon + rot * 0.6;
            const cloud = fbm(
              cl * Math.cos(cloudLon) * 3.6 + 9,
              sy * 3.6,
              cl * Math.sin(cloudLon) * 3.6,
            );
            if (cloud > 0.66 || Math.abs(sy) > 0.93) {
              color = CLOUD[shade > 0 ? 1 : 0];
            } else {
              const h = fbm(
                cl * Math.cos(lon) * 2.3,
                sy * 2.3,
                cl * Math.sin(lon) * 2.3,
              );
              if (h > 0.53)
                color = LAND[Math.min(3, shade + (h > 0.61 ? 1 : 0))];
              else color = OCEAN[Math.min(3, shade + (h > 0.5 ? 1 : 0))];
            }
          }
          ctx.fillStyle = color;
          ctx.fillRect(gx, gy, cell + 0.5, cell + 0.5);
        }
      }
    };

    const resize = () => {
      const rect = cvs.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = rect.width;
      H = rect.height;
      cvs.width = Math.max(1, Math.round(W * dpr));
      cvs.height = Math.max(1, Math.round(H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(cvs);
    resize();

    let rafId = 0;
    let last = performance.now();
    let acc = 0;
    const loop = (now: number) => {
      acc += Math.min(0.2, (now - last) / 1000);
      last = now;
      if (acc >= 0.12) {
        rot += acc * 0.06;
        acc = 0;
        draw();
      }
      rafId = requestAnimationFrame(loop);
    };
    if (!reduced) rafId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="pixel-earth" aria-hidden="true" />;
}
