import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';
import { VideoStatus } from '../videos/entities/video-status.enum';
import { markVideoFailed } from './mark-video-failed.util';
import { STALE_UPLOAD_TTL_MS } from './video-processing.constants';

const STALE_UPLOAD_FAILURE_REASON =
  'Stale upload: draft exceeded the 24h completion TTL';

@Injectable()
export class StaleUploadsProcessor {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {}

  async reconcile(): Promise<void> {
    const staleBefore = new Date(Date.now() - STALE_UPLOAD_TTL_MS);
    const staleDrafts = await this.videoRepository.findBy({
      status: VideoStatus.DRAFT,
      created_at: LessThan(staleBefore),
    });

    for (const video of staleDrafts) {
      if (video.upload_id) {
        await this.storageService.abortMultipartUpload(
          video.storage_key,
          video.upload_id,
        );
      }
      await markVideoFailed(
        this.videoRepository,
        video,
        STALE_UPLOAD_FAILURE_REASON,
      );
    }
  }
}
