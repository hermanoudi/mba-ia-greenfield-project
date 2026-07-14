import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { InitiateUploadResponseDto } from '../src/videos/dto/initiate-upload-response.dto';
import { Video } from '../src/videos/entities/video.entity';

interface LoginResponseBody {
  access_token: string;
}

describe('POST /videos (início do upload) (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;

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
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (
      authService as unknown as { mailService: MailService }
    ).mailService;
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
    return (res.body as LoginResponseBody).access_token;
  }

  describe('início de upload', () => {
    it('inicio-valido-retorna-201-com-presigned-parts', async () => {
      const accessToken = await registerConfirmAndLogin('upload-init@test.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          filename: 'clip.mp4',
          sizeBytes: 104857600,
          contentType: 'video/mp4',
        });

      expect(res.status).toBe(201);
      const body = res.body as InitiateUploadResponseDto;
      expect(body.publicId).toHaveLength(11);
      expect(body.uploadId).toEqual(expect.any(String));
      expect(body.key).toEqual(expect.any(String));
      expect(body.partSize).toBe(52428800);
      expect(Array.isArray(body.parts)).toBe(true);
      expect(body.parts.length).toBeGreaterThan(0);
      expect(typeof body.parts[0].partNumber).toBe('number');
      expect(typeof body.parts[0].url).toBe('string');

      const videoRepository = dataSource.getRepository(Video);
      const video = await videoRepository.findOneBy({
        public_id: body.publicId,
      });
      expect(video).not.toBeNull();
      expect(video?.status).toBe('draft');
      expect(video?.public_id).toHaveLength(11);
    });

    it('sem-sessao-retorna-401', async () => {
      const res = await request(app.getHttpServer()).post('/videos').send({
        filename: 'clip.mp4',
        sizeBytes: 104857600,
        contentType: 'video/mp4',
      });

      expect(res.status).toBe(401);

      const videoRepository = dataSource.getRepository(Video);
      const count = await videoRepository.count();
      expect(count).toBe(0);
    });

    it('body-invalido-retorna-400', async () => {
      const accessToken = await registerConfirmAndLogin(
        'upload-init-invalid@test.com',
      );

      const oversizedRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          filename: 'clip.mp4',
          sizeBytes: 10737418241,
          contentType: 'video/mp4',
        });
      expect(oversizedRes.status).toBe(400);

      const missingFilenameRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          sizeBytes: 104857600,
          contentType: 'video/mp4',
        });
      expect(missingFilenameRes.status).toBe(400);

      const videoRepository = dataSource.getRepository(Video);
      const count = await videoRepository.count();
      expect(count).toBe(0);
    });
  });
});
