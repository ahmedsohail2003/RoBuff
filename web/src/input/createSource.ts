import type { InputSource } from './handState';
import { MouseSource } from './mouseSource';
import type { PickPlan } from './pickScript';
import { SyntheticSource } from './syntheticSource';
import { WebcamSource } from './webcamSource';

/** The kinds a page can start with; voice only ever takes over from one of these. */
export type InputKind = Exclude<InputSource['kind'], 'voice'>;

/** ?input=webcam|synthetic|mouse. Anything else, or nothing, means mouse. */
export function inputKindFromUrl(search: string): InputKind {
  const value = new URLSearchParams(search).get('input');
  return value === 'webcam' || value === 'synthetic' ? value : 'mouse';
}

export function createInputSource(kind: InputKind, element: HTMLElement, plan: () => PickPlan): InputSource {
  switch (kind) {
    case 'synthetic':
      return new SyntheticSource(plan);
    case 'webcam':
      // The caller starts it, so it can report a denied or missing camera.
      return new WebcamSource();
    case 'mouse':
      return new MouseSource(element);
  }
}
