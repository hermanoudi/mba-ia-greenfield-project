import { ApiProperty } from '@nestjs/swagger';

export class VideoUrlResponseDto {
  @ApiProperty({ description: 'Presigned GET URL' })
  url: string;

  @ApiProperty({ example: 3600, description: 'Expiration time in seconds' })
  expiresIn: number;
}
