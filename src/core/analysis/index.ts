/**
 * Audio analysis shared by the chart generator (Phase 13) and, later, animated backgrounds
 * (Phase 15). Pure: no DOM, no Web Audio. Run it in a worker (`analyzeAudioSteps` yields
 * progress) and cache the result per song.
 */
export { analyzeAudio, analyzeAudioSteps, smoothingBeatMs } from './analyze';
export { pearson, quantile } from './curves';
export {
  ANALYSIS_VERSION,
  FEATURE_FRAME_MS,
  analysisBuffers,
  frameAt,
  frameTime,
  meanOver,
  valueAt,
  type AnalysisOnset,
  type AudioAnalysis,
  type Bands,
  type BuildUp,
  type Impact,
  type Silence,
} from './types';
