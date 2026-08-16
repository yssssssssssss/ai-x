import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme.css';
import './reporting/report-print.css';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
