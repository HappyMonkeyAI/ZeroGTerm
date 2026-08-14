// Microphone capture for voice input. Records a full utterance with
// MediaRecorder, then decodes and resamples it to the mono 16 kHz Float32
// input Whisper expects.

export const WHISPER_SAMPLE_RATE = 16000;
// Hard cap so a stuck-open mic cannot queue an unbounded transcription.
export const MAX_UTTERANCE_SECONDS = 30;
// Gate for dead-air recordings; RMS below this skips the model entirely.
export const SILENCE_RMS_THRESHOLD = 0.004;
const RECORDER_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

export function rootMeanSquare(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

/**
 * Is this recording dead air?
 *
 * The threshold is a setting because the right value depends on the
 * microphone: a quiet headset gets its speech discarded at a level a noisy
 * desk mic needs to reject room hum. SILENCE_RMS_THRESHOLD is the default.
 */
export function isMostlySilence(samples: Float32Array, threshold: number = SILENCE_RMS_THRESHOLD): boolean {
  return rootMeanSquare(samples) < threshold;
}

export async function decodeToWhisperInput(blob: Blob): Promise<Float32Array> {
  const decodeContext = new AudioContext();
  try {
    const decoded = await decodeContext.decodeAudioData(await blob.arrayBuffer());
    const length = Math.max(1, Math.ceil(decoded.duration * WHISPER_SAMPLE_RATE));
    const offline = new OfflineAudioContext(1, length, WHISPER_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  } finally {
    void decodeContext.close();
  }
}

export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = RECORDER_MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate));
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = (event) => {
      if (event.data.size) this.chunks.push(event.data);
    };
    this.recorder.start();
  }

  stop(): Promise<Float32Array | null> {
    return new Promise((resolve) => {
      const recorder = this.recorder;
      if (!recorder || recorder.state === 'inactive') {
        this.dispose();
        resolve(null);
        return;
      }
      recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' });
        this.dispose();
        if (!blob.size) {
          resolve(null);
          return;
        }
        decodeToWhisperInput(blob).then(resolve, () => resolve(null));
      };
      recorder.stop();
    });
  }

  cancel(): void {
    const recorder = this.recorder;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null;
      recorder.stop();
    }
    this.dispose();
  }

  private dispose(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}
