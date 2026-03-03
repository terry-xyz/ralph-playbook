/**
 * REST API — Analytics & Top Stats endpoints (Spec 06 H3).
 * GET /api/analytics/overview — top stats
 * GET /api/analytics/costs — cost by dimension
 * GET /api/analytics/errors — error data
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from 'sql.js';

export function registerAnalyticsRoutes(fastify: FastifyInstance) {
  // GET /api/analytics/overview — Top stats
  fastify.get('/api/analytics/overview', async (request) => {
    const db = (fastify as any).db as Database;
    const query = request.query as Record<string, string>;

    // Time window: today, this week, this month
    const range = query.range ?? 'today';
    const now = new Date();
    let fromDate: string;

    if (range === 'this week') {
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay());
      weekStart.setHours(0, 0, 0, 0);
      fromDate = weekStart.toISOString();
    } else if (range === 'this month') {
      fromDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    } else {
      // today
      fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    }

    // Active sessions
    const activeResult = db.exec("SELECT COUNT(*) FROM sessions WHERE status = 'running';");
    const activeSessions = activeResult.length > 0 ? activeResult[0].values[0][0] as number : 0;

    // Total sessions in time window
    const totalSessionsResult = db.exec(
      'SELECT COUNT(*) FROM sessions WHERE start_time >= ?;',
      [fromDate]
    );
    const totalSessions = totalSessionsResult.length > 0 ? totalSessionsResult[0].values[0][0] as number : 0;

    // Total cost in time window
    const costResult = db.exec(
      'SELECT COALESCE(SUM(total_cost), 0) FROM sessions WHERE start_time >= ?;',
      [fromDate]
    );
    const totalCost = costResult.length > 0 ? costResult[0].values[0][0] as number : 0;

    // Total tokens in time window (sum from sessions table token_counts JSON)
    const tokenResult = db.exec(
      'SELECT token_counts FROM sessions WHERE start_time >= ?;',
      [fromDate]
    );
    let totalTokens = 0;
    if (tokenResult.length > 0) {
      for (const row of tokenResult[0].values) {
        try {
          const tc = JSON.parse(row[0] as string || '{}');
          totalTokens += (tc.input ?? 0) + (tc.output ?? 0) + (tc.cacheCreation ?? 0) + (tc.cacheRead ?? 0);
        } catch { /* skip unparseable */ }
      }
    }

    // Error count and rate
    const errorCountResult = db.exec(
      "SELECT COUNT(*) FROM events WHERE type = 'PostToolUseFailure' AND timestamp >= ?;",
      [fromDate]
    );
    const totalErrors = errorCountResult.length > 0 ? errorCountResult[0].values[0][0] as number : 0;

    const totalToolCallsResult = db.exec(
      "SELECT COUNT(*) FROM events WHERE type IN ('PostToolUse', 'PostToolUseFailure') AND timestamp >= ?;",
      [fromDate]
    );
    const totalToolCalls = totalToolCallsResult.length > 0 ? totalToolCallsResult[0].values[0][0] as number : 0;
    const errorRate = totalToolCalls > 0 ? totalErrors / totalToolCalls : 0;

    // Rate limit incidents in last hour
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const rateLimitResult = db.exec(
      "SELECT COUNT(*) FROM events WHERE payload LIKE '%rate_limit%' AND timestamp >= ?;",
      [oneHourAgo]
    );
    const rateLimitIncidents = rateLimitResult.length > 0 ? rateLimitResult[0].values[0][0] as number : 0;

    // Tool calls per minute (last 10 minutes as time series)
    const toolCallsPerMin: number[] = [];
    for (let i = 9; i >= 0; i--) {
      const start = new Date(Date.now() - (i + 1) * 60000).toISOString();
      const end = new Date(Date.now() - i * 60000).toISOString();
      const result = db.exec(
        "SELECT COUNT(*) FROM events WHERE type IN ('PreToolUse', 'PostToolUse') AND timestamp >= ? AND timestamp < ?;",
        [start, end]
      );
      toolCallsPerMin.push(result.length > 0 ? result[0].values[0][0] as number : 0);
    }

    return {
      activeSessions,
      totalSessions,
      totalCost,
      totalTokens,
      totalErrors,
      errorRate,
      rateLimitIncidents,
      toolCallsPerMin,
    };
  });

  // GET /api/analytics/costs — Cost by dimension
  fastify.get('/api/analytics/costs', async (request) => {
    const db = (fastify as any).db as Database;
    const query = request.query as Record<string, string>;

    const dimension = query.dimension ?? 'project'; // project | model | agent
    const fromDate = query.from ?? new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).toISOString();
    const toDate = query.to ?? new Date().toISOString();

    const groupByCol = dimension === 'model' ? 'model' : dimension === 'agent' ? 'agent_name' : 'project';

    // Cost by dimension
    const result = db.exec(
      `SELECT ${groupByCol}, COALESCE(SUM(total_cost), 0) as cost
       FROM sessions WHERE start_time >= ? AND start_time <= ?
       GROUP BY ${groupByCol}
       ORDER BY cost DESC;`,
      [fromDate, toDate]
    );

    const breakdown = result.length > 0 ? result[0].values.map((row: unknown[]) => ({
      name: row[0] ?? 'Unknown',
      cost: row[1] as number,
    })) : [];

    const totalCost = breakdown.reduce((sum: number, b: { name: unknown; cost: number }) => sum + b.cost, 0);

    // Cache efficiency from metrics
    const cacheResult = db.exec(
      `SELECT token_breakdown FROM metrics m
       JOIN sessions s ON m.session_id = s.session_id
       WHERE s.start_time >= ? AND s.start_time <= ?;`,
      [fromDate, toDate]
    );

    let cacheRead = 0;
    let totalInput = 0;
    if (cacheResult.length > 0) {
      for (const row of cacheResult[0].values) {
        const tokens = JSON.parse(row[0] as string || '{}');
        cacheRead += tokens.cacheRead ?? 0;
        totalInput += (tokens.input ?? 0) + (tokens.cacheRead ?? 0);
      }
    }
    const cacheHitRate = totalInput > 0 ? cacheRead / totalInput : 0;

    return {
      breakdown,
      totalCost,
      cacheHitRate,
      tokensSaved: cacheRead,
    };
  });

  // GET /api/analytics/costs/trend — Cost trend over time with period comparison (Spec 12 ACs 7-12)
  fastify.get('/api/analytics/costs/trend', async (request) => {
    const db = (fastify as any).db as Database;
    const query = request.query as Record<string, string>;

    const granularity = query.granularity ?? 'daily'; // daily | weekly | monthly
    const fromDate = query.from ?? new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).toISOString();
    const toDate = query.to ?? new Date().toISOString();

    // Calculate previous period (same duration, immediately before current)
    const from = new Date(fromDate);
    const to = new Date(toDate);
    const durationMs = to.getTime() - from.getTime();
    const prevFrom = new Date(from.getTime() - durationMs);
    const prevTo = new Date(from.getTime());

    // Bucket a timestamp into a date key based on granularity
    function dateKey(isoString: string): string {
      const d = new Date(isoString);
      if (granularity === 'monthly') {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      } else if (granularity === 'weekly') {
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        const monday = new Date(d.getFullYear(), d.getMonth(), diff);
        return monday.toISOString().slice(0, 10);
      } else {
        return d.toISOString().slice(0, 10);
      }
    }

    // Query current period
    const currentResult = db.exec(
      `SELECT start_time, total_cost FROM sessions
       WHERE start_time >= ? AND start_time <= ?
       ORDER BY start_time ASC;`,
      [fromDate, toDate]
    );

    const currentMap = new Map<string, number>();
    if (currentResult.length > 0) {
      for (const row of currentResult[0].values) {
        const key = dateKey(row[0] as string);
        currentMap.set(key, (currentMap.get(key) ?? 0) + (row[1] as number));
      }
    }

    // Query previous period
    const prevResult = db.exec(
      `SELECT start_time, total_cost FROM sessions
       WHERE start_time >= ? AND start_time < ?
       ORDER BY start_time ASC;`,
      [prevFrom.toISOString(), prevTo.toISOString()]
    );

    const previousMap = new Map<string, number>();
    if (prevResult.length > 0) {
      for (const row of prevResult[0].values) {
        const key = dateKey(row[0] as string);
        previousMap.set(key, (previousMap.get(key) ?? 0) + (row[1] as number));
      }
    }

    const current = Array.from(currentMap.entries())
      .map(([date, cost]) => ({ date, cost }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const previous = Array.from(previousMap.entries())
      .map(([date, cost]) => ({ date, cost }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return { current, previous, granularity };
  });

  // GET /api/analytics/budget-alerts — Budget threshold violations (Spec 12 ACs 25-30)
  fastify.get('/api/analytics/budget-alerts', async () => {
    const db = (fastify as any).db as Database;
    const config = (fastify as any).config;

    const alerts: Array<{ type: string; limit: number; actual: number; sessionId?: string }> = [];

    const perSessionLimit = config?.alerts?.perSessionCostLimit;
    const perDayLimit = config?.alerts?.perDayCostLimit;

    // Check per-day limit
    if (perDayLimit != null && perDayLimit > 0) {
      const today = new Date();
      const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
      const result = db.exec(
        'SELECT COALESCE(SUM(total_cost), 0) FROM sessions WHERE start_time >= ?;',
        [todayStart]
      );
      const dailyCost = result.length > 0 ? result[0].values[0][0] as number : 0;
      if (dailyCost > perDayLimit) {
        alerts.push({ type: 'daily', limit: perDayLimit, actual: dailyCost });
      }
    }

    // Check per-session limit
    if (perSessionLimit != null && perSessionLimit > 0) {
      const result = db.exec(
        'SELECT session_id, total_cost FROM sessions WHERE total_cost > ? ORDER BY total_cost DESC;',
        [perSessionLimit]
      );
      if (result.length > 0) {
        for (const row of result[0].values) {
          alerts.push({
            type: 'session',
            limit: perSessionLimit,
            actual: row[1] as number,
            sessionId: row[0] as string,
          });
        }
      }
    }

    return { alerts };
  });

  // GET /api/analytics/errors — Error data from all 3 error sources
  fastify.get('/api/analytics/errors', async (request) => {
    const db = (fastify as any).db as Database;
    const query = request.query as Record<string, string>;

    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? '50', 10) || 50));
    const offset = (page - 1) * limit;

    // Query all error sources: PostToolUseFailure + Stop events with error payload
    const conditions: string[] = [
      "(e.type = 'PostToolUseFailure' OR e.type = 'ScrapedError' OR (e.type = 'Stop' AND (e.payload LIKE '%\"error\"%' OR e.payload LIKE '%\"is_error\"%')))"
    ];
    const params: unknown[] = [];

    if (query.session) {
      conditions.push('e.session_id = ?');
      params.push(query.session);
    }
    if (query.project) {
      conditions.push('s.project = ?');
      params.push(query.project);
    }
    if (query.from) {
      conditions.push('e.timestamp >= ?');
      params.push(query.from);
    }
    if (query.to) {
      conditions.push('e.timestamp <= ?');
      params.push(query.to);
    }

    const where = conditions.join(' AND ');

    const countResult = db.exec(
      `SELECT COUNT(*) FROM events e JOIN sessions s ON e.session_id = s.session_id WHERE ${where};`,
      params
    );
    const total = countResult.length > 0 ? countResult[0].values[0][0] as number : 0;

    const allParams = [...params, limit, offset];
    const result = db.exec(
      `SELECT e.event_id, e.session_id, e.timestamp, e.type, e.tool_name, e.payload, s.project
       FROM events e
       JOIN sessions s ON e.session_id = s.session_id
       WHERE ${where}
       ORDER BY e.timestamp DESC
       LIMIT ? OFFSET ?;`,
      allParams
    );

    const errors = result.length > 0 ? result[0].values.map((row: unknown[]) => {
      const eventType = row[3] as string;
      const payloadStr = row[5] as string || '{}';
      const payload = JSON.parse(payloadStr);
      const toolName = row[4] as string | null;

      // Categorize error: ScrapedError events have pre-classified category in payload
      let category = 'tool_failure';
      if (eventType === 'ScrapedError' && payload.category) {
        category = payload.category;
      } else if (eventType === 'PostToolUseFailure') {
        category = 'tool_failure';
      } else {
        const lower = payloadStr.toLowerCase();
        if (lower.includes('rate limit') || lower.includes('429') || lower.includes('too many requests')) {
          category = 'rate_limit';
        } else if (lower.includes('auth') || lower.includes('401') || lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('403')) {
          category = 'auth_error';
        } else if (lower.includes('billing') || lower.includes('payment') || lower.includes('quota') || lower.includes('credit')) {
          category = 'billing_error';
        } else if (lower.includes('500') || lower.includes('502') || lower.includes('503') || lower.includes('internal server error') || lower.includes('service unavailable')) {
          category = 'server_error';
        } else {
          category = 'server_error'; // Default for Stop errors
        }
      }

      // Extract a human-readable message from the payload
      const message = payload.error || payload.message || payload.output || `${eventType} event`;

      return {
        id: row[0],
        sessionId: row[1],
        timestamp: row[2],
        category,
        message: typeof message === 'string' ? message : JSON.stringify(message),
        tool: toolName,
        project: row[6],
      };
    }) : [];

    // Apply category filter client-side if specified (after query)
    const filteredErrors = query.category
      ? errors.filter((e: { category: string }) => e.category === query.category)
      : errors;

    return {
      data: filteredErrors,
      total: query.category ? filteredErrors.length : total,
      page,
      limit,
    };
  });

  // GET /api/analytics/errors/trend — Error rate time-series (Spec 13 ACs 18-21)
  fastify.get('/api/analytics/errors/trend', async (request) => {
    const db = (fastify as any).db as Database;
    const query = request.query as Record<string, string>;

    const now = new Date();
    const fromDate = query.from ?? new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const toDate = query.to ?? now.toISOString();

    // Determine bucket size based on time range
    const rangeMs = new Date(toDate).getTime() - new Date(fromDate).getTime();
    const bucketMs = rangeMs > 7 * 86400000 ? 86400000 : rangeMs > 86400000 ? 3600000 : 600000; // day / hour / 10min

    // Fetch error events in range
    const errorCondition = "(e.type = 'PostToolUseFailure' OR e.type = 'ScrapedError' OR (e.type = 'Stop' AND (e.payload LIKE '%\"error\"%' OR e.payload LIKE '%\"is_error\"%')))";
    const conditions = [errorCondition, 'e.timestamp >= ?', 'e.timestamp <= ?'];
    const params: unknown[] = [fromDate, toDate];

    // Apply optional filters matching the error log table filters
    if (query.category || query.session || query.project) {
      // We need to join sessions for project filtering
    }
    if (query.session) {
      conditions.push('e.session_id = ?');
      params.push(query.session);
    }

    const result = db.exec(
      `SELECT e.timestamp, e.type, e.payload
       FROM events e
       WHERE ${conditions.join(' AND ')}
       ORDER BY e.timestamp ASC;`,
      params
    );

    // Bucket the errors
    const bucketMap = new Map<number, { count: number; categories: Record<string, number> }>();
    if (result.length > 0) {
      for (const row of result[0].values) {
        const ts = new Date(row[0] as string).getTime();
        const bucketKey = Math.floor(ts / bucketMs) * bucketMs;
        const existing = bucketMap.get(bucketKey) ?? { count: 0, categories: {} };

        // Categorize: ScrapedError events have pre-classified category in payload
        const eventType = row[1] as string;
        const payloadStr = (row[2] as string || '');
        let category = 'tool_failure';
        if (eventType === 'ScrapedError') {
          try { category = JSON.parse(payloadStr).category ?? 'tool_failure'; } catch { /* use default */ }
        } else if (eventType === 'PostToolUseFailure') {
          category = 'tool_failure';
        } else {
          const lower = payloadStr.toLowerCase();
          if (lower.includes('rate limit') || lower.includes('429') || lower.includes('too many requests')) {
            category = 'rate_limit';
          } else if (lower.includes('auth') || lower.includes('401') || lower.includes('unauthorized')) {
            category = 'auth_error';
          } else if (lower.includes('billing') || lower.includes('payment') || lower.includes('quota')) {
            category = 'billing_error';
          } else {
            category = 'server_error';
          }
        }

        existing.count++;
        existing.categories[category] = (existing.categories[category] ?? 0) + 1;
        bucketMap.set(bucketKey, existing);
      }
    }

    const buckets = Array.from(bucketMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([ts, data]) => ({
        date: new Date(ts).toISOString(),
        count: data.count,
        categories: data.categories,
      }));

    // Overlays: session starts/stops and rate limit bursts in the time range
    const overlayResult = db.exec(
      `SELECT timestamp, type FROM events
       WHERE type IN ('SessionStart', 'SessionEnd', 'Stop') AND timestamp >= ? AND timestamp <= ?
       ORDER BY timestamp ASC;`,
      [fromDate, toDate]
    );

    const overlays: Array<{ date: string; type: string; label: string }> = [];
    if (overlayResult.length > 0) {
      for (const row of overlayResult[0].values) {
        const type = row[1] as string;
        overlays.push({
          date: row[0] as string,
          type: type === 'SessionStart' ? 'session_start' : type === 'SessionEnd' ? 'session_stop' : 'session_stop',
          label: type === 'SessionStart' ? 'Session started' : 'Session ended',
        });
      }
    }

    return { buckets, overlays, bucketMs };
  });

  // GET /api/analytics/errors/rate-limits — Rate limit tracking (Spec 13 ACs 22-26)
  fastify.get('/api/analytics/errors/rate-limits', async (request) => {
    const db = (fastify as any).db as Database;
    const query = request.query as Record<string, string>;

    const now = new Date();
    const fromDate = query.from ?? new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const toDate = query.to ?? now.toISOString();

    // Find all rate-limit-related events (including ScrapedError with rate_limit category)
    const rateLimitCondition = `(
      (e.type = 'PostToolUseFailure' AND (e.payload LIKE '%rate_limit%' OR e.payload LIKE '%429%' OR e.payload LIKE '%too many requests%'))
      OR (e.type = 'ScrapedError' AND e.payload LIKE '%"category":"rate_limit"%')
      OR (e.type = 'Stop' AND (e.payload LIKE '%rate_limit%' OR e.payload LIKE '%429%'))
      OR (e.payload LIKE '%rate limit%')
    )`;

    const result = db.exec(
      `SELECT e.timestamp, e.session_id, e.payload, s.model
       FROM events e
       JOIN sessions s ON e.session_id = s.session_id
       WHERE ${rateLimitCondition} AND e.timestamp >= ? AND e.timestamp <= ?
       ORDER BY e.timestamp ASC;`,
      [fromDate, toDate]
    );

    // Frequency: bucket by hour
    const hourBuckets = new Map<number, number>();
    const modelCounts = new Map<string, number>();
    const rawEvents: Array<{ ts: number; model: string }> = [];

    if (result.length > 0) {
      for (const row of result[0].values) {
        const ts = new Date(row[0] as string).getTime();
        const hourKey = Math.floor(ts / 3600000) * 3600000;
        hourBuckets.set(hourKey, (hourBuckets.get(hourKey) ?? 0) + 1);

        const model = (row[3] as string) ?? 'unknown';
        modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
        rawEvents.push({ ts, model });
      }
    }

    const frequency = Array.from(hourBuckets.entries())
      .sort(([a], [b]) => a - b)
      .map(([ts, count]) => ({ date: new Date(ts).toISOString(), count }));

    const byModel = Array.from(modelCounts.entries())
      .sort(([, a], [, b]) => b - a)
      .map(([model, count]) => ({ model, count }));

    // Cooldown patterns: detect gaps between consecutive rate limit events
    const cooldowns: Array<{ start: string; end: string; durationMs: number; model: string }> = [];
    if (rawEvents.length >= 2) {
      for (let i = 1; i < rawEvents.length; i++) {
        const gap = rawEvents[i].ts - rawEvents[i - 1].ts;
        // If gap is between 5s and 5min, it's likely a cooldown period
        if (gap >= 5000 && gap <= 300000) {
          cooldowns.push({
            start: new Date(rawEvents[i - 1].ts).toISOString(),
            end: new Date(rawEvents[i].ts).toISOString(),
            durationMs: gap,
            model: rawEvents[i - 1].model,
          });
        }
      }
    }

    return { frequency, byModel, cooldowns };
  });
}
