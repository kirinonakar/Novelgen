import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { useNovelgenRuntime } from './hooks/useNovelgenRuntime.js';
import './styles.css';

function RuntimeBridge() {
    const { actions, viewState } = useNovelgenRuntime();
    return <App actions={actions} viewState={viewState} />;
}

const rootElement = document.getElementById('root');

if (!rootElement) {
    throw new Error('React root element was not found.');
}

createRoot(rootElement).render(<RuntimeBridge />);
