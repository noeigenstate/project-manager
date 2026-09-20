import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './glass.css';
import './themes.css';
import { restoreTheme } from './themes';

restoreTheme();
createRoot(document.getElementById('root')!).render(<App />);
