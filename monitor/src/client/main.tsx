import React from 'react';
import ReactDOM from 'react-dom/client';
import { Card } from '@tremor/react';
import './index.css';

function App() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center">
      <Card className="max-w-md">
        <h1 className="text-2xl font-bold text-white">Ralph Monitor</h1>
        <p className="mt-2 text-gray-400">Dashboard loading...</p>
      </Card>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
