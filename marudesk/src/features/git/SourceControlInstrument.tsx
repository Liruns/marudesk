import { SourceControlPanel } from './SourceControlPanel';

/**
 * Source Control as a Mission Control full-area instrument. InstrumentStage hosts
 * this surface and owns the "← Graph" back affordance, so the panel renders in
 * `embedded` mode (no rail chrome: fixed width, collapse, or drag-to-close) and
 * always open — there's nothing to request-close to here.
 */
export function SourceControlInstrument() {
  return <SourceControlPanel embedded open />;
}
