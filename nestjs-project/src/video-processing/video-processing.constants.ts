export const VIDEO_PROCESSING_QUEUE = 'video-processing' as const;

export const VIDEO_PROCESSING_JOB_ATTEMPTS = 3;
export const VIDEO_PROCESSING_JOB_BACKOFF_DELAY_MS = 5000;

export const FFPROBE_TIMEOUT_MS = 30_000;
export const FFMPEG_THUMBNAIL_TIMEOUT_MS = 30_000;
export const THUMBNAIL_POSITION_RATIO = 0.1;
