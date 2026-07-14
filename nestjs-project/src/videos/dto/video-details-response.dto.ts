import { ApiProperty } from '@nestjs/swagger';

const NULLABLE_NUMBER = { nullable: true, type: Number } as const;

export class VideoDetailsResponseDto {
  @ApiProperty()
  publicId: string;

  @ApiProperty({ nullable: true, type: String })
  title: string | null;

  @ApiProperty({ example: 'ready' })
  status: string;

  @ApiProperty(NULLABLE_NUMBER)
  durationSeconds: number | null;

  @ApiProperty(NULLABLE_NUMBER)
  width: number | null;

  @ApiProperty(NULLABLE_NUMBER)
  height: number | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Presigned GET URL for the thumbnail, present only when status is ready',
  })
  thumbnailUrl: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Present only when status is failed',
  })
  failureReason: string | null;

  @ApiProperty()
  createdAt: string;
}
