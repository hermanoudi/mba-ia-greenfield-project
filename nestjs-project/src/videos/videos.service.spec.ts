import type { Queue } from 'bullmq';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import {
  ForbiddenVideoAccessException,
  InvalidUploadStateException,
  UploadVerificationFailedException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
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
  let videoProcessingQueue: jest.Mocked<Partial<Queue>>;

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
      findOneBy: jest.fn().mockResolvedValue(null),
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
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn().mockResolvedValue({ sizeBytes: 1024 }),
      presignGetObject: jest
        .fn()
        .mockResolvedValue('https://storage.test/presigned-get'),
    };
    videoProcessingQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    service = new VideosService(
      videoRepository as unknown as Repository<Video>,
      channelsService as unknown as ChannelsService,
      storageService as unknown as StorageService,
      videoProcessingQueue as unknown as Queue,
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

  describe('completeUpload', () => {
    const draftVideo = {
      id: 'video-1',
      public_id: 'abcdefghijk',
      channel_id: 'channel-1',
      status: VideoStatus.DRAFT,
      storage_key: 'videos/channel-1/video-1/original',
      upload_id: 'upload-123',
      size_bytes: '1024',
    } as Video;

    const completeDto: CompleteUploadDto = {
      parts: [{ partNumber: 1, etag: 'etag-1' }],
    };

    beforeEach(() => {
      (videoRepository.findOneBy as jest.Mock).mockResolvedValue({
        ...draftVideo,
      });
    });

    it('should transition to processing and enqueue the video.process job', async () => {
      const result = await service.completeUpload(
        'user-1',
        draftVideo.public_id,
        completeDto,
      );

      expect(result).toEqual({
        publicId: draftVideo.public_id,
        status: VideoStatus.PROCESSING,
      });
      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        draftVideo.storage_key,
        draftVideo.upload_id,
        [{ partNumber: 1, eTag: 'etag-1' }],
      );
      expect(videoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: VideoStatus.PROCESSING,
          upload_id: null,
        }),
      );
      expect(videoProcessingQueue.add).toHaveBeenCalledWith('video.process', {
        videoId: draftVideo.id,
      });
    });

    it('should throw UploadVerificationFailedException when headObject cannot confirm the object', async () => {
      (storageService.headObject as jest.Mock).mockResolvedValueOnce(null);

      await expect(
        service.completeUpload('user-1', draftVideo.public_id, completeDto),
      ).rejects.toThrow(UploadVerificationFailedException);
      expect(videoRepository.save).not.toHaveBeenCalled();
      expect(videoProcessingQueue.add).not.toHaveBeenCalled();
    });

    it('should throw UploadVerificationFailedException when the confirmed size does not match', async () => {
      (storageService.headObject as jest.Mock).mockResolvedValueOnce({
        sizeBytes: 999,
      });

      await expect(
        service.completeUpload('user-1', draftVideo.public_id, completeDto),
      ).rejects.toThrow(UploadVerificationFailedException);
    });

    it('should throw InvalidUploadStateException when the video is not in draft status', async () => {
      (videoRepository.findOneBy as jest.Mock).mockResolvedValueOnce({
        ...draftVideo,
        status: VideoStatus.PROCESSING,
      });

      await expect(
        service.completeUpload('user-1', draftVideo.public_id, completeDto),
      ).rejects.toThrow(InvalidUploadStateException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('should throw VideoNotFoundException when no video matches the publicId', async () => {
      (videoRepository.findOneBy as jest.Mock).mockResolvedValueOnce(null);

      await expect(
        service.completeUpload('user-1', 'unknown-id', completeDto),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('should throw ForbiddenVideoAccessException when the caller does not own the channel', async () => {
      (videoRepository.findOneBy as jest.Mock).mockResolvedValueOnce({
        ...draftVideo,
        channel_id: 'someone-elses-channel',
      });

      await expect(
        service.completeUpload('user-1', draftVideo.public_id, completeDto),
      ).rejects.toThrow(ForbiddenVideoAccessException);
    });
  });

  describe('getDetails', () => {
    const readyVideo = {
      id: 'video-1',
      public_id: 'abcdefghijk',
      channel_id: 'channel-1',
      title: 'My clip',
      status: VideoStatus.READY,
      duration_seconds: 12,
      width: 1920,
      height: 1080,
      thumbnail_key: 'thumbnails/channel-1/video-1/thumb.jpg',
      failure_reason: null,
      created_at: new Date('2026-01-01T00:00:00.000Z'),
    } as Video;

    it('includes thumbnailUrl when the video is ready', async () => {
      (videoRepository.findOneBy as jest.Mock).mockResolvedValueOnce(
        readyVideo,
      );

      const result = await service.getDetails(readyVideo.public_id);

      expect(result.thumbnailUrl).toBe('https://storage.test/presigned-get');
      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        readyVideo.thumbnail_key,
      );
      expect(result.createdAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('omits thumbnailUrl and failureReason when not applicable', async () => {
      (videoRepository.findOneBy as jest.Mock).mockResolvedValueOnce({
        ...readyVideo,
        thumbnail_key: null,
      });

      const result = await service.getDetails(readyVideo.public_id);

      expect(result.thumbnailUrl).toBeNull();
      expect(result.failureReason).toBeNull();
    });

    it('throws VideoNotFoundException when no video matches the publicId', async () => {
      (videoRepository.findOneBy as jest.Mock).mockResolvedValueOnce(null);

      await expect(service.getDetails('unknown-id')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('throws ForbiddenVideoAccessException when a non-owner requests a non-ready video', async () => {
      (videoRepository.findOneBy as jest.Mock).mockResolvedValueOnce({
        ...readyVideo,
        status: VideoStatus.PROCESSING,
      });

      await expect(
        service.getDetails(readyVideo.public_id, undefined),
      ).rejects.toThrow(ForbiddenVideoAccessException);
    });

    it('allows the owner to see a non-ready video, including failureReason when failed', async () => {
      (videoRepository.findOneBy as jest.Mock).mockResolvedValueOnce({
        ...readyVideo,
        status: VideoStatus.FAILED,
        failure_reason: 'ffmpeg exited with code 1',
      });

      const result = await service.getDetails(readyVideo.public_id, 'user-1');

      expect(result.status).toBe(VideoStatus.FAILED);
      expect(result.failureReason).toBe('ffmpeg exited with code 1');
      expect(result.thumbnailUrl).toBeNull();
    });

    it('throws ForbiddenVideoAccessException when an authenticated non-owner requests a non-ready video', async () => {
      (videoRepository.findOneBy as jest.Mock).mockResolvedValueOnce({
        ...readyVideo,
        status: VideoStatus.PROCESSING,
      });
      (channelsService.findByUserId as jest.Mock).mockResolvedValueOnce({
        id: 'someone-elses-channel',
      });

      await expect(
        service.getDetails(readyVideo.public_id, 'user-2'),
      ).rejects.toThrow(ForbiddenVideoAccessException);
    });
  });

  describe('getPlaybackUrl / getDownloadUrl', () => {
    const readyVideo = {
      id: 'video-1',
      public_id: 'abcdefghijk',
      channel_id: 'channel-1',
      status: VideoStatus.READY,
      storage_key: 'videos/channel-1/video-1/original',
    } as Video;

    it('getPlaybackUrl returns a presigned URL and expiresIn for a ready video', async () => {
      (videoRepository.findOneBy as jest.Mock).mockResolvedValueOnce(
        readyVideo,
      );

      const result = await service.getPlaybackUrl(readyVideo.public_id);

      expect(result).toEqual({
        url: 'https://storage.test/presigned-get',
        expiresIn: 3600,
      });
      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        readyVideo.storage_key,
      );
    });

    it('getDownloadUrl marks the presigned URL as an attachment', async () => {
      (videoRepository.findOneBy as jest.Mock).mockResolvedValueOnce(
        readyVideo,
      );

      const result = await service.getDownloadUrl(readyVideo.public_id);

      expect(result.expiresIn).toBe(3600);
      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        readyVideo.storage_key,
        { downloadFilename: readyVideo.public_id },
      );
    });

    it.each([
      ['getPlaybackUrl', () => service.getPlaybackUrl(readyVideo.public_id)],
      ['getDownloadUrl', () => service.getDownloadUrl(readyVideo.public_id)],
    ])(
      '%s throws VideoNotReadyException when the video is not ready',
      async (_name, call) => {
        (videoRepository.findOneBy as jest.Mock).mockResolvedValueOnce({
          ...readyVideo,
          status: VideoStatus.PROCESSING,
        });

        await expect(call()).rejects.toThrow(VideoNotReadyException);
      },
    );

    it('throws VideoNotFoundException when no video matches the publicId', async () => {
      (videoRepository.findOneBy as jest.Mock).mockResolvedValueOnce(null);

      await expect(service.getPlaybackUrl('unknown-id')).rejects.toThrow(
        VideoNotFoundException,
      );
    });
  });
});
