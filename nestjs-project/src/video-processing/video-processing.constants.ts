export const VIDEO_PROCESSING_QUEUE = 'video-processing' as const;

export const VIDEO_PROCESSING_JOB_ATTEMPTS = 3;
export const VIDEO_PROCESSING_JOB_BACKOFF_DELAY_MS = 5000;

export const FFPROBE_TIMEOUT_MS = 30_000;
export const FFMPEG_THUMBNAIL_TIMEOUT_MS = 30_000;
export const THUMBNAIL_POSITION_RATIO = 0.1;

export const STALE_UPLOADS_JOB_NAME = 'video.reconcile-stale-uploads' as const;
export const STALE_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
export const STALE_UPLOADS_SCAN_INTERVAL_MS = 60 * 60 * 1000;
