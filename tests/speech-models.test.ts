import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPEECH_MODEL,
  SPEECH_LANGUAGES,
  SPEECH_MODELS,
  SPEECH_PRECISIONS,
  describeDownload,
  downloadSizeMb,
  findSpeechModel,
  supportsLanguageSelection
} from '../src/renderer/speech-models';

describe('the speech model catalogue', () => {
  it('offers a size per precision for every model', () => {
    for (const model of SPEECH_MODELS) {
      for (const precision of SPEECH_PRECISIONS) {
        expect(model.downloadMb[precision.value], `${model.id} ${precision.value}`).toBeGreaterThan(0);
      }
    }
  });

  it('has unique ids and includes the shipped default', () => {
    const ids = SPEECH_MODELS.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_SPEECH_MODEL);
  });

  it('marks .en checkpoints as English-only', () => {
    // The distinction is not cosmetic: whisper throws if a language is passed
    // to an English-only model.
    for (const model of SPEECH_MODELS) {
      expect(model.multilingual).toBe(!model.id.endsWith('.en'));
    }
  });

  it('grows with model size at a fixed precision', () => {
    const size = (id: string) => downloadSizeMb(id, 'q8')!;
    expect(size('onnx-community/whisper-tiny.en')).toBeLessThan(size('onnx-community/whisper-base.en'));
    expect(size('onnx-community/whisper-base.en')).toBeLessThan(size('onnx-community/whisper-small.en'));
  });

  it('offers a language list led by automatic detection', () => {
    expect(SPEECH_LANGUAGES[0].value).toBe('auto');
    const codes = SPEECH_LANGUAGES.map((entry) => entry.value);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain('en');
  });
});

describe('supportsLanguageSelection', () => {
  it('answers from the catalogue', () => {
    expect(supportsLanguageSelection('onnx-community/whisper-small')).toBe(true);
    expect(supportsLanguageSelection('onnx-community/whisper-small.en')).toBe(false);
  });

  it('treats an unknown id as English-only, the safe default', () => {
    expect(supportsLanguageSelection('who/knows')).toBe(false);
  });
});

describe('describeDownload', () => {
  it('names the size for a known model and precision', () => {
    expect(describeDownload('onnx-community/whisper-tiny.en', 'q8')).toContain('41 MB');
    expect(describeDownload('onnx-community/whisper-small', 'fp32')).toContain('968 MB');
  });

  it('says so when the size is unknown', () => {
    expect(describeDownload('who/knows', 'q8')).toBe('Download size unknown');
    expect(downloadSizeMb('who/knows', 'q8')).toBeNull();
    expect(findSpeechModel('who/knows')).toBeUndefined();
  });
});
