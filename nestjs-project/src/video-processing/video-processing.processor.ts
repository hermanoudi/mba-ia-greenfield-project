import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { unlink, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';
import { VideoStatus } from '../videos/entities/video-status.enum';
import { buildThumbnailStorageKey } from '../videos/video-storage-key.util';
import { NoVideoStreamError } from './ffmpeg.errors';
import { FFmpegService } from './ffmpeg.service';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';

const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

interface VideoProcessJobData {
  videoId: string;
}

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly ffmpegService: FFmpegService,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessJobData>): Promise<void> {
    const video = await this.videoRepository.findOneBy({
      id: job.data.videoId,
    });
    if (!video) {
      throw new UnrecoverableError(`Video ${job.data.videoId} not found`);
    }
    if (video.status === VideoStatus.READY) {
      return;
    }

    const sourcePath = join(tmpdir(), `video-source-${randomUUID()}`);
    let thumbnailPath: string | undefined;

    try {
      const sourceStream = await this.storageService.getObjectStream(
        video.storage_key,
      );
      await pipeline(sourceStream, createWriteStream(sourcePath));
      const probeResult = await this.ffmpegService.probe(sourcePath);
      thumbnailPath = await this.ffmpegService.extractThumbnail(
        sourcePath,
        probeResult.durationSeconds,
      );
      // Free disk space as soon as the source is no longer needed, instead of
      // waiting for the thumbnail upload + DB save to finish.
      await unlink(sourcePath).catch(() => undefined);

      const thumbnailBuffer = await readFile(thumbnailPath);
      const thumbnailKey = buildThumbnailStorageKey(video.channel_id, video.id);
      await this.storageService.putObject(
        thumbnailKey,
        thumbnailBuffer,
        THUMBNAIL_CONTENT_TYPE,
      );

      video.status = VideoStatus.READY;
      video.duration_seconds = Math.round(probeResult.durationSeconds);
      video.width = probeResult.width;
      video.height = probeResult.height;
      video.video_codec = probeResult.videoCodec;
      video.audio_codec = probeResult.audioCodec;
      video.thumbnail_key = thumbnailKey;
      video.failure_reason = null;
      await this.videoRepository.save(video);
    } catch (error) {
      if (error instanceof NoVideoStreamError) {
        await this.markFailed(video, error.message);
        throw new UnrecoverableError(error.message);
      }

      const attempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade + 1 >= attempts;
      if (isFinalAttempt) {
        await this.markFailed(
          video,
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    } finally {
      await unlink(sourcePath).catch(() => undefined);
      if (thumbnailPath) {
        await unlink(thumbnailPath).catch(() => undefined);
      }
    }
  }

  private async markFailed(video: Video, reason: string): Promise<void> {
    video.status = VideoStatus.FAILED;
    video.failure_reason = reason;
    await this.videoRepository.save(video);
  }
}
