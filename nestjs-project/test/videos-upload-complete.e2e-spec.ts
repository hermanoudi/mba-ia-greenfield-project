import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { putContentAndGetEtag } from '../src/test/storage-test-helpers';
import { VIDEO_PROCESSING_QUEUE } from '../src/video-processing/video-processing.constants';
import { Video } from '../src/videos/entities/video.entity';

const UPLOAD_CONTENT = Buffer.from('a'.repeat(2048));

describe('POST /videos/:publicId/complete (conclusão do upload) (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let queue: Queue;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain(true);
  });

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    return capturedToken;
  }

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return res.body.access_token;
  }

  interface InitiatedUpload {
    publicId: string;
    parts: { partNumber: number; url: string }[];
  }

  async function initiateUpload(
    accessToken: string,
    sizeBytes: number,
  ): Promise<InitiatedUpload> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        filename: 'clip.mp4',
        sizeBytes,
        contentType: 'video/mp4',
      });
    return { publicId: res.body.publicId, parts: res.body.parts };
  }

  describe('conclusão de upload', () => {
    it('dono-com-objeto-presente-retorna-200-processing', async () => {
      const accessToken = await registerConfirmAndLogin(
        'upload-complete-owner@test.com',
      );
      const { publicId, parts } = await initiateUpload(
        accessToken,
        UPLOAD_CONTENT.length,
      );
      const etag = await putContentAndGetEtag(parts[0].url, UPLOAD_CONTENT);

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, etag }] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ publicId, status: 'processing' });

      const videoRepository = dataSource.getRepository(Video);
      const video = await videoRepository.findOneBy({ public_id: publicId });
      expect(video?.status).toBe('processing');
      expect(video?.upload_id).toBeNull();

      const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
      expect(
        jobs.some(
          (job) =>
            job.name === 'video.process' && job.data.videoId === video?.id,
        ),
      ).toBe(true);
    });

    it('status-diferente-de-draft-retorna-409', async () => {
      const accessToken = await registerConfirmAndLogin(
        'upload-complete-nondraft@test.com',
      );
      const { publicId, parts } = await initiateUpload(
        accessToken,
        UPLOAD_CONTENT.length,
      );
      const etag = await putContentAndGetEtag(parts[0].url, UPLOAD_CONTENT);
      await request(app.getHttpServer())
        .post(`/videos/${publicId}/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, etag }] });

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, etag }] });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('INVALID_UPLOAD_STATE');
    });

    it('headobject-nao-confirma-retorna-422', async () => {
      const accessToken = await registerConfirmAndLogin(
        'upload-complete-badsize@test.com',
      );
      const actualContent = Buffer.from('a'.repeat(1024));
      const { publicId, parts } = await initiateUpload(
        accessToken,
        UPLOAD_CONTENT.length,
      );
      const etag = await putContentAndGetEtag(parts[0].url, actualContent);

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, etag }] });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('UPLOAD_VERIFICATION_FAILED');

      const videoRepository = dataSource.getRepository(Video);
      const video = await videoRepository.findOneBy({ public_id: publicId });
      expect(video?.status).toBe('draft');
    });

    it('nao-dono-retorna-403', async () => {
      const ownerToken = await registerConfirmAndLogin(
        'upload-complete-owner2@test.com',
      );
      const otherToken = await registerConfirmAndLogin(
        'upload-complete-other@test.com',
      );
      const { publicId, parts } = await initiateUpload(
        ownerToken,
        UPLOAD_CONTENT.length,
      );
      const etag = await putContentAndGetEtag(parts[0].url, UPLOAD_CONTENT);

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/complete`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ parts: [{ partNumber: 1, etag }] });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN_VIDEO_ACCESS');
    });
  });
});
