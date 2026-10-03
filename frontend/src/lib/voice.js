/**
 * Shop-floor mic: browser noise suppression plus a speech-band filter.
 * A duka is rarely quiet — we keep voice and drop rumble, hiss, and echo
 * before the clip goes to Gemini.
 */

export function pickAudioMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const types = ['audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

export function audioFileName(mime) {
  if (String(mime).includes('ogg')) return 'voice_note.ogg';
  if (String(mime).includes('mp4')) return 'voice_note.m4a';
  return 'voice_note.webm';
}

async function applyNoiseConstraints(track) {
  if (!track?.applyConstraints) return;
  try {
    await track.applyConstraints({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    });
  } catch {
    // Safari / Firefox / older Android may ignore one of these.
  }
}

function buildSpeechFilter(context, incoming) {
  const source = context.createMediaStreamSource(incoming);
  const highpass = context.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 120;
  highpass.Q.value = 0.7;

  const lowpass = context.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 3800;
  lowpass.Q.value = 0.7;

  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -28;
  compressor.knee.value = 18;
  compressor.ratio.value = 6;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.18;

  const destination = context.createMediaStreamDestination();
  source.connect(highpass);
  highpass.connect(lowpass);
  lowpass.connect(compressor);
  compressor.connect(destination);
  return destination.stream;
}

/**
 * @returns {Promise<{ recordStream: MediaStream, stop: () => void }>}
 */
export async function openShopMic() {
  const rawStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: true }
    },
    video: false
  });

  const track = rawStream.getAudioTracks()[0];
  await applyNoiseConstraints(track);

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let context = null;
  let recordStream = rawStream;

  if (AudioCtx) {
    try {
      context = new AudioCtx();
      if (context.state === 'suspended') await context.resume();
      recordStream = buildSpeechFilter(context, rawStream);
    } catch {
      context = null;
      recordStream = rawStream;
    }
  }

  return {
    recordStream,
    stop() {
      rawStream.getTracks().forEach((item) => item.stop());
      if (recordStream !== rawStream) {
        recordStream.getTracks().forEach((item) => item.stop());
      }
      if (context && context.state !== 'closed') {
        context.close().catch(() => {});
      }
    }
  };
}
