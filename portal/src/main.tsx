import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { I18nProvider } from './i18n.tsx';
import { AnnouncerProvider } from './a11y.tsx';
import { SessionProvider } from './session.tsx';
import { App } from './App.tsx';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <I18nProvider>
        <AnnouncerProvider>
          <SessionProvider>
            <App />
          </SessionProvider>
        </AnnouncerProvider>
      </I18nProvider>
    </BrowserRouter>
  </StrictMode>,
);
