import { describe, expect, it } from 'vitest';
import { WHISPER_SAMPLE_RATE, isMostlySilence, rootMeanSquare } from '../src/renderer/voice';

describe('voice helpers', () => {
  it('computes root mean square of a sample buffer', () => {
    expect(rootMeanSquare(new Float32Array([]))).toBe(0);
    expect(rootMeanSquare(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rootMeanSquare(new Float32Array([0.6, 0.8]))).toBeCloseTo(Math.sqrt(0.5));
  });

  it('treats dead air as silence', () => {
    expect(isMostlySilence(new Float32Array(WHISPER_SAMPLE_RATE))).toBe(true);
    expect(isMostlySilence(new Float32Array(WHISPER_SAMPLE_RATE).fill(0.0005))).toBe(true);
  });

  it('treats audible speech levels as not silence', () => {
    const tone = new Float32Array(WHISPER_SAMPLE_RATE).map(
      (_, index) => Math.sin((2 * Math.PI * 440 * index) / WHISPER_SAMPLE_RATE) * 0.3
    );
    expect(isMostlySilence(tone)).toBe(false);
  });
});
