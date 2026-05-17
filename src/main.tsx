import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
// Keshucord design tokens + component classes. Imported AFTER index.css so its
// :root tokens, body font/background, and component classes take precedence.
// Existing screens keep their Tailwind styles; new screens (when migrated) use
// the design's class system (.card, .btn, .input, etc.). The class names don't
// collide with the legacy .glass-card / .btn-primary / .field-input names.
import './styles/keshucord.css';
import { SettingsProvider } from './utils/settingsContext';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SettingsProvider>
      <App />
    </SettingsProvider>
  </React.StrictMode>,
);
