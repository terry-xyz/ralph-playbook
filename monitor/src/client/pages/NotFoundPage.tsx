import { Link } from 'react-router-dom';
import { Card } from '@tremor/react';

export default function NotFoundPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-100">404 — Page Not Found</h1>
      <Card className="bg-gray-800 ring-gray-700">
        <p className="text-gray-300">
          The page you are looking for does not exist.
        </p>
        <Link
          to="/dashboard"
          className="mt-4 inline-block text-blue-400 hover:text-blue-300 underline"
        >
          Go to Dashboard
        </Link>
      </Card>
    </div>
  );
}
