import type { SceneScope } from './sceneManager';

/** Save a blob through the browser's download prompt. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking right away can cancel the download in some browsers; give it a moment.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * A hidden file input owned by a scene. `open` must be called from a user gesture (key or click
 * handler); chosen files go to `onFiles`.
 */
export function createFilePicker(
  scope: SceneScope,
  host: HTMLElement,
  onFiles: (files: File[], purpose: string) => void,
): { open(accept: string, purpose: string, multiple?: boolean): void } {
  const input = document.createElement('input');
  input.type = 'file';
  input.hidden = true;
  host.appendChild(input);
  scope.onDispose(() => input.remove());
  let purpose = '';
  scope.listen(input, 'change', () => {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length > 0) onFiles(files, purpose);
  });
  return {
    open(accept, nextPurpose, multiple = false) {
      purpose = nextPurpose;
      input.accept = accept;
      input.multiple = multiple;
      input.click();
    },
  };
}
