import { randomUUID } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import redisConfig from '../config/redis.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { putContentAndGetEtag } from '../test/storage-test-helpers';
import { User } from '../users/entities/user.entity';
import { VIDEO_PROCESSING_QUEUE } from '../video-processing/video-processing.constants';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { Video } from './entities/video.entity';
import { VideoStatus } from './entities/video-status.enum';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService.completeUpload (integration)', () => {
  let dataSource: DataSource;
  let videosService: VideosService;
  let channelsService: ChannelsService;
  let storageService: StorageService;
  let queue: Queue;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [redisConfig, storageConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    dataSource = module.get(DataSource);
    videosService = module.get(VideosService);
    channelsService = module.get(ChannelsService);
    storageService = module.get(StorageService);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
  }, 30000);

  afterAll(async () => {
    await queue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain(true);
  });

  let userCounter = 0;
  async function createOwner(): Promise<{
    userId: string;
    channelId: string;
  }> {
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_complete_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelsService.createChannel(user.id, user.email);
    return { userId: user.id, channelId: channel.id };
  }

  async function createDraftVideo(
    channelId: string,
    declaredSizeBytes: number,
  ): Promise<Video> {
    const videoId = randomUUID();
    const storageKey = `videos/${channelId}/${videoId}/original`;
    const uploadId = await storageService.createMultipartUpload(storageKey);

    return videoRepository.save(
      videoRepository.create({
        id: videoId,
        public_id: videoId.replace(/-/g, '').slice(0, 11),
        channel_id: channelId,
        status: VideoStatus.DRAFT,
        storage_key: storageKey,
        upload_id: uploadId,
        size_bytes: String(declaredSizeBytes),
      }),
    );
  }

  async function uploadPart(
    video: Video,
    content: Buffer,
  ): Promise<{ partNumber: number; etag: string }> {
    const partUrl = await storageService.presignUploadPart(
      video.storage_key,
      video.upload_id!,
      1,
    );
    return {
      partNumber: 1,
      etag: await putContentAndGetEtag(partUrl, content),
    };
  }

  it('persists status = processing and publishes the video.process job to the real queue', async () => {
    const { userId, channelId } = await createOwner();
    const content = Buffer.from('a'.repeat(2048));
    const video = await createDraftVideo(channelId, content.length);
    const part = await uploadPart(video, content);
    const dto: CompleteUploadDto = { parts: [part] };

    const result = await videosService.completeUpload(
      userId,
      video.public_id,
      dto,
    );

    expect(result).toEqual({
      publicId: video.public_id,
      status: 'processing',
    });

    const persisted = await videoRepository.findOneBy({ id: video.id });
    expect(persisted!.status).toBe(VideoStatus.PROCESSING);
    expect(persisted!.upload_id).toBeNull();

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(
      jobs.some(
        (job) => job.name === 'video.process' && job.data.videoId === video.id,
      ),
    ).toBe(true);
  });

  it('rejects and leaves the video in draft when the confirmed object size does not match the declared size', async () => {
    const { userId, channelId } = await createOwner();
    const content = Buffer.from('a'.repeat(2048));
    // Declare a size larger than what will actually be uploaded, forcing a post-completion mismatch.
    const video = await createDraftVideo(channelId, content.length + 1);
    const part = await uploadPart(video, content);
    const dto: CompleteUploadDto = { parts: [part] };

    await expect(
      videosService.completeUpload(userId, video.public_id, dto),
    ).rejects.toThrow();

    const persisted = await videoRepository.findOneBy({ id: video.id });
    expect(persisted!.status).toBe(VideoStatus.DRAFT);

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.some((job) => job.data.videoId === video.id)).toBe(false);
  });
});
