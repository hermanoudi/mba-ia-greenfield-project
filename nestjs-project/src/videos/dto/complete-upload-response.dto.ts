import { ApiProperty } from '@nestjs/swagger';

export class CompleteUploadResponseDto {
  @ApiProperty()
  publicId: string;

  @ApiProperty({ example: 'processing' })
  status: string;
}
