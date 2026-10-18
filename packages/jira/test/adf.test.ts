import { describe, expect, it } from 'vitest';
import { adfToMarkdown, markdownToAdf } from '../src/adf.js';

describe('ADF ↔ Markdown', () => {
  it('round-trips paragraphs, headings, lists, marks and links', () => {
    const md = [
      '# Plan',
      '',
      'Run the backfill in **batches** with a _checkpoint_ table, see [runbook](https://example.com/rb).',
      'Second line of the same paragraph with `code`.',
      '',
      '- first',
      '- second',
      '',
      '1. one',
      '2. two',
    ].join('\n');
    const adf = markdownToAdf(md);
    expect(adf.type).toBe('doc');
    expect(adf.content.map((n) => n.type)).toEqual(['heading', 'paragraph', 'bulletList', 'orderedList']);
    expect(adfToMarkdown(adf)).toBe(md);
  });

  it('reads plain strings and empty values', () => {
    expect(adfToMarkdown('plain text')).toBe('plain text');
    expect(adfToMarkdown(null)).toBe('');
    expect(markdownToAdf('').content).toEqual([]);
  });

  it('flattens rich nodes it does not model to their text', () => {
    const adf = {
      type: 'doc', version: 1, content: [
        { type: 'panel', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Heads up' }] }] },
        { type: 'paragraph', content: [{ type: 'mention', attrs: { text: '@Casey' } }, { type: 'text', text: ' please review' }] },
      ],
    };
    expect(adfToMarkdown(adf)).toBe('Heads up\n\n@Casey please review');
  });

  it('keeps code blocks', () => {
    const md = '```\nSELECT 1;\n```';
    expect(adfToMarkdown(markdownToAdf(md))).toBe(md);
  });
});
