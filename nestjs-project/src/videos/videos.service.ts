import { randomUUID } from 'crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import {
  ForbiddenVideoAccessException,
  InvalidUploadStateException,
  UploadVerificationFailedException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { isPgUniqueViolationOnColumn } from '../common/typeorm/pg-unique-violation.util';
import { StorageService } from '../storage/storage.service';
import { VIDEO_PROCESSING_QUEUE } from '../video-processing/video-processing.constants';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
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
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoProcessingQueue: Queue,
  ) {}

  async initiateUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<InitiateUploadResponseDto> {
    const [channel, publicId] = await Promise.all([
      this.getOwnedChannel(userId),
      generateUniquePublicId((candidate) =>
        this.videoRepository.exists({ where: { public_id: candidate } }),
      ),
    ]);

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

  async completeUpload(
    userId: string,
    publicId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    const video = await this.findOwnedVideoOrThrow(userId, publicId);

    if (video.status !== VideoStatus.DRAFT) {
      throw new InvalidUploadStateException();
    }
    if (!video.upload_id) {
      throw new Error(
        `Video ${video.id} is in draft status but has no upload_id`,
      );
    }

    await this.storageService.completeMultipartUpload(
      video.storage_key,
      video.upload_id,
      dto.parts.map((part) => ({
        partNumber: part.partNumber,
        eTag: part.etag,
      })),
    );

    const head = await this.storageService.headObject(video.storage_key);
    const expectedSizeBytes =
      video.size_bytes !== null ? Number(video.size_bytes) : null;
    if (
      !head ||
      (expectedSizeBytes !== null && head.sizeBytes !== expectedSizeBytes)
    ) {
      throw new UploadVerificationFailedException();
    }

    video.status = VideoStatus.PROCESSING;
    video.upload_id = null;
    await this.videoRepository.save(video);

    await this.videoProcessingQueue.add('video.process', {
      videoId: video.id,
    });

    return { publicId: video.public_id, status: video.status };
  }

  private async findOwnedVideoOrThrow(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const [channel, video] = await Promise.all([
      this.getOwnedChannel(userId),
      this.videoRepository.findOneBy({ public_id: publicId }),
    ]);

    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel_id !== channel.id) {
      throw new ForbiddenVideoAccessException();
    }

    return video;
  }

  private async getOwnedChannel(userId: string): Promise<Channel> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`No channel found for authenticated user ${userId}`);
    }
    return channel;
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
