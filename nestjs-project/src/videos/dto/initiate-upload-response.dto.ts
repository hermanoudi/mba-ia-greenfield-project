import { ApiProperty } from '@nestjs/swagger';

export class InitiateUploadPartDto {
  @ApiProperty()
  partNumber: number;

  @ApiProperty()
  url: string;
}

export class InitiateUploadResponseDto {
  @ApiProperty({ description: '11-char URL-safe video identifier' })
  publicId: string;

  @ApiProperty({ description: 'S3 multipart UploadId' })
  uploadId: string;

  @ApiProperty({ description: 'Object storage key of the original file' })
  key: string;

  @ApiProperty({ example: 52428800 })
  partSize: number;

  @ApiProperty({ type: [InitiateUploadPartDto] })
  parts: InitiateUploadPartDto[];
}
