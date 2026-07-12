import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  Max,
} from 'class-validator';
import { MAX_VIDEO_SIZE_BYTES } from '../videos.constants';

export class CreateVideoDto {
  /** Initial title of the draft */
  @IsOptional()
  @IsString()
  title?: string;

  /** Original file name */
  @IsString()
  @IsNotEmpty()
  filename: string;

  /** Total file size in bytes, used to calculate the multipart part count */
  @IsInt()
  @IsPositive()
  @Max(MAX_VIDEO_SIZE_BYTES)
  sizeBytes: number;

  /** MIME type informed by the client (authoritative validation happens via ffprobe in the worker) */
  @IsString()
  @IsNotEmpty()
  contentType: string;
}
