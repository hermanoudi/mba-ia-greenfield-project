import { Readable } from 'stream';
import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';
import { VideoStatus } from '../videos/entities/video-status.enum';
import { NoVideoStreamError } from './ffmpeg.errors';
import { FFmpegService, VideoProbeResult } from './ffmpeg.service';
import { VideoProcessingProcessor } from './video-processing.processor';

// Only `readFile` needs mocking (the mocked `extractThumbnail` returns a path
// that doesn't exist on disk). `unlink` is left real — every call site in the
// processor already swallows failures via `.catch(() => undefined)`, and it's
// what actually cleans up the real temp file `pipeline()` writes below.
jest.mock('fs/promises', () => ({
  readFile: jest.fn().mockResolvedValue(Buffer.from('thumbnail-bytes')),
  unlink:
    jest.requireActual<typeof import('fs/promises')>('fs/promises').unlink,
}));

const PROBE_RESULT: VideoProbeResult = {
  durationSeconds: 12.4,
  width: 1920,
  height: 1080,
  videoCodec: 'h264',
  audioCodec: 'aac',
};

function buildVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-1',
    public_id: 'abc12345678',
    channel_id: 'channel-1',
    title: null,
    status: VideoStatus.PROCESSING,
    storage_key: 'videos/channel-1/video-1/original',
    thumbnail_key: null,
    upload_id: null,
    duration_seconds: null,
    width: null,
    height: null,
    video_codec: null,
    audio_codec: null,
    size_bytes: null,
    failure_reason: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as Video;
}

function buildJob(overrides: Partial<Job> = {}): Job<{ videoId: string }> {
  return {
    data: { videoId: 'video-1' },
    attemptsMade: 0,
    opts: { attempts: 3 },
    ...overrides,
  } as unknown as Job<{ videoId: string }>;
}

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  let videoRepository: jest.Mocked<Partial<Repository<Video>>>;
  let ffmpegService: jest.Mocked<Partial<FFmpegService>>;
  let storageService: jest.Mocked<Partial<StorageService>>;

  beforeEach(() => {
    videoRepository = {
      findOneBy: jest.fn(),
      save: jest.fn().mockImplementation((v) => Promise.resolve(v as Video)),
    };
    ffmpegService = {
      probe: jest.fn().mockResolvedValue(PROBE_RESULT),
      extractThumbnail: jest.fn().mockResolvedValue('/tmp/thumbnail.jpg'),
    };
    storageService = {
      getObjectStream: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve(Readable.from(Buffer.from('fake-video-bytes'))),
        ),
      putObject: jest.fn().mockResolvedValue(undefined),
    };
    processor = new VideoProcessingProcessor(
      videoRepository as Repository<Video>,
      ffmpegService as FFmpegService,
      storageService as StorageService,
    );
  });

  it('transitions processing -> ready and persists metadata + thumbnail_key on success', async () => {
    const video = buildVideo();
    (videoRepository.findOneBy as jest.Mock).mockResolvedValue(video);

    await processor.process(buildJob());

    expect(storageService.getObjectStream).toHaveBeenCalledWith(
      video.storage_key,
    );
    expect(ffmpegService.extractThumbnail).toHaveBeenCalledWith(
      expect.any(String),
      PROBE_RESULT.durationSeconds,
    );
    expect(storageService.putObject).toHaveBeenCalledWith(
      'thumbnails/channel-1/video-1/thumb.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );
    expect(videoRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: VideoStatus.READY,
        duration_seconds: 12,
        width: 1920,
        height: 1080,
        video_codec: 'h264',
        audio_codec: 'aac',
        thumbnail_key: 'thumbnails/channel-1/video-1/thumb.jpg',
        failure_reason: null,
      }),
    );
  });

  it('persists failed + failure_reason immediately when the source has no video stream, without retrying', async () => {
    const video = buildVideo();
    (videoRepository.findOneBy as jest.Mock).mockResolvedValue(video);
    const error = new NoVideoStreamError('No video stream found');
    (ffmpegService.probe as jest.Mock).mockRejectedValue(error);

    await expect(processor.process(buildJob())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    expect(videoRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: VideoStatus.FAILED,
        failure_reason: 'No video stream found',
      }),
    );
  });

  it('rethrows without persisting failed when BullMQ attempts are not yet exhausted', async () => {
    const video = buildVideo();
    (videoRepository.findOneBy as jest.Mock).mockResolvedValue(video);
    const error = new Error('ffmpeg exited with code 1');
    (ffmpegService.probe as jest.Mock).mockRejectedValue(error);

    await expect(
      processor.process(buildJob({ attemptsMade: 0, opts: { attempts: 3 } })),
    ).rejects.toThrow(error);

    expect(videoRepository.save).not.toHaveBeenCalled();
  });

  it('persists failed + failure_reason once BullMQ attempts are exhausted', async () => {
    const video = buildVideo();
    (videoRepository.findOneBy as jest.Mock).mockResolvedValue(video);
    const error = new Error('ffmpeg exited with code 1');
    (ffmpegService.probe as jest.Mock).mockRejectedValue(error);

    await expect(
      processor.process(buildJob({ attemptsMade: 2, opts: { attempts: 3 } })),
    ).rejects.toThrow(error);

    expect(videoRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: VideoStatus.FAILED,
        failure_reason: 'ffmpeg exited with code 1',
      }),
    );
  });

  it('is idempotent: reprocessing a video already ready is a no-op', async () => {
    const video = buildVideo({ status: VideoStatus.READY });
    (videoRepository.findOneBy as jest.Mock).mockResolvedValue(video);

    await processor.process(buildJob());

    expect(storageService.getObjectStream).not.toHaveBeenCalled();
    expect(videoRepository.save).not.toHaveBeenCalled();
  });
});
