import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// The Airwave window kit (the same stylesheet the hub's admin GUI and the companion use), then the
// demo's own layout. The kit's buttons, pop-ups and checkboxes are drawings installed as custom
// properties, so they go in before the first render.
import '@now-playing/aqua-ui/airwave-window.css';
import './styles.css';
import { installAquaArt } from '@now-playing/aqua-ui/airwave-art';
import { App } from './App';

const container = document.getElementById('root');
if (!container) throw new Error('Airwave Discovery needs a #root element');

installAquaArt({ btn: [22, 30], pop: [22], cb: [14] });
// The Windows window is a desktop window: its labels stay visible at any width, not only on phones.
if (navigator.userAgent.includes('AirwaveDiscovery/')) document.documentElement.classList.add('is-desktop-shell');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
