import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Providers } from './app/Providers.tsx';
import { installStaleChunkRecovery } from './lib/installStaleChunkRecovery.ts';
import { applyStoredTheme } from './stores/themeStore.ts';
import './styles/app.css';

installStaleChunkRecovery();

const container = document.getElementById('root');
if (!container) throw new Error('The cockpit needs a #root element.');

// Before the first paint, so the remembered theme never flashes the default.
applyStoredTheme();

createRoot(container).render(
  <StrictMode>
    <Providers />
  </StrictMode>,
);
