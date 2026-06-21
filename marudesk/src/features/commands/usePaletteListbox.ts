import { useId } from 'react';

/**
 * Wires the WAI-ARIA combobox/listbox/option pattern through every command
 * palette so a screen reader announces the moving selection while DOM focus
 * stays on the search input (the way all five palettes already arrow through a
 * visual highlight). It does NOT change any visible text, the input's host role
 * beyond `combobox`, or the result rows' element type — rows stay `<button>` so
 * the e2e `getByRole('button', …)` row selectors keep matching; the option
 * semantics ride on top via `id` + `aria-selected`, surfaced to AT through the
 * input's `aria-activedescendant`.
 *
 * Lives in its own (component-free) module so PaletteOverlay.tsx only exports
 * components — react-refresh requires it.
 *
 * Each palette passes its current `activeIndex` and how many results are
 * showing; it gets back props to spread onto the input, the list container, and
 * (via `optionProps(index)`) each row.
 */

/** ARIA props for the search input, modelled as a `combobox` that controls the list. */
export type ComboboxInputProps = {
  role: 'combobox';
  'aria-expanded': boolean;
  'aria-controls': string;
  'aria-autocomplete': 'list';
  'aria-activedescendant'?: string;
};

/** ARIA props for the results container, modelled as the `listbox`. */
export type ListboxProps = { role: 'listbox'; id: string };

/** ARIA props for a single result row, modelled as a selectable `option`. */
export type OptionProps = { id: string; 'aria-selected': boolean };

export function usePaletteListbox(
  activeIndex: number,
  count: number,
): {
  listId: string;
  inputProps: ComboboxInputProps;
  listboxProps: ListboxProps;
  optionProps: (index: number) => OptionProps;
} {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-opt-${index}`;
  const hasResults = count > 0;
  return {
    listId,
    inputProps: {
      role: 'combobox',
      'aria-expanded': hasResults,
      'aria-controls': listId,
      'aria-autocomplete': 'list',
      ...(hasResults ? { 'aria-activedescendant': optionId(activeIndex) } : {}),
    },
    listboxProps: { role: 'listbox', id: listId },
    optionProps: (index) => ({ id: optionId(index), 'aria-selected': index === activeIndex }),
  };
}
