export async function requestDisplayStream<T>(
  request: (includeSystemAudio: boolean) => Promise<T>,
  includeSystemAudio: boolean,
): Promise<{ stream: T; systemAudioIncluded: boolean }> {
  try {
    return { stream: await request(includeSystemAudio), systemAudioIncluded: includeSystemAudio };
  } catch (error) {
    if (!includeSystemAudio) throw error;
    try {
      return { stream: await request(false), systemAudioIncluded: false };
    } catch (fallbackError) {
      const message = fallbackError instanceof Error ? fallbackError.message : "Unknown system error";
      throw new Error(`Screen capture was denied even without system audio: ${message}`, { cause: fallbackError });
    }
  }
}
