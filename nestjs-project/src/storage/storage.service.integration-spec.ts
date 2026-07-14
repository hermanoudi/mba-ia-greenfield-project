import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let service: StorageService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      ],
      providers: [StorageService],
    }).compile();

    service = module.get(StorageService);
  });

  async function uploadAndComplete(
    key: string,
    content: Buffer,
  ): Promise<void> {
    const uploadId = await service.createMultipartUpload(key);
    const partUrl = await service.presignUploadPart(key, uploadId, 1);
    const putResponse = await fetch(partUrl, {
      method: 'PUT',
      body: new Uint8Array(content),
    });
    const eTag = putResponse.headers.get('etag');
    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, eTag: eTag! },
    ]);
  }

  it('completes a multipart upload round-trip and confirms it via headObject', async () => {
    const key = `test/${randomUUID()}/original`;
    const content = Buffer.from('a'.repeat(10 * 1024));

    const uploadId = await service.createMultipartUpload(key);
    expect(uploadId).toEqual(expect.any(String));

    const partUrl = await service.presignUploadPart(key, uploadId, 1);
    const putResponse = await fetch(partUrl, {
      method: 'PUT',
      body: new Uint8Array(content),
    });
    expect(putResponse.status).toBe(200);
    const eTag = putResponse.headers.get('etag');
    expect(eTag).toEqual(expect.any(String));

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, eTag: eTag! },
    ]);

    const head = await service.headObject(key);
    expect(head).toEqual({ sizeBytes: content.length });
  });

  it('signals absence for a key that was never uploaded', async () => {
    const head = await service.headObject(`test/${randomUUID()}/missing`);
    expect(head).toBeNull();
  });

  it('generates a presigned GET URL that serves the object content directly', async () => {
    const key = `test/${randomUUID()}/original`;
    const content = Buffer.from('presigned-get-content');
    await uploadAndComplete(key, content);

    const getUrl = await service.presignGetObject(key);
    const getResponse = await fetch(getUrl);

    expect(getResponse.status).toBe(200);
    expect(await getResponse.text()).toBe(content.toString());
  });

  it('generates a presigned GET URL with Content-Disposition: attachment when downloadFilename is set', async () => {
    const key = `test/${randomUUID()}/original`;
    const content = Buffer.from('download-content');
    await uploadAndComplete(key, content);

    const downloadUrl = await service.presignGetObject(key, {
      downloadFilename: 'my-video.mp4',
    });
    const response = await fetch(downloadUrl);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="my-video.mp4"',
    );
  });

  it('aborts a multipart upload without leaving a retrievable object', async () => {
    const key = `test/${randomUUID()}/original`;

    const uploadId = await service.createMultipartUpload(key);
    await service.abortMultipartUpload(key, uploadId);

    const head = await service.headObject(key);
    expect(head).toBeNull();
  });
});
