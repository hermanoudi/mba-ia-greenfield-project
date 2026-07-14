import { Repository } from 'typeorm';
import { Video } from '../videos/entities/video.entity';
import { VideoStatus } from '../videos/entities/video-status.enum';

export async function markVideoFailed(
  videoRepository: Repository<Video>,
  video: Video,
  reason: string,
): Promise<void> {
  video.status = VideoStatus.FAILED;
  video.failure_reason = reason;
  await videoRepository.save(video);
}
