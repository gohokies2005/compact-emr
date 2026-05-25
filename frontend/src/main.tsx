import React from 'react';
import ReactDOM from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import { amplifyConfig } from './auth/AmplifyConfig';
import { App } from './App';
import './styles/globals.css';

Amplify.configure(amplifyConfig);

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
