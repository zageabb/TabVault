// Mix source audio and an optional microphone into one recorded audio track.
// Local playback must use the ORIGINAL source stream, never this mixed stream.
globalThis.TabVaultAudio = {
  async prepare(sourceStream, enabled, deviceId = "") {
    if (!enabled) return { stream: sourceStream, microphone: false, async cleanup() {} };
    const constraints = { audio: { echoCancellation: true, noiseSuppression: true, ...(deviceId ? {deviceId: {exact: deviceId}} : {}) }, video: false };
    const micStream = await navigator.mediaDevices.getUserMedia(constraints);
    let context;
    try {
      context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      if (sourceStream.getAudioTracks().length) {
        context.createMediaStreamSource(sourceStream).connect(destination);
      }
      context.createMediaStreamSource(micStream).connect(destination);
      if (context.state === "suspended") await context.resume();
      const stream = new MediaStream([...sourceStream.getVideoTracks(), ...destination.stream.getAudioTracks()]);
      return {
        stream,
        microphone: true,
        async cleanup() {
          for (const track of micStream.getTracks()) track.stop();
          for (const track of destination.stream.getTracks()) track.stop();
          await context.close().catch(() => {});
        }
      };
    } catch (error) {
      for (const track of micStream.getTracks()) track.stop();
      if (context) await context.close().catch(() => {});
      throw error;
    }
  }
};
