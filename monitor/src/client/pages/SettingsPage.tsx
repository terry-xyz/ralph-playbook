import { useState, useEffect, useCallback } from 'react';
import {
  Card,
  Text,
  Title,
  Subtitle,
  Button,
  Flex,
  NumberInput,
  TextInput,
  Select,
  SelectItem,
  Switch,
  Badge,
  Callout,
} from '@tremor/react';
import { api } from '../api';
import type { Config } from '@shared/types';
import { DEFAULT_CONFIG } from '@shared/constants';

// ── Types ───────────────────────────────────────────────────────────────────

interface ValidationErrors {
  [key: string]: string;
}

interface Toast {
  message: string;
  type: 'success' | 'error';
}

// ── Section collapse component ──────────────────────────────────────────────

function SettingsSection({
  title,
  description,
  defaultOpen = true,
  children,
}: {
  title: string;
  description: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Card className="bg-gray-800 ring-gray-700">
      <button
        className="w-full text-left"
        onClick={() => setOpen((prev) => !prev)}
      >
        <Flex justifyContent="between" alignItems="center">
          <div>
            <Title className="text-gray-100">{title}</Title>
            <Text className="text-gray-400 text-sm">{description}</Text>
          </div>
          <span className="text-gray-400 text-lg select-none">
            {open ? '\u25B2' : '\u25BC'}
          </span>
        </Flex>
      </button>
      {open && <div className="mt-4 space-y-4 border-t border-gray-700 pt-4">{children}</div>}
    </Card>
  );
}

// ── Field wrapper ───────────────────────────────────────────────────────────

function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Text className="text-gray-300 text-sm font-medium">{label}</Text>
      {children}
      {error && <Text className="text-red-400 text-xs">{error}</Text>}
      {hint && !error && <Text className="text-gray-500 text-xs">{hint}</Text>}
    </div>
  );
}

// ── Component ───────────────────────────────────────────────────────────────

