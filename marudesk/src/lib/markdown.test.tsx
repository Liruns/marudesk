// @vitest-environment jsdom
import { render, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from './markdown';

const longCode = '```ts\n' + Array.from({ length: 40 }, (_, i) => `const line${i} = ${i};`).join('\n') + '\n```';
const shortCode = '```ts\nconst a = 1;\n```';

describe('Markdown pre decoration', () => {
  it('collapses long code blocks and toggles back open', () => {
    const { container } = render(<Markdown source={longCode} />);
    const pre = container.querySelector('pre');
    expect(pre?.classList.contains('md-collapsed')).toBe(true);
    const toggle = container.querySelector('.md-expand-btn') as HTMLButtonElement;
    expect(toggle.textContent).toContain('41');
    fireEvent.click(toggle);
    expect(pre?.classList.contains('md-collapsed')).toBe(false);
    expect(toggle.textContent).toBe('Collapse');
  });

  it('does not collapse short blocks but still adds wrap/copy actions', () => {
    const { container } = render(<Markdown source={shortCode} />);
    expect(container.querySelector('.md-expand-btn')).toBeNull();
    const wrap = container.querySelector('.md-pre-actions .md-pre-btn') as HTMLButtonElement;
    expect(wrap.textContent).toBe('Wrap');
    fireEvent.click(wrap);
    expect(container.querySelector('pre')?.classList.contains('md-wrap')).toBe(true);
  });
});
