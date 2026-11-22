import { StrictMode } from 'react';
import { isDesktopShell } from './desktop-shell';
import { createRoot } from 'react-dom/client';
// The Airwave window kit (the same stylesheet the hub's admin GUI and the companion use), then the
// demo's own layout.
import '@now-playing/aqua-ui/airwave-window.css';
import './styles.css';
// FLAT-BTN-001: the kit's buttons, checkboxes and segments are Aqua drawings. This app shows flat ones
// instead, so the drawings are never installed.
import './flat-controls.css';
import { App } from './App';
// BTN-UNIFORM-001: the shared button contract goes in after every component's own sheet.
// TYPING-CLEAR-001: the docked player steps aside while a text field has the phone's keyboard (it brings typing.css).
import { watchTyping } from './typing-hides-player';
import './button-contract.css';

const container = document.getElementById('root');
if (!container) throw new Error('jPlay needs a #root element');

// The Windows window is a desktop window: its labels stay visible at any width, not only on phones.
if (isDesktopShell(navigator.userAgent)) document.documentElement.classList.add('is-desktop-shell');

watchTyping();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
