import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import { VideoStatus } from './entities/video-status.enum';
import { VideosService } from './videos.service';

function uniqueViolationOn(column: string): QueryFailedError {
  return Object.assign(
    new QueryFailedError(
      'INSERT INTO "videos" ...',
      [],
      new Error('duplicate key'),
    ),
    { code: '23505', detail: `Key (${column})=(x) already exists.` },
  );
}

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: jest.Mocked<Partial<Repository<Video>>>;
  let channelsService: jest.Mocked<Partial<ChannelsService>>;
  let storageService: jest.Mocked<Partial<StorageService>>;

  const channel = { id: 'channel-1' } as Channel;

  const baseDto: CreateVideoDto = {
    filename: 'clip.mp4',
    sizeBytes: 104857600, // 100MiB -> 2 parts of 50MiB
    contentType: 'video/mp4',
  };

  beforeEach(() => {
    videoRepository = {
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn(
        (entity) => entity as Video,
      ) as unknown as Repository<Video>['create'],
      save: jest.fn().mockResolvedValue(undefined as unknown as Video),
    };
    channelsService = {
      findByUserId: jest.fn().mockResolvedValue(channel),
    };
    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-123'),
      presignUploadPart: jest
        .fn()
        .mockImplementation(
          (_key: string, _uploadId: string, partNumber: number) =>
            Promise.resolve(`https://storage.test/part-${partNumber}`),
        ),
    };

    service = new VideosService(
      videoRepository as unknown as Repository<Video>,
      channelsService as unknown as ChannelsService,
      storageService as unknown as StorageService,
    );
  });

  it('should create a draft video and return presigned upload parts', async () => {
    const result = await service.initiateUpload('user-1', baseDto);

    expect(result.uploadId).toBe('upload-123');
    expect(result.partSize).toBe(52428800);
    expect(result.parts).toEqual([
      { partNumber: 1, url: 'https://storage.test/part-1' },
      { partNumber: 2, url: 'https://storage.test/part-2' },
    ]);
    expect(videoRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: 'channel-1',
        status: VideoStatus.DRAFT,
        public_id: result.publicId,
        upload_id: 'upload-123',
      }),
    );
    expect(videoRepository.save).toHaveBeenCalledTimes(1);
  });

  it('should calculate a single part when sizeBytes is smaller than the part size', async () => {
    const result = await service.initiateUpload('user-1', {
      ...baseDto,
      sizeBytes: 1024,
    });

    expect(result.parts).toHaveLength(1);
  });

  it('should regenerate the public_id on collision', async () => {
    (videoRepository.exists as jest.Mock)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await service.initiateUpload('user-1', baseDto);

    expect(videoRepository.exists).toHaveBeenCalledTimes(2);
  });

  it('should throw when the authenticated user has no channel', async () => {
    (channelsService.findByUserId as jest.Mock).mockResolvedValueOnce(null);

    await expect(service.initiateUpload('user-1', baseDto)).rejects.toThrow();
  });

  it('should retry the save with a fresh public_id when a concurrent insert wins the race against the exists() pre-check', async () => {
    (videoRepository.save as jest.Mock)
      .mockRejectedValueOnce(uniqueViolationOn('public_id'))
      .mockResolvedValueOnce(undefined);

    const result = await service.initiateUpload('user-1', baseDto);

    expect(videoRepository.save).toHaveBeenCalledTimes(2);
    expect(result.publicId).toHaveLength(11);
    expect(videoRepository.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ public_id: result.publicId }),
    );
  });

  it('should rethrow a save error unrelated to a public_id collision', async () => {
    (videoRepository.save as jest.Mock).mockRejectedValueOnce(
      uniqueViolationOn('some_other_column'),
    );

    await expect(service.initiateUpload('user-1', baseDto)).rejects.toThrow();
    expect(videoRepository.save).toHaveBeenCalledTimes(1);
  });
});
