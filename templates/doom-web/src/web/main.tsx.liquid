import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Providers } from './app/Providers.tsx';
import { installBrowserErrorReporting } from './lib/browserTelemetry.ts';
import { installStaleChunkRecovery } from './lib/installStaleChunkRecovery.ts';
import { activeSessionId } from './stores/sessionsStore.ts';
import { applyStoredTheme } from './stores/themeStore.ts';
import './styles/app.css';

installStaleChunkRecovery();
// Installed before the first render so a failure during it is still reported.
installBrowserErrorReporting({ sessionId: activeSessionId });

const container = document.getElementById('root');
if (!container) throw new Error('The cockpit needs a #root element.');

// Before the first paint, so the remembered theme never flashes the default.
applyStoredTheme();

createRoot(container).render(
  <StrictMode>
    <Providers />
  </StrictMode>,
);
