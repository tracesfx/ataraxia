// Types for reference.mjs, so TypeScript tests can use it.

export interface ReferenceFiles {
  audio: string;
  chart: string;
}

export function findReference(dir: string): ReferenceFiles | null;

export function decodeMp3Mono(path: string): Promise<{ samples: Float32Array; sampleRate: number }>;

export function readJson(path: string): unknown;
