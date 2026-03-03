/**
 * WebSocket — Live event streaming (Spec 06 H6).
 * Clients connect to /ws with optional filters (session_id, project).
 * Supports resume via last_event_id query param.
 * Heartbeat to keep connections alive.
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from 'sql.js';
import type { WebSocket } from 'ws';

interface WsClient {
  ws: WebSocket;
  sessionFilter: string | null;
  projectFilter: string | null;
  lastEventId: string | null;
}

const clients: Set<WsClient> = new Set();
let broadcastInterval: ReturnType<typeof setInterval> | null = null;
let lastBroadcastId: string | null = null;

export function registerWebSocket(fastify: FastifyInstance) {
  fastify.get('/ws', { websocket: true }, (socket, request) => {
    const query = request.query as Record<string, string>;
    const client: WsClient = {
      ws: socket,
      sessionFilter: query.session_id ?? null,
      projectFilter: query.project ?? null,
      lastEventId: query.last_event_id ?? null,
    };

    clients.add(client);

    // Resume: replay missed events if last_event_id provided
    if (client.lastEventId) {
      replayMissedEvents(fastify, client);
    }

    // Handle incoming messages (filter updates, etc.)
    socket.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'filter') {
          client.sessionFilter = msg.session_id ?? null;
          client.projectFilter = msg.project ?? null;
        }
      } catch {
        // Ignore malformed messages
      }
    });

    socket.on('close', () => {
      clients.delete(client);
    });

    socket.on('error', () => {
      clients.delete(client);
    });
  });

  // Start heartbeat and event broadcast
  startBroadcast(fastify);
}

function replayMissedEvents(fastify: FastifyInstance, client: WsClient) {
  const db = (fastify as any).db as Database;

  // Get the timestamp of the last event the client saw
  const lastEvent = db.exec(
    'SELECT timestamp FROM events WHERE event_id = ?;',
    [client.lastEventId!]
  );

  if (lastEvent.length === 0 || lastEvent[0].values.length === 0) return;

  const lastTimestamp = lastEvent[0].values[0][0] as string;

  // Build filter conditions
  const conditions = ['e.timestamp > ?'];
  const params: unknown[] = [lastTimestamp];

  if (client.sessionFilter) {
    conditions.push('e.session_id = ?');
    params.push(client.sessionFilter);
  }
  if (client.projectFilter) {
    conditions.push('s.project = ?');
    params.push(client.projectFilter);
  }

  const where = conditions.join(' AND ');
  const result = db.exec(
    `SELECT e.event_id, e.session_id, e.timestamp, e.type, e.tool_name, e.payload, s.project
     FROM events e
     JOIN sessions s ON e.session_id = s.session_id
     WHERE ${where}
     ORDER BY e.timestamp ASC
     LIMIT 1000;`,
    params
  );

  if (result.length > 0) {
    for (const row of result[0].values) {
      const event = {
        eventId: row[0],
        sessionId: row[1],
        timestamp: row[2],
        type: row[3],
        toolName: row[4],
        payload: JSON.parse(row[5] as string || '{}'),
        project: row[6],
      };
      try {
        client.ws.send(JSON.stringify(event));
      } catch {
        clients.delete(client);
        break;
      }
    }
  }
}

function startBroadcast(fastify: FastifyInstance) {
  if (broadcastInterval) return;

  // Check for new events every 500ms and broadcast to clients
  broadcastInterval = setInterval(() => {
    const db = (fastify as any).db as Database;

    if (clients.size === 0) return;

    // Find events newer than last broadcast
    const conditions = lastBroadcastId
      ? ['e.event_id > ?']
      : ['e.timestamp > ?'];
    const params: unknown[] = lastBroadcastId
      ? [lastBroadcastId]
      : [new Date(Date.now() - 1000).toISOString()];

    try {
      const result = db.exec(
        `SELECT e.event_id, e.session_id, e.timestamp, e.type, e.tool_name, e.payload, s.project
         FROM events e
         JOIN sessions s ON e.session_id = s.session_id
         WHERE ${conditions[0]}
         ORDER BY e.timestamp ASC
         LIMIT 100;`,
        params
      );

      if (result.length > 0 && result[0].values.length > 0) {
        for (const row of result[0].values) {
          const event = {
            eventId: row[0],
            sessionId: row[1],
            timestamp: row[2],
            type: row[3],
            toolName: row[4],
            payload: JSON.parse(row[5] as string || '{}'),
            project: row[6],
          };

          lastBroadcastId = event.eventId as string;

          // Send to matching clients
          for (const client of clients) {
            if (client.sessionFilter && client.sessionFilter !== event.sessionId) continue;
            if (client.projectFilter && client.projectFilter !== event.project) continue;

            try {
              client.ws.send(JSON.stringify(event));
            } catch {
              clients.delete(client);
            }
          }
        }
      }
    } catch {
      // Ignore broadcast errors
    }

    // Heartbeat every 30s
  }, 500);

  // Heartbeat
  setInterval(() => {
    for (const client of clients) {
      try {
        client.ws.send(JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() }));
      } catch {
        clients.delete(client);
      }
    }
  }, 30000);
}

/** Get the count of connected clients (for testing). */
export function getClientCount(): number {
  return clients.size;
}
