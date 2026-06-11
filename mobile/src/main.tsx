import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installDiagnostics } from './lib/diagnostics';
import { initNative } from './native';
import './index.css';

installDiagnostics();
void initNative();

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
