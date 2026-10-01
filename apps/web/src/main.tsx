import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';
import { initNgaInstall, NgaInstallPrompt } from './pwa/ngaInstall';
import { startActivity } from './activity';

// Installable app + "install this too" when opened from the installed NGA app.
initNgaInstall();

// Platform usage analytics (page views, engagement, presence) -> /api/activity.
// Before the first render, so the router's first page view is recorded.
startActivity();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <NgaInstallPrompt appName="Tupo" accent="#005EF9" startPath="/app" />
  </React.StrictMode>
);
