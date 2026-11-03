import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
// Fonts are self-hosted (P-08 / OPS-08): no request to Google on every visit,
// they work offline in the installed app, and the browser only downloads the
// unicode ranges a page actually uses.
import '@fontsource-variable/inter/opsz.css';
import '@fontsource-variable/inter/opsz-italic.css';
import '@fontsource-variable/jetbrains-mono';
import './index.css';
import { initNgaInstall } from './pwa/ngaInstall';
import { InstallPromptGate } from './pwa/InstallPromptGate';
import { startActivity } from './activity';
import { installErrorReporting } from './lib/errorReport';

// Crashes reach the System page (R-05).
installErrorReporting();

// Installable app + "install this too" when opened from the installed NGA app.
initNgaInstall();

// Platform usage analytics (page views, engagement, presence) -> /api/activity.
// Before the first render, so the router's first page view is recorded.
startActivity();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <InstallPromptGate />
  </React.StrictMode>
);
