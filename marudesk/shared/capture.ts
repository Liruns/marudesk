export type CaptureRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Capture = {
  id: string;
  timestamp: number;
  url: string;
  selector: string;
  tagName: string;
  text: string;
  attributes: Record<string, string>;
  rect: CaptureRect;
  /**
   * The element's serialized `outerHTML` (bounded). Only the custom DevTools
   * picker populates this — the legacy inspect overlay leaves it undefined — so
   * it stays optional and every consumer must tolerate its absence.
   */
  outerHTML?: string;
  /**
   * A curated subset of the element's computed style (layout/box/typography),
   * keyed by CSS property. Same provenance/optionality as {@link outerHTML}.
   */
  computedStyle?: Record<string, string>;
};
