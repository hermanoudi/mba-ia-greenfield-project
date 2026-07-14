import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import redisConfig from '../config/redis.config';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingModule } from './video-processing.module';

describe('VideoProcessingModule', () => {
  it('should compile and register the video-processing queue', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [redisConfig] }),
        VideoProcessingModule,
      ],
    }).compile();

    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    expect(queue).toBeDefined();
    await module.close();
  }, 30000);
});
