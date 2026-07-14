import { randomUUID } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import redisConfig from '../config/redis.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoStatus } from '../videos/entities/video-status.enum';
import { buildVideoStorageKey } from '../videos/video-storage-key.util';
import { VideoProcessingWorkerModule } from './video-processing-worker.module';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const FIXTURE_WITH_VIDEO = join(__dirname, 'fixtures', 'sample-with-video.mp4');

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 20000,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

describe('VideoProcessingProcessor (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let queue: Queue;
  let storageService: StorageService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [redisConfig, storageConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideoProcessingWorkerModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    dataSource = app.get(DataSource);
    queue = app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    storageService = app.get(StorageService);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  }, 30000);

  afterAll(async () => {
    await queue.close();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain(true);
  });

  let counter = 0;
  async function createProcessingVideo(): Promise<Video> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_process_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `channel-process-${counter}`,
        user_id: user.id,
      }),
    );
    const videoId = randomUUID();
    const storageKey = buildVideoStorageKey(channel.id, videoId);
    await storageService.putObject(
      storageKey,
      readFileSync(FIXTURE_WITH_VIDEO),
      'video/mp4',
    );
    return videoRepository.save(
      videoRepository.create({
        id: videoId,
        public_id: `pv${counter}`.padEnd(11, '0'),
        channel_id: channel.id,
        status: VideoStatus.PROCESSING,
        storage_key: storageKey,
      }),
    );
  }

  it('processes a real job: processing -> ready with metadata and thumbnail_key filled', async () => {
    const video = await createProcessingVideo();

    await queue.add('video.process', { videoId: video.id });

    await waitUntil(async () => {
      const reloaded = await videoRepository.findOneBy({ id: video.id });
      return reloaded !== null && reloaded.status !== VideoStatus.PROCESSING;
    });

    const reloaded = await videoRepository.findOneBy({ id: video.id });
    expect(reloaded?.status).toBe(VideoStatus.READY);
    expect(reloaded?.duration_seconds).toBeCloseTo(2, 0);
    expect(reloaded?.width).toBe(320);
    expect(reloaded?.height).toBe(240);
    expect(reloaded?.video_codec).toBe('h264');
    expect(reloaded?.thumbnail_key).toBe(
      `thumbnails/${video.channel_id}/${video.id}/thumb.jpg`,
    );

    const thumbnailHead = await storageService.headObject(
      reloaded!.thumbnail_key!,
    );
    expect(thumbnailHead).not.toBeNull();
    expect(thumbnailHead!.sizeBytes).toBeGreaterThan(0);
  }, 30000);
});
