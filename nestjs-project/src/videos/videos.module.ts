import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VideoProcessingModule } from '../video-processing/video-processing.module';
import { Video } from './entities/video.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Video]), VideoProcessingModule],
  exports: [TypeOrmModule],
})
export class VideosModule {}
