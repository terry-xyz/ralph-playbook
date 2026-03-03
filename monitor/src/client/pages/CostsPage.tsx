import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Card,
  Metric,
  Text,
  Title,
  Subtitle,
  DonutChart,
  BarChart,
  AreaChart,
  Select,
  SelectItem,
  Button,
  Badge,
  Flex,
  Grid,
} from '@tremor/react';
import {
  api,
  type CostAnalyticsResponse,
  type CostTrendResponse,
  type BudgetAlert,
} from '../api';

// ── Types ───────────────────────────────────────────────────────────────────

type TimeRange = 'today' | 'this_week' | 'this_month' | 'custom';
type Dimension = 'project' | 'model' | 'agent';
type Granularity = 'daily' | 'weekly' | 'monthly';

// ── Helpers ─────────────────────────────────────────────────────────────────

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function timeRangeToParams(range: TimeRange, customFrom?: string, customTo?: string): { from: string; to: string } {
  if (range === 'custom' && customFrom && customTo) {
    return { from: new Date(customFrom).toISOString(), to: new Date(customTo + 'T23:59:59').toISOString() };
  }

  const now = new Date();
  const to = now.toISOString();
  let from: string;

  switch (range) {
    case 'today': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      from = start.toISOString();
      break;
    }
    case 'this_week': {
      const start = new Date(now);
      start.setDate(start.getDate() - start.getDay());
      start.setHours(0, 0, 0, 0);
      from = start.toISOString();
      break;
    }
    case 'this_month':
    default: {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      from = start.toISOString();
      break;
    }
  }

  return { from, to };
}

const RANGE_LABELS: Record<string, string> = {
  today: 'Today',
  this_week: 'This Week',
  this_month: 'This Month',
  custom: 'Custom',
};

const GRANULARITY_LABELS: Record<Granularity, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

// ── Component ───────────────────────────────────────────────────────────────

