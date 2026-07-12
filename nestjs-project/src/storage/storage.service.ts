import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';

const UPLOAD_PART_URL_EXPIRES_IN_SECONDS = 12 * 60 * 60;
const GET_OBJECT_URL_EXPIRES_IN_SECONDS = 60 * 60;

export interface CompletedUploadPart {
  partNumber: number;
  eTag: string;
}

export interface HeadObjectResult {
  sizeBytes: number;
}

export interface PresignGetObjectOptions {
  downloadFilename?: string;
}

@Injectable()
export class StorageService {
  private readonly client: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.client = new S3Client({
      endpoint: this.config.endpoint,
      region: this.config.region,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
      forcePathStyle: true,
    });
  }

  async createMultipartUpload(key: string): Promise<string> {
    const command = new CreateMultipartUploadCommand({
      Bucket: this.config.bucket,
      Key: key,
    });
    const { UploadId } = await this.client.send(command);
    if (!UploadId) {
      throw new Error('S3 did not return an UploadId for CreateMultipartUpload');
    }
    return UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    const command = new UploadPartCommand({
      Bucket: this.config.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });
    return getSignedUrl(this.client, command, {
      expiresIn: UPLOAD_PART_URL_EXPIRES_IN_SECONDS,
    });
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedUploadPart[],
  ): Promise<void> {
    const command = new CompleteMultipartUploadCommand({
      Bucket: this.config.bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts.map((part) => ({
          PartNumber: part.partNumber,
          ETag: part.eTag,
        })),
      },
    });
    await this.client.send(command);
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const command = new AbortMultipartUploadCommand({
      Bucket: this.config.bucket,
      Key: key,
      UploadId: uploadId,
    });
    await this.client.send(command);
  }

  async headObject(key: string): Promise<HeadObjectResult | null> {
    try {
      const { ContentLength } = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return { sizeBytes: ContentLength ?? 0 };
    } catch (error) {
      if (error instanceof NotFound) {
        return null;
      }
      throw error;
    }
  }

  async presignGetObject(
    key: string,
    options?: PresignGetObjectOptions,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      ResponseContentDisposition: options?.downloadFilename
        ? `attachment; filename="${options.downloadFilename}"`
        : undefined,
    });
    return getSignedUrl(this.client, command, {
      expiresIn: GET_OBJECT_URL_EXPIRES_IN_SECONDS,
    });
  }
}
