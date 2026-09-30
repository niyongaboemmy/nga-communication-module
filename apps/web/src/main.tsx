import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';
import { initNgaInstall, NgaInstallPrompt } from './pwa/ngaInstall';

// Installable app + "install this too" when opened from the installed NGA app.
initNgaInstall();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <NgaInstallPrompt appName="Tupo" accent="#005EF9" startPath="/app" />
  </React.StrictMode>
);
