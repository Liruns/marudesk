import { describe, it, expect, beforeEach } from 'vitest';
import { useDevtoolsStore } from './store';

/**
 * Regression net for the devtools store's dock-layout actions (the slice that
 * doesn't touch CDP): side/size/panel selection, drawer toggles, and tool
 * arrangement. Lets the layout actions be moved into a slice with confidence.
 */

const initial = useDevtoolsStore.getState();

beforeEach(() => {
  useDevtoolsStore.setState({
    side: 'right',
    size: 0,
    panel: 'elements',
    drawerOpen: false,
    drawerPanel: 'console',
    tools: initial.tools.map((t) => ({ ...t })),
  });
});

describe('devtools dock layout', () => {
  it('setSide switches the dock and resets to that side default size', () => {
    useDevtoolsStore.getState().setSide('bottom');
    expect(useDevtoolsStore.getState().side).toBe('bottom');
    expect(useDevtoolsStore.getState().size).toBeGreaterThan(0);
  });

  it('setSize clamps below the minimum', () => {
    useDevtoolsStore.getState().setSize(10);
    expect(useDevtoolsStore.getState().size).toBeGreaterThanOrEqual(220);
  });

  it('setPanel selects a main panel', () => {
    useDevtoolsStore.getState().setPanel('network');
    expect(useDevtoolsStore.getState().panel).toBe('network');
  });

  it('toggleDrawer flips the drawer open state', () => {
    expect(useDevtoolsStore.getState().drawerOpen).toBe(false);
    useDevtoolsStore.getState().toggleDrawer();
    expect(useDevtoolsStore.getState().drawerOpen).toBe(true);
  });

  it('moveTool relocates a tool to the drawer', () => {
    useDevtoolsStore.getState().moveTool('network', 'drawer');
    const moved = useDevtoolsStore.getState().tools.find((t) => t.id === 'network');
    expect(moved?.location).toBe('drawer');
  });
});
