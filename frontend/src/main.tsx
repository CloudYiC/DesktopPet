import React from 'react';
import ReactDOM from 'react-dom/client';
import { Root } from './Root';

// StrictMode keeps development-time effect cleanup issues visible.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
