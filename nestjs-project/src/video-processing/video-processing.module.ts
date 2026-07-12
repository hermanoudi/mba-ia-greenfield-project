import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import redisConfig from '../config/redis.config';
import {
  VIDEO_PROCESSING_JOB_ATTEMPTS,
  VIDEO_PROCESSING_JOB_BACKOFF_DELAY_MS,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';

@Module({
  imports: [
    ConfigModule,
    BullModule.forRootAsync({
      inject: [redisConfig.KEY],
      useFactory: (config: ConfigType<typeof redisConfig>) => ({
        connection: { host: config.host, port: config.port },
      }),
    }),
    BullModule.registerQueue({
      name: VIDEO_PROCESSING_QUEUE,
      defaultJobOptions: {
        attempts: VIDEO_PROCESSING_JOB_ATTEMPTS,
        backoff: {
          type: 'exponential',
          delay: VIDEO_PROCESSING_JOB_BACKOFF_DELAY_MS,
        },
      },
    }),
  ],
  exports: [BullModule],
})
export class VideoProcessingModule {}
