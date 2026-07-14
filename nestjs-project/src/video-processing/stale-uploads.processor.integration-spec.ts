import { randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
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
import { StaleUploadsProcessor } from './stale-uploads.processor';
import { STALE_UPLOAD_TTL_MS } from './video-processing.constants';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('StaleUploadsProcessor (integration)', () => {
  let dataSource: DataSource;
  let staleUploadsProcessor: StaleUploadsProcessor;
  let storageService: StorageService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
      ],
      providers: [StorageService, StaleUploadsProcessor],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    staleUploadsProcessor = moduleRef.get(StaleUploadsProcessor);
    storageService = moduleRef.get(StorageService);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createDraftVideo(createdAt: Date): Promise<Video> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `stale_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `channel-stale-${counter}`,
        user_id: user.id,
      }),
    );
    const videoId = randomUUID();
    const storageKey = buildVideoStorageKey(channel.id, videoId);
    const uploadId = await storageService.createMultipartUpload(storageKey);
    const video = await videoRepository.save(
      videoRepository.create({
        id: videoId,
        public_id: `sv${counter}`.padEnd(11, '0'),
        channel_id: channel.id,
        status: VideoStatus.DRAFT,
        storage_key: storageKey,
        upload_id: uploadId,
      }),
    );
    await videoRepository.update(video.id, { created_at: createdAt });
    return video;
  }

  it('reclaims a stale draft: aborts the multipart upload and marks it failed', async () => {
    const staleCreatedAt = new Date(Date.now() - STALE_UPLOAD_TTL_MS - 60_000);
    const video = await createDraftVideo(staleCreatedAt);

    await staleUploadsProcessor.reconcile();

    const reloaded = await videoRepository.findOneBy({ id: video.id });
    expect(reloaded?.status).toBe(VideoStatus.FAILED);
    expect(reloaded?.failure_reason).toMatch(/stale upload/i);

    await expect(
      storageService.completeMultipartUpload(
        video.storage_key,
        video.upload_id!,
        [{ partNumber: 1, eTag: '"deadbeef"' }],
      ),
    ).rejects.toThrow();
  });

  it('ignores a draft within the 24h window', async () => {
    const recentCreatedAt = new Date(Date.now() - 60_000);
    const video = await createDraftVideo(recentCreatedAt);

    await staleUploadsProcessor.reconcile();

    const reloaded = await videoRepository.findOneBy({ id: video.id });
    expect(reloaded?.status).toBe(VideoStatus.DRAFT);
  });

  it('is idempotent: running the reconciliation twice over the same stale draft does not error', async () => {
    const staleCreatedAt = new Date(Date.now() - STALE_UPLOAD_TTL_MS - 60_000);
    const video = await createDraftVideo(staleCreatedAt);

    await staleUploadsProcessor.reconcile();
    await expect(staleUploadsProcessor.reconcile()).resolves.not.toThrow();

    const reloaded = await videoRepository.findOneBy({ id: video.id });
    expect(reloaded?.status).toBe(VideoStatus.FAILED);
  });
});
