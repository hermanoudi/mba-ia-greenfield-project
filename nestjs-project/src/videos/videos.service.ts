import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isPgUniqueViolationOnColumn } from '../common/typeorm/pg-unique-violation.util';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import {
  InitiateUploadPartDto,
  InitiateUploadResponseDto,
} from './dto/initiate-upload-response.dto';
import { Video } from './entities/video.entity';
import { VideoStatus } from './entities/video-status.enum';
import { generateUniquePublicId } from './public-id.util';
import { buildVideoStorageKey } from './video-storage-key.util';
import { VIDEO_UPLOAD_PART_SIZE_BYTES } from './videos.constants';

const PUBLIC_ID_COLUMN = 'public_id';
const MAX_PUBLIC_ID_RETRIES = 5;

interface DraftToSave {
  videoId: string;
  publicId: string;
  channelId: string;
  storageKey: string;
  uploadId: string;
  dto: CreateVideoDto;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
  ) {}

  async initiateUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<InitiateUploadResponseDto> {
    const [channel, publicId] = await Promise.all([
      this.channelsService.findByUserId(userId),
      generateUniquePublicId((candidate) =>
        this.videoRepository.exists({ where: { public_id: candidate } }),
      ),
    ]);
    if (!channel) {
      throw new Error(`No channel found for authenticated user ${userId}`);
    }

    // Postgres accepts a client-supplied uuid on insert instead of invoking the column's
    // default generator — pre-generating lets storage_key be computed before the first write.
    const videoId = randomUUID();
    const storageKey = buildVideoStorageKey(channel.id, videoId);
    const uploadId =
      await this.storageService.createMultipartUpload(storageKey);

    const savedPublicId = await this.saveDraft({
      videoId,
      publicId,
      channelId: channel.id,
      storageKey,
      uploadId,
      dto,
    });

    const partCount = Math.ceil(dto.sizeBytes / VIDEO_UPLOAD_PART_SIZE_BYTES);
    const parts = await Promise.all(
      Array.from({ length: partCount }, (_, index) => index + 1).map(
        async (partNumber): Promise<InitiateUploadPartDto> => ({
          partNumber,
          url: await this.storageService.presignUploadPart(
            storageKey,
            uploadId,
            partNumber,
          ),
        }),
      ),
    );

    return {
      publicId: savedPublicId,
      uploadId,
      key: storageKey,
      partSize: VIDEO_UPLOAD_PART_SIZE_BYTES,
      parts,
    };
  }

  /** Returns the public_id that was actually persisted (may differ from `draft.publicId` after a retry). */
  private async saveDraft(draft: DraftToSave, attempt = 0): Promise<string> {
    try {
      await this.videoRepository.save(
        this.videoRepository.create({
          id: draft.videoId,
          public_id: draft.publicId,
          channel_id: draft.channelId,
          title: draft.dto.title ?? null,
          status: VideoStatus.DRAFT,
          storage_key: draft.storageKey,
          upload_id: draft.uploadId,
          size_bytes: String(draft.dto.sizeBytes),
        }),
      );
      return draft.publicId;
    } catch (err) {
      if (
        isPgUniqueViolationOnColumn(err, PUBLIC_ID_COLUMN) &&
        attempt < MAX_PUBLIC_ID_RETRIES
      ) {
        // Concurrent insert between the exists() pre-check and this save — retry with a fresh id
        const retryPublicId = await generateUniquePublicId((candidate) =>
          this.videoRepository.exists({ where: { public_id: candidate } }),
        );
        return this.saveDraft(
          { ...draft, publicId: retryPublicId },
          attempt + 1,
        );
      }
      throw err;
    }
  }
}
