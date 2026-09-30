import React, { useState } from 'react';

// How long each step of one spoken reply took, measured by the AI layer (milliseconds)
export interface ServerLatency {
  stt_ms: number;
  search_ms: number;
  llm_first_word_ms: number;
  first_sentence_ms: number;
  voice_ms: number;
  total_ms: number;
}

// heard_ms is measured on the page: from pressing stop recording to hearing the first word
export type Latency = Partial<ServerLatency> & { heard_ms?: number };
export type FullLatency = Required<Latency>;

export const GOAL_MS = 1500;

const HOPS = [
  { name: 'Speech to text', color: '#a6f46b' },
  { name: 'Knowledge search', color: '#5fd4ff' },
  { name: 'LLM first sentence', color: '#f7c948' },
  { name: 'First voice clip', color: '#c39bff' },
  { name: 'Network and playback', color: '#8e8e8e' },
];

export function isComplete(latency: Latency): latency is FullLatency {
  return (
    latency.stt_ms !== undefined &&
    latency.search_ms !== undefined &&
    latency.llm_first_word_ms !== undefined &&
    latency.first_sentence_ms !== undefined &&
    latency.voice_ms !== undefined &&
    latency.total_ms !== undefined &&
    latency.heard_ms !== undefined
  );
}

// Split the wait you heard into hops that add up exactly to it
function hopTimes(l: FullLatency): number[] {
  const server = l.stt_ms + l.search_ms + l.first_sentence_ms + l.voice_ms;
  return [l.stt_ms, l.search_ms, l.first_sentence_ms, l.voice_ms, Math.max(0, l.heard_ms - server)];
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

function LatencyChart({ history }: { history: FullLatency[] }) {
  const [copied, setCopied] = useState(false);
  if (history.length === 0) return null;

  const rows = history.map((l, i) => ({ label: `${i + 1}`, parts: hopTimes(l) }));
  const average = HOPS.map((_, h) => Math.round(sum(rows.map((r) => r.parts[h])) / rows.length));
  const all = [...rows, { label: 'Avg', parts: average }];
  const scale = Math.max(2000, ...all.map((r) => sum(r.parts)));

  // Tab-separated, so it pastes straight into Excel or Google Sheets
  const copyNumbers = () => {
    const header = ['Reply', ...HOPS.map((h) => `${h.name} (ms)`), 'Total heard (ms)'].join('\t');
    const lines = all.map((r) => [r.label, ...r.parts, sum(r.parts)].join('\t'));
    navigator.clipboard
      .writeText([header, ...lines].join('\n'))
      .then(() => setCopied(true))
      .catch((err) => console.error('Copy failed:', err));
  };

  return (
    <div className="lchart" aria-label="Latency per step for the last spoken replies">
      <div className="lchart-head">
        <span className="label">Latency per step</span>
        <button type="button" className="lchart-copy" onClick={copyNumbers}>
          {copied ? 'Copied' : 'Copy numbers'}
        </button>
      </div>

      <div className="lchart-rows">
        {all.map((row) => {
          const total = sum(row.parts);
          return (
            <div key={row.label} className={`lchart-row${row.label === 'Avg' ? ' is-avg' : ''}`}>
              <span className="lchart-name">{row.label}</span>
              <div className="lchart-track">
                {row.parts.map((ms, h) =>
                  ms > 0 ? (
                    <span
                      key={HOPS[h].name}
                      className="lchart-seg"
                      style={{ width: `${(ms / scale) * 100}%`, background: HOPS[h].color }}
                      title={`${HOPS[h].name}: ${ms} ms`}
                    />
                  ) : null,
                )}
                <span className="lchart-goal" style={{ left: `${(GOAL_MS / scale) * 100}%` }} />
              </div>
              <span className={`lchart-total ${total <= GOAL_MS ? 'is-ok' : 'is-slow'}`}>{total.toLocaleString()} ms</span>
            </div>
          );
        })}
      </div>

      <ul className="lchart-legend">
        {HOPS.map((h) => (
          <li key={h.name}>
            <span style={{ background: h.color }} />
            {h.name}
          </li>
        ))}
        <li>
          <span className="lchart-legend-goal" />
          1.5 s goal
        </li>
      </ul>
    </div>
  );
}

export default LatencyChart;
