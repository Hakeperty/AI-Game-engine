// biome-ignore-all lint/suspicious/noArrayIndexKey: rendered Markdown is static; block order is its identity
import type { ReactNode } from 'react';

/** Very small Markdown renderer (fences, inline code, bold, italics, headings, lists). No HTML injection. */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n');
      const code = nl >= 0 ? part.slice(nl + 1) : part;
      blocks.push(
        <pre key={`c${i}`} className="md-code">
          {code.replace(/\n$/, '')}
        </pre>,
      );
      return;
    }
    const lines = part.split('\n');
    let list: string[] = [];
    let ordered = false;
    let para: string[] = [];
    const flushPara = () => {
      if (para.length) blocks.push(<p key={`p${i}-${blocks.length}`}>{inline(para.join(' '))}</p>);
      para = [];
    };
    const flushList = () => {
      if (!list.length) return;
      const items = list.map((l, j) => <li key={j}>{inline(l)}</li>);
      blocks.push(
        ordered ? (
          <ol key={`l${i}-${blocks.length}`}>{items}</ol>
        ) : (
          <ul key={`l${i}-${blocks.length}`}>{items}</ul>
        ),
      );
      list = [];
    };
    for (const line of lines) {
      const t = line.trim();
      const bullet = t.match(/^[-*]\s+(.*)$/);
      const num = t.match(/^\d+[.)]\s+(.*)$/);
      const heading = t.match(/^(#{1,4})\s+(.*)$/);
      if (bullet || num) {
        flushPara();
        if (list.length && ordered !== !!num) flushList();
        ordered = !!num;
        list.push((bullet ?? num)![1]!);
      } else if (heading) {
        flushPara();
        flushList();
        blocks.push(
          <div key={`h${i}-${blocks.length}`} className={`md-h md-h${heading[1]!.length}`}>
            {inline(heading[2]!)}
          </div>,
        );
      } else if (!t) {
        flushPara();
        flushList();
      } else {
        flushList();
        para.push(t);
      }
    }
    flushPara();
    flushList();
  });
  return <div className="md">{blocks}</div>;
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) out.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('**')) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else out.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
