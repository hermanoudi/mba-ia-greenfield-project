import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OptionalAuth } from '../auth/decorators/optional-auth.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { VideoDetailsResponseDto } from './dto/video-details-response.dto';
import { VideoUrlResponseDto } from './dto/video-url-response.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft, opens a multipart upload on the object storage and returns presigned URLs for each part.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated successfully',
    type: InitiateUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<InitiateUploadResponseDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':publicId/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Completes the multipart upload on the object storage, verifies the object, transitions the video from draft to processing and enqueues background processing.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed successfully',
    type: CompleteUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Authenticated user is not the owner of the video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in a draft state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'Uploaded object could not be verified in storage',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    return this.videosService.completeUpload(user.sub, publicId, dto);
  }

  @Get(':publicId')
  @OptionalAuth()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get video details',
    description:
      'Returns status and metadata for a video. Non-ready videos are only visible to the owning channel.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video details retrieved successfully',
    type: VideoDetailsResponseDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Non-ready video accessed by someone other than the owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getDetails(
    @CurrentUser() user: JwtPayload | undefined,
    @Param('publicId') publicId: string,
  ): Promise<VideoDetailsResponseDto> {
    return this.videosService.getDetails(publicId, user?.sub);
  }

  @Get(':publicId/playback-url')
  @Public()
  @ApiOperation({
    summary: 'Get a presigned streaming URL',
    description:
      'Returns a presigned GET URL for direct streaming from object storage. Only available once the video is ready.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned playback URL issued successfully',
    type: VideoUrlResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getPlaybackUrl(
    @Param('publicId') publicId: string,
  ): Promise<VideoUrlResponseDto> {
    return this.videosService.getPlaybackUrl(publicId);
  }

  @Get(':publicId/download-url')
  @Public()
  @ApiOperation({
    summary: 'Get a presigned download URL',
    description:
      'Returns a presigned GET URL forcing download (content-disposition: attachment) of the original file. Only available once the video is ready.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned download URL issued successfully',
    type: VideoUrlResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getDownloadUrl(
    @Param('publicId') publicId: string,
  ): Promise<VideoUrlResponseDto> {
    return this.videosService.getDownloadUrl(publicId);
  }
}
