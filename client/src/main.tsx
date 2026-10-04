import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { MetaProvider } from './lib/meta';
import { ConfirmProvider } from './ui/overlays';
import { ToastProvider } from './ui/Toast';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <MetaProvider>
            <ConfirmProvider>
              <App />
            </ConfirmProvider>
          </MetaProvider>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
