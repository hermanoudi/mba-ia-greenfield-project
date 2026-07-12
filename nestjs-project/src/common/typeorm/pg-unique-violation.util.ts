import { QueryFailedError } from 'typeorm';

const PG_UNIQUE_VIOLATION = '23505';

function isPgUniqueViolationError(
  err: unknown,
): err is QueryFailedError & { code: string; detail: string } {
  return (
    err instanceof QueryFailedError &&
    typeof (err as { code?: unknown }).code === 'string' &&
    typeof (err as { detail?: unknown }).detail === 'string'
  );
}

export function isPgUniqueViolationOnColumn(
  err: unknown,
  column: string,
): boolean {
  return (
    isPgUniqueViolationError(err) &&
    err.code === PG_UNIQUE_VIOLATION &&
    err.detail.includes(column)
  );
}
