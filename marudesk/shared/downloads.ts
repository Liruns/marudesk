/**
 * Download-manager contract, shared by the main-process tracker
 * (electron/browser/downloads.ts) and the renderer's download shelf. A
 * {@link DownloadEntry} is a plain serializable snapshot of one Electron
 * DownloadItem; the live item stays in main.
 */

export type DownloadState =
  | 'progressing'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'interrupted';

export type DownloadEntry = {
  /** Main-assigned id (DownloadItem has no stable identity of its own). */
  id: string;
  filename: string;
  url: string;
  savePath: string;
  state: DownloadState;
  receivedBytes: number;
  /** 0 when the server didn't send a length (state shows as indeterminate). */
  totalBytes: number;
  paused: boolean;
  /** Epoch ms the download started — the shelf sorts newest-first by this. */
  startTime: number;
};

/** Actions the renderer can request against a tracked download by id. */
export type DownloadAction =
  | 'cancel'
  | 'pause'
  | 'resume'
  | 'open'
  | 'show'
  | 'remove';
