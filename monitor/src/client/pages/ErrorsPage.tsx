import { Card } from '@tremor/react';

export default function ErrorsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-100">Errors</h1>
      <Card className="bg-gray-800 ring-gray-700">
        <p className="text-gray-300">
          Error log with filtering by category, session, and project. Track tool failures,
          rate limits, and server errors.
        </p>
      </Card>
    </div>
  );
}
