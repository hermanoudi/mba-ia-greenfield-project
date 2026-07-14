import { nanoid } from 'nanoid';

const PUBLIC_ID_LENGTH = 11;
const MAX_RETRIES = 5;

export function generatePublicId(): string {
  return nanoid(PUBLIC_ID_LENGTH);
}

export async function generateUniquePublicId(
  exists: (candidate: string) => Promise<boolean>,
): Promise<string> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const candidate = generatePublicId();
    if (!(await exists(candidate))) {
      return candidate;
    }
  }
  throw new Error('Could not generate a unique public_id after max retries');
}
