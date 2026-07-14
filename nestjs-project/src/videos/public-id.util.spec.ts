import { generatePublicId, generateUniquePublicId } from './public-id.util';

describe('public-id.util', () => {
  describe('generatePublicId', () => {
    it('should generate an 11-char URL-safe string', () => {
      const id = generatePublicId();

      expect(id).toHaveLength(11);
      expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
    });
  });

  describe('generateUniquePublicId', () => {
    it('should return a candidate that does not collide', async () => {
      const exists = jest.fn().mockResolvedValue(false);

      const id = await generateUniquePublicId(exists);

      expect(id).toHaveLength(11);
      expect(exists).toHaveBeenCalledTimes(1);
    });

    it('should regenerate on collision until a free candidate is found', async () => {
      const exists = jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const id = await generateUniquePublicId(exists);

      expect(id).toHaveLength(11);
      expect(exists).toHaveBeenCalledTimes(2);
    });

    it('should throw after exhausting all retries', async () => {
      const exists = jest.fn().mockResolvedValue(true);

      await expect(generateUniquePublicId(exists)).rejects.toThrow(
        'Could not generate a unique public_id after max retries',
      );
    });
  });
});
