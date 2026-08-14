// The speech recognition models offered in settings, and the facts about them
// the UI needs to describe an honest choice: how much has to be downloaded,
// and whether the model can handle a language other than English.
//
// The catalogue is curated rather than free-text. A model only runs in the
// built-in engine if Transformers.js can load its architecture from an ONNX
// export laid out the way it expects, so an arbitrary hub id — a GGUF build,
// or an ONNX export for a different runtime — fails at first transcription
// with an opaque error. Models that need another runtime are reachable through
// the local-server engine instead; see speech-server.ts.

/** ONNX weight precision. Transformers.js calls this `dtype`. */
export type SpeechPrecision = 'q4' | 'q8' | 'fp16' | 'fp32';

export type SpeechTask = 'transcribe' | 'translate';

export type SpeechModel = {
  /** Hugging Face hub id passed to the transformers pipeline. */
  id: string;
  label: string;
  /** Whisper size class, shown as a hint about speed. */
  family: 'tiny' | 'base' | 'small';
  /** English-only models reject the `language` and `task` options. */
  multilingual: boolean;
  /**
   * Approximate megabytes fetched on first use per precision: the encoder plus
   * the merged decoder, which is what the pipeline actually downloads. Measured
   * from the hub file listing rather than guessed, because the number decides
   * whether a user picks a model at all.
   */
  downloadMb: Record<SpeechPrecision, number>;
};

const TINY_SIZES: Record<SpeechPrecision, number> = { q4: 96, q8: 41, fp16: 76, fp32: 152 };
const BASE_SIZES: Record<SpeechPrecision, number> = { q4: 142, q8: 77, fp16: 146, fp32: 291 };
const SMALL_SIZES: Record<SpeechPrecision, number> = { q4: 299, q8: 249, fp16: 485, fp32: 968 };

/**
 * Every id here was checked against the hub API, and every one exposes the
 * quantized, q4, fp16 and fp32 ONNX variants the precision setting selects.
 */
export const SPEECH_MODELS: SpeechModel[] = [
  {
    id: 'onnx-community/whisper-tiny.en',
    label: 'Whisper tiny · English',
    family: 'tiny',
    multilingual: false,
    downloadMb: TINY_SIZES
  },
  {
    id: 'onnx-community/whisper-base.en',
    label: 'Whisper base · English',
    family: 'base',
    multilingual: false,
    downloadMb: BASE_SIZES
  },
  {
    id: 'onnx-community/whisper-small.en',
    label: 'Whisper small · English',
    family: 'small',
    multilingual: false,
    downloadMb: SMALL_SIZES
  },
  {
    id: 'onnx-community/whisper-tiny',
    label: 'Whisper tiny · multilingual',
    family: 'tiny',
    multilingual: true,
    downloadMb: TINY_SIZES
  },
  {
    id: 'onnx-community/whisper-base',
    label: 'Whisper base · multilingual',
    family: 'base',
    multilingual: true,
    downloadMb: BASE_SIZES
  },
  {
    id: 'onnx-community/whisper-small',
    label: 'Whisper small · multilingual',
    family: 'small',
    multilingual: true,
    downloadMb: SMALL_SIZES
  }
];

/** The model used when nothing is stored — what the app shipped with. */
export const DEFAULT_SPEECH_MODEL = 'onnx-community/whisper-tiny.en';

export const SPEECH_PRECISIONS: Array<{ value: SpeechPrecision; label: string; detail: string }> = [
  { value: 'q8', label: 'q8 · quantized', detail: 'Smallest download, fastest on CPU' },
  { value: 'q4', label: 'q4', detail: 'Smaller weights, some accuracy loss' },
  { value: 'fp16', label: 'fp16', detail: 'Half precision; needs WebGPU to pay off' },
  { value: 'fp32', label: 'fp32 · full', detail: 'Most accurate, largest download' }
];

/**
 * Languages offered when a multilingual model is selected.
 *
 * Whisper accepts far more than this; the list is the common set kept short
 * enough to scan, with 'auto' letting the model detect the language itself.
 */
export const SPEECH_LANGUAGES: Array<{ value: string; label: string }> = [
  { value: 'auto', label: 'Detect automatically' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'nl', label: 'Dutch' },
  { value: 'pl', label: 'Polish' },
  { value: 'sv', label: 'Swedish' },
  { value: 'da', label: 'Danish' },
  { value: 'no', label: 'Norwegian' },
  { value: 'fi', label: 'Finnish' },
  { value: 'cs', label: 'Czech' },
  { value: 'el', label: 'Greek' },
  { value: 'tr', label: 'Turkish' },
  { value: 'ru', label: 'Russian' },
  { value: 'uk', label: 'Ukrainian' },
  { value: 'he', label: 'Hebrew' },
  { value: 'ar', label: 'Arabic' },
  { value: 'hi', label: 'Hindi' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'id', label: 'Indonesian' },
  { value: 'th', label: 'Thai' },
  { value: 'vi', label: 'Vietnamese' }
];

export function findSpeechModel(id: string): SpeechModel | undefined {
  return SPEECH_MODELS.find((model) => model.id === id);
}

/**
 * Can this model be told a language and a task?
 *
 * Unknown ids are treated as English-only: passing `language` to a `.en`
 * checkpoint throws ("Cannot specify `task` or `language` for an
 * English-only model"), so the safe default is to send neither.
 */
export function supportsLanguageSelection(id: string): boolean {
  return findSpeechModel(id)?.multilingual ?? false;
}

/** Approximate first-use download for a model and precision, in megabytes. */
export function downloadSizeMb(id: string, precision: SpeechPrecision): number | null {
  return findSpeechModel(id)?.downloadMb[precision] ?? null;
}

/** "≈41 MB download" — the phrase the settings page shows under the picker. */
export function describeDownload(id: string, precision: SpeechPrecision): string {
  const size = downloadSizeMb(id, precision);
  return size === null ? 'Download size unknown' : `≈${size} MB download, cached after first use`;
}
