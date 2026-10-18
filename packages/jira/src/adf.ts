// Atlassian Document Format ↔ basic Markdown (PLAN.md §7). Trellis shows and edits descriptions as
// Markdown; apply writes back paragraphs, headings, bullet/numbered lists, bold, italic, code and
// links. Anything richer (tables, panels, media) is flattened to its text on the way in.

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
}

export interface AdfDoc {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

// --- ADF → Markdown

function inline(nodes: AdfNode[] | undefined): string {
  return (nodes ?? []).map((n) => {
    if (n.type === 'hardBreak') return '\n';
    if (n.type === 'mention') return typeof n.attrs?.['text'] === 'string' ? n.attrs['text'] : '@someone';
    if (n.type === 'emoji') return typeof n.attrs?.['text'] === 'string' ? n.attrs['text'] : '';
    if (n.type === 'inlineCard') return typeof n.attrs?.['url'] === 'string' ? n.attrs['url'] : '';
    if (n.type !== 'text') return inline(n.content);
    let t = n.text ?? '';
    for (const m of n.marks ?? []) {
      if (m.type === 'strong') t = `**${t}**`;
      else if (m.type === 'em') t = `_${t}_`;
      else if (m.type === 'code') t = `\`${t}\``;
      else if (m.type === 'link' && typeof m.attrs?.['href'] === 'string') t = `[${t}](${m.attrs['href']})`;
    }
    return t;
  }).join('');
}

function block(n: AdfNode, indent = ''): string {
  switch (n.type) {
    case 'paragraph': return indent + inline(n.content).replace(/\n/g, `\n${indent}`);
    case 'heading': return `${'#'.repeat(Math.min(Number(n.attrs?.['level'] ?? 1), 6))} ${inline(n.content)}`;
    case 'bulletList':
    case 'orderedList':
      return (n.content ?? []).map((item, i) => {
        const marker = n.type === 'bulletList' ? '- ' : `${i + 1}. `;
        const parts = (item.content ?? []).map((c) => block(c, `${indent}  `).trimStart());
        return `${indent}${marker}${parts.join(`\n${indent}  `)}`;
      }).join('\n');
    case 'codeBlock': return `\`\`\`\n${inline(n.content)}\n\`\`\``;
    case 'blockquote': return (n.content ?? []).map((c) => `> ${block(c)}`).join('\n');
    case 'rule': return '---';
    default: return n.content ? n.content.map((c) => block(c, indent)).join('\n\n') : inline([n]);
  }
}

/** Markdown for an ADF document, or the string itself if Jira returned plain text. */
export function adfToMarkdown(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  const doc = value as AdfNode;
  return (doc.content ?? []).map((n) => block(n)).join('\n\n').trim();
}

// --- Markdown → ADF

function inlineNodes(text: string): AdfNode[] {
  const out: AdfNode[] = [];
  const re = /(\*\*([^*]+)\*\*)|(_([^_]+)_|\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  const pushText = (t: string): void => {
    t.split('\n').forEach((part, i) => {
      if (i > 0) out.push({ type: 'hardBreak' });
      if (part) out.push({ type: 'text', text: part });
    });
  };
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) pushText(text.slice(last, m.index));
    if (m[2] !== undefined) out.push({ type: 'text', text: m[2], marks: [{ type: 'strong' }] });
    else if (m[4] !== undefined || m[5] !== undefined) out.push({ type: 'text', text: m[4] ?? m[5] ?? '', marks: [{ type: 'em' }] });
    else if (m[7] !== undefined) out.push({ type: 'text', text: m[7], marks: [{ type: 'code' }] });
    else if (m[9] !== undefined) out.push({ type: 'text', text: m[9], marks: [{ type: 'link', attrs: { href: m[10] ?? '' } }] });
    last = m.index + m[0].length;
  }
  if (last < text.length) pushText(text.slice(last));
  return out;
}

const para = (text: string): AdfNode => ({ type: 'paragraph', content: inlineNodes(text) });

export function markdownToAdf(md: string): AdfDoc {
  const content: AdfNode[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') { i++; continue; }
    if (line.startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) code.push(lines[i++] ?? '');
      i++;
      content.push({ type: 'codeBlock', content: code.length ? [{ type: 'text', text: code.join('\n') }] : [] });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      content.push({ type: 'heading', attrs: { level: heading[1]?.length ?? 1 }, content: inlineNodes(heading[2] ?? '') });
      i++;
      continue;
    }
    const listKind = /^\s*[-*]\s+/.test(line) ? 'bulletList' : /^\s*\d+[.)]\s+/.test(line) ? 'orderedList' : null;
    if (listKind) {
      const items: AdfNode[] = [];
      const itemRe = listKind === 'bulletList' ? /^\s*[-*]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/;
      while (i < lines.length) {
        const m = itemRe.exec(lines[i] ?? '');
        if (!m) break;
        items.push({ type: 'listItem', content: [para(m[1] ?? '')] });
        i++;
      }
      content.push({ type: listKind, content: items });
      continue;
    }
    const paraLines: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !/^(#{1,6}\s|```|\s*[-*]\s+|\s*\d+[.)]\s+)/.test(lines[i] ?? '')) paraLines.push(lines[i++] ?? '');
    content.push(para(paraLines.join('\n')));
  }
  return { type: 'doc', version: 1, content };
}
