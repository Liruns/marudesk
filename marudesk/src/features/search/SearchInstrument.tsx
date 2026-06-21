import { SearchPanel } from './SearchPanel';

/**
 * Mission Control's full-area Search instrument. Hosts {@link SearchPanel} in its
 * embedded layout (no rail chrome, no close handle) — InstrumentStage provides the
 * surrounding frame and the "← Graph" affordance. Opening a match summons the
 * file's editor instrument in place.
 */
export function SearchInstrument() {
  return <SearchPanel embedded open />;
}
