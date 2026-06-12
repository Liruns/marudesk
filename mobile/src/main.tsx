import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installDiagnostics } from './lib/diagnostics';
import { initNotificationLifecycle } from './lib/notifications';
import { initNative } from './native';
import './index.css';

installDiagnostics();
void initNative();
// Foreground/background tracking for local notifications (web + native).
initNotificationLifecycle();

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
