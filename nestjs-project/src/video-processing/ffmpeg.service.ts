import { Injectable } from '@nestjs/common';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { FFmpegExecutionError, NoVideoStreamError } from './ffmpeg.errors';
import {
  FFMPEG_THUMBNAIL_TIMEOUT_MS,
  FFPROBE_TIMEOUT_MS,
  THUMBNAIL_POSITION_RATIO,
} from './video-processing.constants';

export interface VideoProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string | null;
}

interface FFprobeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
}

interface FFprobeOutput {
  format?: { duration?: string };
  streams?: FFprobeStream[];
}

@Injectable()
export class FFmpegService {
  async probe(path: string): Promise<VideoProbeResult> {
    const { stdout, stderr } = await this.run(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_format',
        '-show_streams',
        '-print_format',
        'json',
        path,
      ],
      FFPROBE_TIMEOUT_MS,
    );

    let parsed: FFprobeOutput;
    try {
      parsed = JSON.parse(stdout) as FFprobeOutput;
    } catch {
      throw new FFmpegExecutionError(
        `ffprobe returned invalid JSON output for ${path}`,
        stderr,
      );
    }

    const videoStream = parsed.streams?.find(
      (stream) => stream.codec_type === 'video',
    );
    if (!videoStream) {
      throw new NoVideoStreamError(`No video stream found in ${path}`);
    }

    const durationSeconds = Number(parsed.format?.duration);
    if (!Number.isFinite(durationSeconds)) {
      throw new FFmpegExecutionError(
        `ffprobe did not return a valid duration for ${path}`,
        stderr,
      );
    }

    const audioStream = parsed.streams?.find(
      (stream) => stream.codec_type === 'audio',
    );

    return {
      durationSeconds,
      width: videoStream.width ?? 0,
      height: videoStream.height ?? 0,
      videoCodec: videoStream.codec_name,
      audioCodec: audioStream?.codec_name ?? null,
    };
  }

  async extractThumbnail(
    path: string,
    durationSeconds: number,
  ): Promise<string> {
    const timestampSeconds = durationSeconds * THUMBNAIL_POSITION_RATIO;
    const outputPath = join(tmpdir(), `thumbnail-${randomUUID()}.jpg`);

    await this.run(
      'ffmpeg',
      [
        '-y',
        '-ss',
        timestampSeconds.toFixed(3),
        '-i',
        path,
        '-frames:v',
        '1',
        outputPath,
      ],
      FFMPEG_THUMBNAIL_TIMEOUT_MS,
    );

    return outputPath;
  }

  private run(
    command: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args);
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(
          new FFmpegExecutionError(
            `Failed to spawn ${command}: ${err.message}`,
            stderr,
          ),
        );
      });

      child.on('close', (code) => {
        clearTimeout(timer);

        if (timedOut) {
          reject(
            new FFmpegExecutionError(
              `${command} timed out after ${timeoutMs}ms`,
              stderr,
            ),
          );
          return;
        }

        if (code !== 0) {
          reject(
            new FFmpegExecutionError(
              `${command} exited with code ${code}`,
              stderr,
            ),
          );
          return;
        }

        resolve({ stdout, stderr });
      });
    });
  }
}
