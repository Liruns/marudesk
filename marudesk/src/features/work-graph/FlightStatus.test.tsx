import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { I18nProvider } from '../../i18n/I18nProvider';
import { sampleGraph, useWorkGraphStore } from './store';
import { FlightStatus } from './FlightStatus';

afterEach(cleanup);

function renderStatus() {
  return render(
    <I18nProvider>
      <FlightStatus />
    </I18nProvider>,
  );
}

describe('FlightStatus (title-bar flight bar)', () => {
  it('renders nothing when there is no graph (keeps a clean drag region)', () => {
    useWorkGraphStore.setState({ graph: null });
    const { container } = renderStatus();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the goal, done/total progress, and a failed badge when a task failed', () => {
    const base = sampleGraph('flight');
    const first = base.tasks[0];
    const second = base.tasks[1];
    if (!first || !second) return;
    useWorkGraphStore.getState().setGraph({
      ...base,
      goal: 'Ship it',
      tasks: [{ ...first, status: 'done' }, { ...second, status: 'failed' }, ...base.tasks.slice(2)],
    });
    const total = useWorkGraphStore.getState().graph?.tasks.length ?? 0;

    renderStatus();

    expect(screen.getByText('Ship it')).toBeInTheDocument();
    expect(screen.getByText(`1/${total} done`)).toBeInTheDocument();
    expect(screen.getByText('1 failed')).toBeInTheDocument();
  });

  it('omits the failed badge when nothing failed, and falls back to "Untitled flight" for an empty goal', () => {
    const base = sampleGraph('clean');
    const first = base.tasks[0];
    if (!first) return;
    useWorkGraphStore.getState().setGraph({ ...base, goal: '', tasks: [{ ...first, status: 'done' }, ...base.tasks.slice(1)] });

    renderStatus();

    expect(screen.getByText('Untitled flight')).toBeInTheDocument();
    expect(screen.queryByText(/failed/i)).toBeNull();
  });
});
