import { Link } from 'react-router-dom';
import { EmptyState } from '../ui/atoms';

export default function NotFound() {
  return (
    <EmptyState
      icon="⌗"
      title="Page not found"
      description="The page you are looking for does not exist or you do not have access to it."
      action={
        <Link className="btn btn-primary btn-sm" to="/">
          Back to dashboard
        </Link>
      }
    />
  );
}
