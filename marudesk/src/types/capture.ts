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
};
