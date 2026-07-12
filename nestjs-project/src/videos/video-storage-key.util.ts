export function buildVideoStorageKey(channelId: string, videoId: string): string {
  return `videos/${channelId}/${videoId}/original`;
}

export function buildThumbnailStorageKey(channelId: string, videoId: string): string {
  return `thumbnails/${channelId}/${videoId}/thumb.jpg`;
}
