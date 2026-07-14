import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { VideoStatus } from './video-status.enum';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
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
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vid_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `vidchan${counter}`,
        user_id: user.id,
      }),
    );
  }

  async function createVideo(
    channelId: string,
    overrides: Partial<Pick<Video, 'public_id' | 'storage_key'>> = {},
  ): Promise<Video> {
    return videoRepository.save(
      videoRepository.create({
        public_id: `vid${(++counter).toString().padStart(8, '0')}`,
        channel_id: channelId,
        storage_key: `videos/${counter}/original`,
        ...overrides,
      }),
    );
  }

  it('should enforce unique public_id constraint', async () => {
    const channel = await createChannel();

    await createVideo(channel.id, { public_id: 'abcdefghijk' });

    await expect(
      createVideo(channel.id, { public_id: 'abcdefghijk' }),
    ).rejects.toThrow();
  });

  it('should default status to draft when not explicitly set', async () => {
    const channel = await createChannel();

    const video = await createVideo(channel.id);

    expect(video.status).toBe(VideoStatus.DRAFT);
  });

  it('should cascade delete videos when the owning channel is removed', async () => {
    const channel = await createChannel();
    const video = await createVideo(channel.id);

    await channelRepository.delete({ id: channel.id });

    const found = await videoRepository.findOne({
      where: { public_id: video.public_id },
    });
    expect(found).toBeNull();
  });

  it('should load the related channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    const video = await createVideo(channel.id);

    const found = await videoRepository.findOne({
      where: { public_id: video.public_id },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
  });
});
