import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { Channel } from '../src/channels/entities/channel.entity';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/entities/video-status.enum';
import { buildVideoStorageKey } from '../src/videos/video-storage-key.util';

describe('videos-read (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

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
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createVideo(overrides: Partial<Video> = {}): Promise<Video> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_read_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `channel-read-${counter}`,
        user_id: user.id,
      }),
    );
    const videoId = randomUUID();
    return videoRepository.save(
      videoRepository.create({
        id: videoId,
        public_id: `rv${counter}`.padEnd(11, '0'),
        channel_id: channel.id,
        status: VideoStatus.DRAFT,
        storage_key: buildVideoStorageKey(channel.id, videoId),
        ...overrides,
      }),
    );
  }

  // 1. Detalhes do vídeo
  describe('GET /videos/:publicId', () => {
    it('ready-retorna-200-com-thumbnail', async () => {
      const video = await createVideo({
        status: VideoStatus.READY,
        duration_seconds: 12,
        width: 1920,
        height: 1080,
        thumbnail_key: 'thumbnails/x/y/thumb.jpg',
      });

      const res = await request(app.getHttpServer()).get(
        `/videos/${video.public_id}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.durationSeconds).toBe(12);
      expect(res.body.width).toBe(1920);
      expect(res.body.height).toBe(1080);
      expect(typeof res.body.thumbnailUrl).toBe('string');
      expect(res.body.thumbnailUrl.length).toBeGreaterThan(0);
    });

    it('nao-ready-por-nao-dono-retorna-403', async () => {
      const video = await createVideo({ status: VideoStatus.PROCESSING });

      const res = await request(app.getHttpServer()).get(
        `/videos/${video.public_id}`,
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN_VIDEO_ACCESS');
    });

    it('publicid-inexistente-retorna-404', async () => {
      const res = await request(app.getHttpServer()).get(
        '/videos/doesnotexist',
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });

  // 2. URLs de entrega (streaming e download)
  describe('GET /videos/:publicId/playback-url and /download-url', () => {
    it('playback-url-de-ready-retorna-200', async () => {
      const video = await createVideo({ status: VideoStatus.READY });

      const res = await request(app.getHttpServer()).get(
        `/videos/${video.public_id}/playback-url`,
      );

      expect(res.status).toBe(200);
      expect(typeof res.body.url).toBe('string');
      expect(res.body.expiresIn).toBe(3600);
    });

    it('entrega-de-nao-ready-retorna-409', async () => {
      const video = await createVideo({ status: VideoStatus.PROCESSING });

      const playbackRes = await request(app.getHttpServer()).get(
        `/videos/${video.public_id}/playback-url`,
      );
      expect(playbackRes.status).toBe(409);
      expect(playbackRes.body.error).toBe('VIDEO_NOT_READY');

      const downloadRes = await request(app.getHttpServer()).get(
        `/videos/${video.public_id}/download-url`,
      );
      expect(downloadRes.status).toBe(409);
      expect(downloadRes.body.error).toBe('VIDEO_NOT_READY');
    });
  });
});
