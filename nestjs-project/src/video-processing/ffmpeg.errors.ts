export class FFmpegExecutionError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'FFmpegExecutionError';
  }
}

export class NoVideoStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoVideoStreamError';
  }
}
