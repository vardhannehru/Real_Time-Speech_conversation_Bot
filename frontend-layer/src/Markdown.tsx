import React from 'react';

const BULLET = /^[-*•]\s+/;
const NUMBER = /^(\d+)[.)]\s+/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^```/;
const RULE = /^(-{3,}|\*{3,}|_{3,})$/;

interface ListItem {
  text: string;
  children: string[];
}

type Block =
  | { type: 'code'; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'rule' }
  | { type: 'ul'; start: number; items: ListItem[] }
  | { type: 'ol'; start: number; items: ListItem[] }
  | { type: 'p'; text: string };

interface MarkdownProps {
  text: string;
}

// **bold**, *italic* and `code` inside a line
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let n = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${n}`;
    n += 1;
    if (token.startsWith('`')) parts.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('**')) parts.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else parts.push(<em key={key}>{token.slice(1, -1)}</em>);
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function collectList(lines: string[], start: number, pattern: RegExp): { items: ListItem[]; next: number } {
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();
    const indented = /^\s{2,}/.test(raw);
    const nextLine = i + 1 < lines.length ? lines[i + 1] : '';

    if (items.length && indented && (BULLET.test(trimmed) || NUMBER.test(trimmed))) {
      items[items.length - 1].children.push(trimmed.replace(BULLET, '').replace(NUMBER, ''));
      i += 1;
    } else if ((items.length === 0 || !indented) && pattern.test(trimmed)) {
      items.push({ text: trimmed.replace(pattern, ''), children: [] });
      i += 1;
    } else if (!trimmed && (pattern.test(nextLine.trim()) || /^\s{2,}\S/.test(nextLine))) {
      i += 1;
    } else if (trimmed && indented && items.length) {
      const last = items[items.length - 1];
      last.text = `${last.text} ${trimmed}`;
      i += 1;
    } else {
      break;
    }
  }
  return { items, next: i };
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    const heading = trimmed.match(HEADING);
    const number = trimmed.match(NUMBER);

    if (!trimmed) {
      i += 1;
    } else if (FENCE.test(trimmed)) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i].trim())) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ type: 'code', text: code.join('\n') });
    } else if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      i += 1;
    } else if (RULE.test(trimmed)) {
      blocks.push({ type: 'rule' });
      i += 1;
    } else if (BULLET.test(trimmed) || number) {
      const ordered = number !== null;
      const { items, next } = collectList(lines, i, ordered ? NUMBER : BULLET);
      blocks.push({
        type: ordered ? 'ol' : 'ul',
        start: number ? Number(number[1]) : 1,
        items,
      });
      i = Math.max(next, i + 1);
    } else {
      const para = [trimmed];
      i += 1;
      while (i < lines.length) {
        const t = lines[i].trim();
        if (!t || FENCE.test(t) || HEADING.test(t) || BULLET.test(t) || NUMBER.test(t)) break;
        para.push(t);
        i += 1;
      }
      blocks.push({ type: 'p', text: para.join(' ') });
    }
  }
  return blocks;
}

export default function Markdown({ text }: MarkdownProps) {
  const blocks = parseBlocks(text || '');

  return (
    <div className="md">
      {blocks.map((block, b) => {
        const key = `b${b}`;

        if (block.type === 'heading') {
          return (
            <p key={key} className={`md-h md-h${Math.min(block.level, 3)}`}>
              {renderInline(block.text, key)}
            </p>
          );
        }

        if (block.type === 'code') {
          return (
            <pre key={key}>
              <code>{block.text}</code>
            </pre>
          );
        }

        if (block.type === 'rule') return <hr key={key} />;

        if (block.type === 'ul' || block.type === 'ol') {
          const List = block.type;
          return (
            <List key={key} style={block.type === 'ol' ? { counterReset: `md-step ${block.start - 1}` } : undefined}>
              {block.items.map((item, n) => (
                <li key={`${key}-${n}`}>
                  {renderInline(item.text, `${key}-${n}`)}
                  {item.children.length > 0 && (
                    <ul className="md-sub">
                      {item.children.map((child, c) => (
                        <li key={`${key}-${n}-${c}`}>{renderInline(child, `${key}-${n}-${c}`)}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </List>
          );
        }

        return <p key={key}>{renderInline(block.text, key)}</p>;
      })}
    </div>
  );
}
