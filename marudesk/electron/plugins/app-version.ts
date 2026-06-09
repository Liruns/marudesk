import { app } from 'electron';

export function appVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return '0.0.0';
  }
}
