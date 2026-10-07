/**
 * Interface entry point.
 *
 * English, with the translation indirection in place from the first commit so a second language
 * is a file rather than a refactor. Nothing here blocks on the network: every screen renders from
 * the last snapshot and updates from the event stream, because a device with a dead uplink still
 * has to show its own state instantly.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.tsx';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The event stream drives invalidation, so polling would only duplicate it. `staleTime` is
      // long for the same reason: a refetch on focus costs a phone a round trip over Wi-Fi that
      // may be the only working path to this device.
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
