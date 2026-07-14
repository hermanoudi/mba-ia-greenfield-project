import { Test, TestingModule } from '@nestjs/testing';
import { existsSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { FFmpegService } from './ffmpeg.service';
import { NoVideoStreamError } from './ffmpeg.errors';

const FIXTURE_WITH_VIDEO = join(__dirname, 'fixtures', 'sample-with-video.mp4');
const FIXTURE_AUDIO_ONLY = join(__dirname, 'fixtures', 'sample-audio-only.mp3');

describe('FFmpegService (integration)', () => {
  let service: FFmpegService;
  let probeResult: Awaited<ReturnType<FFmpegService['probe']>>;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [FFmpegService],
    }).compile();

    service = module.get(FFmpegService);
    probeResult = await service.probe(FIXTURE_WITH_VIDEO);
  });

  describe('probe', () => {
    it('extracts duration, dimensions and codecs from a real video', () => {
      expect(probeResult.durationSeconds).toBeCloseTo(2, 0);
      expect(probeResult.width).toBe(320);
      expect(probeResult.height).toBe(240);
      expect(probeResult.videoCodec).toBe('h264');
      expect(probeResult.audioCodec).toBe('aac');
    });

    it('throws NoVideoStreamError for a file with no video stream', async () => {
      await expect(service.probe(FIXTURE_AUDIO_ONLY)).rejects.toThrow(
        NoVideoStreamError,
      );
    });
  });

  describe('extractThumbnail', () => {
    it('generates an image file from the frame at 10% of the duration', async () => {
      const outputPath = await service.extractThumbnail(
        FIXTURE_WITH_VIDEO,
        probeResult.durationSeconds,
      );

      try {
        expect(existsSync(outputPath)).toBe(true);
        expect(statSync(outputPath).size).toBeGreaterThan(0);
      } finally {
        unlinkSync(outputPath);
      }
    });
  });
});
