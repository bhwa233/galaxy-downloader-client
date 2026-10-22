// Adapted from nexmoe/VidBee ce82483 (MIT). See LICENSE in this directory.
export const SPEAKER_EMBEDDING_CAMPPLUS_ID = 'speaker-embedding-campplus'
export const SPEAKER_EMBEDDING_TITANET_ID = 'speaker-embedding-titanet'
export const SPEAKER_EMBEDDING_ERES2NET_ID = 'speaker-embedding'

export const CAMPPLUS_FILE = '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx'
export const CAMPPLUS_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx'

export const TITANET_FILE = 'nemo_en_titanet_small.onnx'
export const TITANET_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx'

export const ERES2NET_FILE = '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'
export const ERES2NET_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'

/**
 * Default speaker embedding for every locale.
 *
 * CAM++ zh-en advanced (~27MB) is trained on VoxCeleb + CNCeleb + 3D-Speaker
 * (~200k speakers). TitaNet Small and eres2net stay in the catalog as optional
 * on-disk fallbacks so already-downloaded files are not treated as errors.
 *
 * @param _language BCP-47 tag; kept so callers can pass UI language.
 */
export const embeddingIdForLanguage = (_language?: string | null): string =>
  SPEAKER_EMBEDDING_CAMPPLUS_ID
