import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../storage/storage.module';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingModule } from './video-processing.module';
import { VideoProcessingProcessor } from './video-processing.processor';

@Module({
  imports: [
    VideoProcessingModule,
    TypeOrmModule.forFeature([Video]),
    StorageModule,
  ],
  providers: [VideoProcessingProcessor],
})
export class VideoProcessingWorkerModule {}
