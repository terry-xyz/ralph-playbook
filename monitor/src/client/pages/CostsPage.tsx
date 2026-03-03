import { Card } from '@tremor/react';

export default function CostsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-100">Costs</h1>
      <Card className="bg-gray-800 ring-gray-700">
        <p className="text-gray-300">
          Cost analytics across sessions, projects, and models with daily and weekly breakdowns.
        </p>
      </Card>
    </div>
  );
}
