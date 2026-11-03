import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
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