export default function CostsPage() {
  const [timeRange, setTimeRange] = useState<TimeRange>('this_month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [dimension, setDimension] = useState<Dimension>('project');
  const [granularity, setGranularity] = useState<Granularity>('daily');
  const [costResponse, setCostResponse] = useState<CostAnalyticsResponse | null>(null);
  const [trendResponse, setTrendResponse] = useState<CostTrendResponse | null>(null);
  const [budgetAlerts, setBudgetAlerts] = useState<BudgetAlert[]>([]);
  const [overview, setOverview] = useState<{ totalCost: number; totalSessions: number; totalTokens: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const dateParams = useMemo(
    () => timeRangeToParams(timeRange, customFrom, customTo),
    [timeRange, customFrom, customTo],
  );

  const overviewRange = useMemo(
    () => timeRange === 'custom' ? 'this month' : timeRange.replace('_', ' '),
    [timeRange],
  );

  // Fetch overview data
  useEffect(() => {
    let cancelled = false;
    api
      .getAnalyticsOverview({ range: overviewRange })
      .then((data) => { if (!cancelled) setOverview(data); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load overview'); });
    return () => { cancelled = true; };
  }, [overviewRange]);

  // Fetch cost dimension data
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .getAnalyticsCosts({ dimension, ...dateParams })
      .then((data) => { if (!cancelled) { setCostResponse(data); setLoading(false); } })
      .catch((err) => {
        if (!cancelled) { setError(err instanceof Error ? err.message : 'Failed to load cost data'); setLoading(false); }
      });

    return () => { cancelled = true; };
  }, [dateParams, dimension]);

  // Fetch cost trend data
  useEffect(() => {
    let cancelled = false;
    api
      .getAnalyticsCostTrend({ granularity, ...dateParams })
      .then((data) => { if (!cancelled) setTrendResponse(data); })
      .catch(() => { /* trend is non-critical */ });
    return () => { cancelled = true; };
  }, [dateParams, granularity]);

  // Fetch budget alerts
  useEffect(() => {
    let cancelled = false;
    api
      .getBudgetAlerts()
      .then((data) => { if (!cancelled) setBudgetAlerts(data.alerts); })
      .catch(() => { /* alerts are non-critical */ });
    return () => { cancelled = true; };
  }, [dateParams]);

  // Derived values
  const costData = costResponse?.breakdown ?? [];
  const totalSpend = overview?.totalCost ?? costResponse?.totalCost ?? 0;
  const totalSessions = overview?.totalSessions ?? 0;
  const avgCostPerSession = totalSessions > 0 ? totalSpend / totalSessions : 0;
  const totalTokens = overview?.totalTokens ?? 0;

  // Cache metrics from the cost analytics response (server-computed)
  const cacheHitRate = (costResponse?.cacheHitRate ?? 0) * 100;
  const cacheTokensSaved = costResponse?.tokensSaved ?? 0;
  const costAvoided = cacheTokensSaved * 0.000003;

  // Most expensive model/session from dimension data
  const mostExpensiveModel = useMemo(() => {
    if (!costResponse?.breakdown?.length) return null;
    // If we happen to have model breakdown cached, use it; otherwise derive from current dimension
    return costData.length > 0 ? costData[0].name : null;
  }, [costData, costResponse]);

  // Chart data for dimension breakdown
  const donutData = useMemo(
    () => costData.map((d) => ({ name: d.name, value: d.cost })),
    [costData],
  );

  const barData = useMemo(
    () => costData.map((d) => ({ name: d.name, Cost: d.cost })),
    [costData],
  );

  // Trend chart data — merge current and previous periods into AreaChart format
  const trendChartData = useMemo(() => {
    if (!trendResponse) return [];
    const { current, previous } = trendResponse;

    // Build a unified timeline: use current period dates as the x-axis
    // Previous period is offset to align with current period by index
    const allDates = new Set<string>();
    current.forEach((p) => allDates.add(p.date));

    const currentMap = new Map(current.map((p) => [p.date, p.cost]));
    const prevArr = [...previous];

    const dates = Array.from(allDates).sort();
    return dates.map((date, i) => ({
      date,
      'Current Period': currentMap.get(date) ?? 0,
      'Previous Period': prevArr[i]?.cost ?? 0,
    }));
  }, [trendResponse]);

  const handleTimeRange = useCallback((key: TimeRange) => {
    setTimeRange(key);
  }, []);

  return (
    <div className="space-y-6">
      {/* Header */}
      <Flex justifyContent="between" alignItems="center">
        <div>
          <Title className="text-2xl font-bold text-gray-100">Cost Analytics</Title>
          <Subtitle className="text-gray-400">
            Track spending across sessions, projects, and models
          </Subtitle>
        </div>
      </Flex>

      {/* Budget Alert Banners (S10) */}
      {budgetAlerts.map((alert, idx) => (
        <Card
          key={`${alert.type}-${idx}`}
          className="bg-amber-900/30 ring-amber-600"
        >
          <Flex justifyContent="start" alignItems="center" className="gap-3">
            <Badge color="amber" size="sm">
              {alert.type === 'daily' ? 'Daily Limit Exceeded' : 'Session Limit Exceeded'}
            </Badge>
            <Text className="text-amber-200">
              {alert.type === 'daily'
                ? `Daily spending (${usd(alert.actual)}) has exceeded the configured limit of ${usd(alert.limit)}.`
                : `Session ${alert.sessionId ? alert.sessionId.slice(0, 8) + '...' : ''} cost (${usd(alert.actual)}) has exceeded the per-session limit of ${usd(alert.limit)}.`}
            </Text>
          </Flex>
        </Card>
      ))}

      {/* Time Range Controls */}
      <Card className="bg-gray-800 ring-gray-700">
        <Flex justifyContent="start" className="gap-2 flex-wrap">
          {(['today', 'this_week', 'this_month', 'custom'] as TimeRange[]).map((key) => (
            <Button
              key={key}
              size="xs"
              variant={timeRange === key ? 'primary' : 'secondary'}
              onClick={() => handleTimeRange(key)}
              className={
                timeRange === key
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600'
              }
            >
              {RANGE_LABELS[key]}
            </Button>
          ))}
          {timeRange === 'custom' && (
            <Flex className="gap-2 ml-2">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="bg-gray-700 text-gray-200 border border-gray-600 rounded px-2 py-1 text-sm"
              />
              <Text className="text-gray-400 self-center">to</Text>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="bg-gray-700 text-gray-200 border border-gray-600 rounded px-2 py-1 text-sm"
              />
            </Flex>
          )}
        </Flex>
      </Card>

      {/* Error display */}
      {error && (
        <Card className="bg-red-900/30 ring-red-700">
          <Text className="text-red-300">{error}</Text>
        </Card>
      )}

      {/* Summary KPI Cards */}
      <Grid numItemsMd={2} numItemsLg={4} className="gap-4">
        <Card className="bg-gray-800 ring-gray-700" decoration="top" decorationColor="blue">
          <Text className="text-gray-400">Total Spend</Text>
          <Metric className="text-gray-100">{usd(totalSpend)}</Metric>
          <Text className="text-gray-500 text-xs mt-1">{RANGE_LABELS[timeRange]}</Text>
        </Card>

        <Card className="bg-gray-800 ring-gray-700" decoration="top" decorationColor="cyan">
          <Text className="text-gray-400">Avg Cost / Session</Text>
          <Metric className="text-gray-100">{usd(avgCostPerSession)}</Metric>
          <Text className="text-gray-500 text-xs mt-1">
            {totalSessions} session{totalSessions !== 1 ? 's' : ''}
          </Text>
        </Card>

        <Card className="bg-gray-800 ring-gray-700" decoration="top" decorationColor="emerald">
          <Text className="text-gray-400">Cache Hit Rate</Text>
          <Metric className="text-gray-100">{cacheHitRate.toFixed(1)}%</Metric>
          <Text className="text-gray-500 text-xs mt-1">of total tokens</Text>
        </Card>

        <Card className="bg-gray-800 ring-gray-700" decoration="top" decorationColor="amber">
          <Text className="text-gray-400">Most Expensive</Text>
          <Metric className="text-gray-100">{mostExpensiveModel ?? 'N/A'}</Metric>
          <Text className="text-gray-500 text-xs mt-1">highest spend {dimension}</Text>
        </Card>
      </Grid>

      {/* Cost Trend Over Time (S9) */}
      <Card className="bg-gray-800 ring-gray-700">
        <Flex justifyContent="between" alignItems="center" className="mb-4">
          <Title className="text-gray-100">Cost Trend Over Time</Title>
          <Flex className="gap-2" justifyContent="end">
            {(Object.entries(GRANULARITY_LABELS) as [Granularity, string][]).map(([key, label]) => (
              <Button
                key={key}
                size="xs"
                variant={granularity === key ? 'primary' : 'secondary'}
                onClick={() => setGranularity(key)}
                className={
                  granularity === key
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600'
                }
              >
                {label}
              </Button>
            ))}
          </Flex>
        </Flex>

        {trendChartData.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Text className="text-gray-400">No trend data available for this period.</Text>
          </div>
        ) : (
          <AreaChart
            data={trendChartData}
            index="date"
            categories={['Current Period', 'Previous Period']}
            colors={['blue', 'gray']}
            valueFormatter={usd}
            className="h-72"
            yAxisWidth={65}
            curveType="monotone"
          />
        )}
      </Card>

      {/* Cost by Dimension */}
      <Card className="bg-gray-800 ring-gray-700">
        <Flex justifyContent="between" alignItems="center" className="mb-4">
          <Title className="text-gray-100">Cost by Dimension</Title>
          <Select
            value={dimension}
            onValueChange={(val) => setDimension(val as Dimension)}
            className="max-w-xs"
          >
            <SelectItem value="project">By Project</SelectItem>
            <SelectItem value="model">By Model</SelectItem>
            <SelectItem value="agent">By Agent Name</SelectItem>
          </Select>
        </Flex>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Text className="text-gray-400">Loading cost data...</Text>
          </div>
        ) : costData.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Text className="text-gray-400">No cost data available for this period.</Text>
          </div>
        ) : (
          <Grid numItemsMd={2} className="gap-6">
            {/* Donut Chart — proportional breakdown */}
            <div>
              <Subtitle className="text-gray-400 mb-3">Proportional Breakdown</Subtitle>
              <DonutChart
                data={donutData}
                category="value"
                index="name"
                valueFormatter={usd}
                colors={['blue', 'cyan', 'indigo', 'violet', 'fuchsia', 'rose', 'amber', 'emerald']}
                className="h-60"
              />
            </div>

            {/* Bar Chart — absolute values */}
            <div>
              <Subtitle className="text-gray-400 mb-3">Absolute Values</Subtitle>
              <BarChart
                data={barData}
                index="name"
                categories={['Cost']}
                colors={['blue']}
                valueFormatter={usd}
                className="h-60"
                yAxisWidth={65}
              />
            </div>
          </Grid>
        )}
      </Card>

      {/* Cache Efficiency Section */}
      <Card className="bg-gray-800 ring-gray-700">
        <Title className="text-gray-100 mb-4">Cache Efficiency</Title>
        <Grid numItemsMd={3} className="gap-4">
          <div className="space-y-1">
            <Text className="text-gray-400">Cache Hit Rate</Text>
            <div className="flex items-center gap-2">
              <Metric className="text-gray-100">{cacheHitRate.toFixed(1)}%</Metric>
              <Badge
                color={cacheHitRate >= 50 ? 'emerald' : cacheHitRate >= 25 ? 'amber' : 'red'}
                size="sm"
              >
                {cacheHitRate >= 50 ? 'Good' : cacheHitRate >= 25 ? 'Fair' : 'Low'}
              </Badge>
            </div>
          </div>

          <div className="space-y-1">
            <Text className="text-gray-400">Tokens Saved</Text>
            <Metric className="text-gray-100">{compactNumber(cacheTokensSaved)}</Metric>
            <Text className="text-gray-500 text-xs">tokens served from cache</Text>
          </div>

          <div className="space-y-1">
            <Text className="text-gray-400">Estimated Cost Avoided</Text>
            <Metric className="text-emerald-400">{usd(costAvoided)}</Metric>
            <Text className="text-gray-500 text-xs">approximate savings from caching</Text>
          </div>
        </Grid>
      </Card>
    </div>
  );
}
