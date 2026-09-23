import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { startSession } from './host/session.ts';
import './styles.css';
import './panels.css';

startSession();
createRoot(document.getElementById('root')!).render(<App />);