export default function SettingsPage() {
  // Config state
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>({});
  const [toast, setToast] = useState<Toast | null>(null);
  const [dirty, setDirty] = useState(false);

  // Load config
  const loadConfig = useCallback(() => {
    setLoading(true);
    setFetchError(null);
    api
      .getConfig()
      .then((data) => {
        setConfig(data);
        setLoading(false);
        setDirty(false);
      })
      .catch((err) => {
        setFetchError(err instanceof Error ? err.message : 'Failed to load configuration');
        setLoading(false);
        // Fall back to defaults so the form is usable
        setConfig(structuredClone(DEFAULT_CONFIG));
      });
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // Toast auto-dismiss
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  // ── Update helpers ──────────────────────────────────────────────────────

  function updateGeneral<K extends keyof Config['general']>(
    key: K,
    value: Config['general'][K],
  ) {
    setConfig((prev) => {
      if (!prev) return prev;
      return { ...prev, general: { ...prev.general, [key]: value } };
    });
    setDirty(true);
    // Clear validation error for this field
    setValidationErrors((prev) => {
      const next = { ...prev };
      delete next[`general.${key}`];
      return next;
    });
  }

  function updateDisplay<K extends keyof Config['display']>(
    key: K,
    value: Config['display'][K],
  ) {
    setConfig((prev) => {
      if (!prev) return prev;
      return { ...prev, display: { ...prev.display, [key]: value } };
    });
    setDirty(true);

    // Apply theme immediately
    if (key === 'theme') {
      const theme = value as 'dark' | 'light';
      const root = document.documentElement;
      if (theme === 'dark') {
        root.classList.add('dark');
      } else {
        root.classList.remove('dark');
      }
      try {
        localStorage.setItem('ralph-theme', theme);
      } catch {
        // ignore
      }
    }
  }

  function updateScrape<K extends keyof Config['scrape']>(
    key: K,
    value: Config['scrape'][K],
  ) {
    setConfig((prev) => {
      if (!prev) return prev;
      return { ...prev, scrape: { ...prev.scrape, [key]: value } };
    });
    setDirty(true);
  }

  function updateAlerts<K extends keyof Config['alerts']>(
    key: K,
    value: Config['alerts'][K],
  ) {
    setConfig((prev) => {
      if (!prev) return prev;
      return { ...prev, alerts: { ...prev.alerts, [key]: value } };
    });
    setDirty(true);
    setValidationErrors((prev) => {
      const next = { ...prev };
      delete next[`alerts.${key}`];
      return next;
    });
  }

  // ── Validation ──────────────────────────────────────────────────────────

  function validate(): boolean {
    if (!config) return false;
    const errors: ValidationErrors = {};

    // General
    if (config.general.port < 1 || config.general.port > 65535) {
      errors['general.port'] = 'Port must be between 1 and 65535';
    }
    if (config.general.staleTimeoutMinutes < 1) {
      errors['general.staleTimeoutMinutes'] = 'Stale timeout must be at least 1 minute';
    }
    if (config.general.retentionDays < 1) {
      errors['general.retentionDays'] = 'Retention period must be at least 1 day';
    }
    if (!config.general.dataDir.trim()) {
      errors['general.dataDir'] = 'Data directory is required';
    }

    // Alerts (optional but must be positive if set)
    if (config.alerts.perSessionCostLimit !== null && config.alerts.perSessionCostLimit <= 0) {
      errors['alerts.perSessionCostLimit'] = 'Must be a positive number or empty';
    }
    if (config.alerts.perDayCostLimit !== null && config.alerts.perDayCostLimit <= 0) {
      errors['alerts.perDayCostLimit'] = 'Must be a positive number or empty';
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  }

  // ── Save ────────────────────────────────────────────────────────────────

  async function handleSave() {
    if (!config) return;
    if (!validate()) {
      setToast({ message: 'Please fix validation errors before saving.', type: 'error' });
      return;
    }

    setSaving(true);
    try {
      const updated = await api.updateConfig({
        general: config.general,
        display: config.display,
        scrape: config.scrape,
        alerts: config.alerts,
      });
      setConfig(updated);
      setDirty(false);
      setToast({ message: 'Settings saved successfully.', type: 'success' });
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : 'Failed to save settings.',
        type: 'error',
      });
    } finally {
      setSaving(false);
    }
  }

  // ── Reset to defaults ─────────────────────────────────────────────────

  function handleReset() {
    setConfig(structuredClone(DEFAULT_CONFIG));
    setValidationErrors({});
    setDirty(true);
    setToast({ message: 'Settings reset to defaults. Click Save to apply.', type: 'success' });
  }

  // ── Loading state ─────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-6">
        <Title className="text-2xl font-bold text-gray-100">Settings</Title>
        <Card className="bg-gray-800 ring-gray-700">
          <div className="flex items-center justify-center py-12">
            <Text className="text-gray-400">Loading configuration...</Text>
          </div>
        </Card>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="space-y-6">
        <Title className="text-2xl font-bold text-gray-100">Settings</Title>
        <Card className="bg-red-900/30 ring-red-700">
          <Text className="text-red-300">{fetchError ?? 'Failed to load configuration.'}</Text>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <Flex justifyContent="between" alignItems="center">
        <div>
          <Title className="text-2xl font-bold text-gray-100">Settings</Title>
          <Subtitle className="text-gray-400">
            Configure Ralph Monitor behavior and preferences
          </Subtitle>
        </div>
        {dirty && (
          <Badge color="amber" size="sm">
            Unsaved Changes
          </Badge>
        )}
      </Flex>

      {/* Toast notification */}
      {toast && (
        <Callout
          title={toast.type === 'success' ? 'Success' : 'Error'}
          color={toast.type === 'success' ? 'emerald' : 'red'}
        >
          {toast.message}
        </Callout>
      )}

      {/* Fetch error warning */}
      {fetchError && (
        <Callout title="Warning" color="amber">
          Could not load saved configuration: {fetchError}. Showing defaults.
        </Callout>
      )}

      {/* ── Section 1: General Settings ────────────────────────────────── */}
      <SettingsSection
        title="General Settings"
        description="Core server and storage configuration"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field
            label="Port"
            error={validationErrors['general.port']}
            hint="Server port (1-65535)"
          >
            <NumberInput
              value={config.general.port}
              onValueChange={(val) => updateGeneral('port', val ?? DEFAULT_CONFIG.general.port)}
              min={1}
              max={65535}
              step={1}
              enableStepper={false}
            />
          </Field>

          <Field
            label="Stale Timeout (minutes)"
            error={validationErrors['general.staleTimeoutMinutes']}
            hint="Sessions inactive for this long are marked stale"
          >
            <NumberInput
              value={config.general.staleTimeoutMinutes}
              onValueChange={(val) =>
                updateGeneral('staleTimeoutMinutes', val ?? DEFAULT_CONFIG.general.staleTimeoutMinutes)
              }
              min={1}
              step={1}
              enableStepper={false}
            />
          </Field>

          <Field
            label="Retention Period (days)"
            error={validationErrors['general.retentionDays']}
            hint="Data older than this is cleaned up"
          >
            <NumberInput
              value={config.general.retentionDays}
              onValueChange={(val) =>
                updateGeneral('retentionDays', val ?? DEFAULT_CONFIG.general.retentionDays)
              }
              min={1}
              step={1}
              enableStepper={false}
            />
          </Field>

          <Field
            label="Data Directory"
            error={validationErrors['general.dataDir']}
            hint="Path to store database and event logs"
          >
            <TextInput
              value={config.general.dataDir}
              onChange={(e) => updateGeneral('dataDir', e.target.value)}
              placeholder="./data"
            />
          </Field>
        </div>
      </SettingsSection>

      {/* ── Section 2: Display Settings ────────────────────────────────── */}
      <SettingsSection
        title="Display Settings"
        description="Theme and UI preferences"
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="Theme" hint="Changes take effect immediately">
            <Select
              value={config.display.theme}
              onValueChange={(val) => updateDisplay('theme', val as 'dark' | 'light')}
            >
              <SelectItem value="dark">Dark</SelectItem>
              <SelectItem value="light">Light</SelectItem>
            </Select>
          </Field>

          <Field label="Live Feed Verbosity" hint="Amount of detail in the live feed">
            <Select
              value={config.display.liveFeedVerbosity}
              onValueChange={(val) =>
                updateDisplay('liveFeedVerbosity', val as 'summary' | 'granular')
              }
            >
              <SelectItem value="summary">Summary</SelectItem>
              <SelectItem value="granular">Granular</SelectItem>
            </Select>
          </Field>

          <Field label="Default Cost Range" hint="Default time range for cost analytics">
            <Select
              value={config.display.defaultCostRange}
              onValueChange={(val) =>
                updateDisplay(
                  'defaultCostRange',
                  val as 'today' | 'this week' | 'this month',
                )
              }
            >
              <SelectItem value="today">Today</SelectItem>
              <SelectItem value="this week">This Week</SelectItem>
              <SelectItem value="this month">This Month</SelectItem>
            </Select>
          </Field>
        </div>
      </SettingsSection>

      {/* ── Section 3: Scraping Settings ───────────────────────────────── */}
      <SettingsSection
        title="Scraping Settings"
        description="Control what data is captured from Claude Code sessions"
      >
        <div className="space-y-4">
          <Flex justifyContent="between" alignItems="center">
            <div>
              <Text className="text-gray-300 font-medium">Extended Thinking Capture</Text>
              <Text className="text-gray-500 text-xs">
                Capture extended thinking/reasoning from Claude responses
              </Text>
            </div>
            <Switch
              checked={config.scrape.captureExtendedThinking}
              onChange={() =>
                updateScrape('captureExtendedThinking', !config.scrape.captureExtendedThinking)
              }
            />
          </Flex>

          <div className="border-t border-gray-700 pt-4">
            <Flex justifyContent="between" alignItems="center">
              <div>
                <Text className="text-gray-300 font-medium">Full Response Capture</Text>
                <Text className="text-gray-500 text-xs">
                  Capture complete API responses including full content
                </Text>
              </div>
              <Switch
                checked={config.scrape.captureFullResponses}
                onChange={() =>
                  updateScrape('captureFullResponses', !config.scrape.captureFullResponses)
                }
              />
            </Flex>
            {config.scrape.captureFullResponses && (
              <Callout title="Privacy Warning" color="amber" className="mt-2">
                Full response capture stores all Claude output, which may include
                sensitive code, secrets, or personal information. Enable only when needed
                for debugging.
              </Callout>
            )}
          </div>
        </div>
      </SettingsSection>

      {/* ── Section 4: Alert Thresholds ────────────────────────────────── */}
      <SettingsSection
        title="Alert Thresholds"
        description="Set cost limits to receive alerts when thresholds are exceeded"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field
            label="Per-Session Cost Limit (USD)"
            error={validationErrors['alerts.perSessionCostLimit']}
            hint="Leave empty for no limit"
          >
            <NumberInput
              value={config.alerts.perSessionCostLimit ?? undefined}
              onValueChange={(val) =>
                updateAlerts('perSessionCostLimit', val !== undefined && val > 0 ? val : null)
              }
              min={0}
              step={0.01}
              enableStepper={false}
              placeholder="No limit"
            />
          </Field>

          <Field
            label="Per-Day Cost Limit (USD)"
            error={validationErrors['alerts.perDayCostLimit']}
            hint="Leave empty for no limit"
          >
            <NumberInput
              value={config.alerts.perDayCostLimit ?? undefined}
              onValueChange={(val) =>
                updateAlerts('perDayCostLimit', val !== undefined && val > 0 ? val : null)
              }
              min={0}
              step={0.01}
              enableStepper={false}
              placeholder="No limit"
            />
          </Field>
        </div>
      </SettingsSection>

      {/* ── Save / Reset buttons ──────────────────────────────────────── */}
      <Card className="bg-gray-800 ring-gray-700">
        <Flex justifyContent="end" className="gap-3">
          <Button
            variant="secondary"
            onClick={handleReset}
            disabled={saving}
            className="bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600"
          >
            Reset to Defaults
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={saving || !dirty}
            loading={saving}
            className="bg-blue-600 text-white border-blue-600 hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </Button>
        </Flex>
      </Card>
    </div>
  );
}
