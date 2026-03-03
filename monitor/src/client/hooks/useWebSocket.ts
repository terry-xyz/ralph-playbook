import { useEffect, useRef, useState, useCallback } from 'react';

type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_EVENTS_BUFFER = 500;

export function useWebSocket(): {
  status: ConnectionStatus;
  lastEvent: unknown | null;
  events: unknown[];
} {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [events, setEvents] = useState<unknown[]>([]);
  const [lastEvent, setLastEvent] = useState<unknown | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(INITIAL_BACKOFF_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEventIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    setStatus('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let url = `${protocol}//${window.location.host}/ws`;

    if (lastEventIdRef.current) {
      url += `?last_event_id=${encodeURIComponent(lastEventIdRef.current)}`;
    }

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) {
        ws.close();
        return;
      }
      setStatus('connected');
      backoffRef.current = INITIAL_BACKOFF_MS;
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;

      try {
        const data = JSON.parse(event.data as string) as unknown;

        // Track the event id for reconnection
        if (
          data !== null &&
          typeof data === 'object' &&
          'id' in data &&
          typeof (data as Record<string, unknown>).id === 'string'
        ) {
          lastEventIdRef.current = (data as Record<string, unknown>).id as string;
        }

        setLastEvent(data);
        setEvents((prev) => {
          const next = [...prev, data];
          // Cap the buffer to prevent memory issues
          if (next.length > MAX_EVENTS_BUFFER) {
            return next.slice(next.length - MAX_EVENTS_BUFFER);
          }
          return next;
        });
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setStatus('disconnected');
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after onerror, so reconnect is handled there
      ws.close();
    };
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;

    const delay = backoffRef.current;
    backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connect();
    }, delay);
  }, [connect]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;

      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  return { status, lastEvent, events };
}
