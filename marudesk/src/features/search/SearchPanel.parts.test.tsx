import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SearchFileResult } from '../../../shared/search';
import { FileGroup } from './SearchPanel.parts';

afterEach(() => cleanup());

const t = (key: 'search.expand' | 'search.collapse' | 'search.createTask'): string => key;

function file(): SearchFileResult {
  return {
    path: 'src/foo/bar.ts',
    matches: [
      { line: 12, col: 3, preview: '  const broken = doThing();', ranges: [] },
    ],
  };
}

describe('FileGroup match-row actions', () => {
  it('opens the file on the primary match click, without creating a task', () => {
    const onOpenAt = vi.fn();
    const onCreateTask = vi.fn();
    render(
      <FileGroup
        file={file()}
        collapsed={false}
        formatSearchMatchLineTitle={(line) => `Line ${line}`}
        onToggle={() => {}}
        onOpenAt={onOpenAt}
        onCreateTask={onCreateTask}
        t={t}
      />,
    );

    // The match row's own (line + preview) button is titled by the line title.
    fireEvent.click(screen.getByTitle('Line 12'));
    expect(onOpenAt).toHaveBeenCalledWith('src/foo/bar.ts', 12, 3);
    expect(onCreateTask).not.toHaveBeenCalled();
  });

  it('creates a task from the secondary action with the match line + preview', () => {
    const onOpenAt = vi.fn();
    const onCreateTask = vi.fn();
    render(
      <FileGroup
        file={file()}
        collapsed={false}
        formatSearchMatchLineTitle={(line) => `Line ${line}`}
        onToggle={() => {}}
        onOpenAt={onOpenAt}
        onCreateTask={onCreateTask}
        t={t}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'search.createTask' }));
    expect(onCreateTask).toHaveBeenCalledWith(
      'src/foo/bar.ts',
      12,
      '  const broken = doThing();',
    );
    // Secondary action must not hijack the primary open-file behavior.
    expect(onOpenAt).not.toHaveBeenCalled();
  });

  it('passes the file path to onToggle so the parent can hold one stable callback', () => {
    const onToggle = vi.fn();
    render(
      <FileGroup
        file={file()}
        collapsed={false}
        formatSearchMatchLineTitle={(line) => `Line ${line}`}
        onToggle={onToggle}
        onOpenAt={() => {}}
        onCreateTask={() => {}}
        t={t}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'search.collapse' }));
    expect(onToggle).toHaveBeenCalledWith('src/foo/bar.ts');
  });

  it('is memoized: identical props do not re-run the component body', () => {
    // React.memo bails out the re-render when props are referentially equal —
    // proving the parent's stable callbacks let untouched groups skip work.
    expect(FileGroup.$$typeof).toBe(Symbol.for('react.memo'));

    const sameFile = file();
    const onToggle = vi.fn();
    const onOpenAt = vi.fn();
    const onCreateTask = vi.fn();
    const fmt = (line: number): string => `Line ${line}`;
    const props = {
      file: sameFile,
      collapsed: false,
      formatSearchMatchLineTitle: fmt,
      onToggle,
      onOpenAt,
      onCreateTask,
      t,
    };
    const { rerender } = render(<FileGroup {...props} />);
    // Re-render with the exact same prop references: memo should keep one row.
    rerender(<FileGroup {...props} />);
    expect(screen.getAllByTitle('Line 12')).toHaveLength(1);
  });
});
