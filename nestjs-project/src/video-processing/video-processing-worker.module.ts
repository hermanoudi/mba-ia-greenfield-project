import { Module, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { StorageModule } from '../storage/storage.module';
import { Video } from '../videos/entities/video.entity';
import { StaleUploadsProcessor } from './stale-uploads.processor';
import { VideoProcessingModule } from './video-processing.module';
import { VideoProcessingProcessor } from './video-processing.processor';
import {
  STALE_UPLOADS_JOB_NAME,
  STALE_UPLOADS_SCAN_INTERVAL_MS,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';

@Module({
  imports: [
    VideoProcessingModule,
    TypeOrmModule.forFeature([Video]),
    StorageModule,
  ],
  providers: [VideoProcessingProcessor, StaleUploadsProcessor],
})
export class VideoProcessingWorkerModule implements OnModuleInit {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      STALE_UPLOADS_JOB_NAME,
      { every: STALE_UPLOADS_SCAN_INTERVAL_MS },
      { name: STALE_UPLOADS_JOB_NAME },
    );
  }
}
