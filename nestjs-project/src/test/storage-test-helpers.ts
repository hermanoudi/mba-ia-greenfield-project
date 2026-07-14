export async function putContentAndGetEtag(
  url: string,
  content: Buffer,
): Promise<string> {
  const response = await fetch(url, {
    method: 'PUT',
    body: new Uint8Array(content),
  });
  return response.headers.get('etag')!;
}
