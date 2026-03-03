import { Card } from '@tremor/react';

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-100">Settings</h1>
      <Card className="bg-gray-800 ring-gray-700">
        <p className="text-gray-300">
          Configure ingestion, guardrails, display preferences, model pricing, and alert
          thresholds.
        </p>
      </Card>
    </div>
  );
}
