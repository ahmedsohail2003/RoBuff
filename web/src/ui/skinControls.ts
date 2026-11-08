// The skin box under the object receipt: describe a look or pick a chip, choose all parts or one,
// paint, upload your own picture, or remove the skin. Paint only: the hulls, mass and friction
// of the object never change, and the status line says so. Nano Banana draws the skin when the
// key server has it; otherwise a procedural skin is drawn in the browser. The badge is read from
// the skins on the object's parts, so a procedural fallback is never shown as live.

import type { Receipt } from '../objects/receipt';
import { RECIPE_WORDS, recipeFor } from '../objects/skinPattern';
import { displayName, matchParts, singular } from '../objects/skinUv';
import type { SlotRenderer } from '../render/objectMesh';
import type { SkinImage } from '../render/objectSkin';
import { duration, skinBadge } from '../render/skinBadge';
import { modelName, type SkinBrain, type SkinQuality } from '../render/skinSource';

export interface SkinPreset {
  id: string;
  label: string;
  /** What Nano Banana is asked for when live; the procedural recipe reads the same words offline. */
  text: string;
}

export const SKIN_PRESETS: readonly SkinPreset[] = [
  { id: 'gold', label: 'Gold', text: 'polished gold' },
  { id: 'chrome', label: 'Chrome', text: 'mirror chrome' },
  { id: 'carbon', label: 'Carbon fibre', text: 'woven carbon fibre' },
  { id: 'camo', label: 'Camo', text: 'woodland camouflage' },
  { id: 'wood', label: 'Wood', text: 'oak wood grain' },
  { id: 'galaxy', label: 'Galaxy', text: 'a swirling purple galaxy nebula with stars' },
  { id: 'lava', label: 'Lava', text: 'glowing lava cracks' },
];

const PAINT_ONLY = 'Paint only: mass, friction and hulls did not change.';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** "all 6 parts", "the front left wheel", "the 4 wheels", "the cylinder". */
function whereText(names: readonly string[], parts: readonly number[]): string {
  if (names.length === 1) return `the ${names[0]}`;
  if (parts.length === names.length) return `all ${names.length} parts`;
  if (parts.length === 1) return `the ${names[parts[0]!]}`;
  const lasts = parts.map((p) => singular(names[p]!.split(' ').pop()!));
  if (lasts.every((w) => w === lasts[0])) return `the ${parts.length} ${lasts[0]}s`;
  return `${parts.length} parts (${parts.map((p) => names[p]).join(', ')})`;
}

export interface SkinRequest {
  text: string;
  /** A part name or phrase ('wheels'); null or 'all' paints every part. */
  part?: string | null;
  quality?: SkinQuality;
  /** The words to name the look in the status line, e.g. a chip label. Defaults to the text. */
  label?: string;
}

export class SkinControls {
  readonly root: HTMLFieldSetElement;
  private readonly badge: HTMLElement;
  private readonly text: HTMLInputElement;
  private readonly part: HTMLSelectElement;
  private readonly high: HTMLInputElement;
  private readonly file: HTMLInputElement;
  private readonly status: HTMLElement;
  private objectBusy = false;
  private drawing = false;

  constructor(
    private readonly renderer: SlotRenderer,
    private readonly brain: SkinBrain,
  ) {
    this.root = el('fieldset', { id: 'skin-box', 'data-testid': 'skin-box', 'aria-describedby': 'skin-status' });
    const legend = el('legend', {}, 'Skin ');
    this.badge = el('span', { class: 'skin-badge' });
    legend.appendChild(this.badge);
    this.root.appendChild(legend);

    const form = el('form', { class: 'skin-form' });
    const label = el('label', { for: 'skin-text', class: 'skin-label' }, 'Describe a skin');
    this.text = el('input', { id: 'skin-text', type: 'text', maxlength: '200', placeholder: 'e.g. brushed gold, red camo', 'data-testid': 'skin-text', autocomplete: 'off' });
    // Keys typed here must not steer the arm (the mouse source listens for W, S and G).
    this.text.addEventListener('keydown', (event) => event.stopPropagation());
    const paint = el('button', { type: 'submit', 'data-testid': 'skin-apply' }, 'Paint');
    const row = el('div', { class: 'skin-row' });
    row.append(this.text, paint);
    form.append(label, row);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = this.text.value.trim();
      if (text) void this.request({ text });
    });
    this.root.appendChild(form);

    const chips = el('div', { class: 'skin-chips', role: 'group', 'aria-label': 'Skin presets' });
    for (const preset of SKIN_PRESETS) {
      const chip = el('button', { type: 'button', 'data-skin-preset': preset.id }, preset.label);
      chip.addEventListener('click', () => void this.request({ text: preset.text, label: preset.label.toLowerCase() }));
      chips.appendChild(chip);
    }
    this.root.appendChild(chips);

    const partLabel = el('label', { class: 'skin-label skin-inline' }, 'Part ');
    this.part = el('select', { 'data-testid': 'skin-part', 'aria-label': 'Part to paint' });
    this.part.addEventListener('keydown', (event) => event.stopPropagation());
    partLabel.appendChild(this.part);
    this.root.appendChild(partLabel);

    const highLabel = el('label', { class: 'skin-label skin-inline' });
    this.high = el('input', { type: 'checkbox', 'data-testid': 'skin-high' });
    highLabel.append(this.high, document.createTextNode(' High quality (Pro, about 14 cents)'));
    this.root.appendChild(highLabel);

    const actions = el('div', { class: 'skin-row' });
    // The real control is a button; the file input stays hidden and is only opened by it.
    this.file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', 'data-testid': 'skin-file', hidden: '', 'aria-hidden': 'true', tabindex: '-1' });
    const upload = el('button', { type: 'button', 'data-testid': 'skin-upload' }, 'Upload image');
    upload.addEventListener('click', () => this.file.click());
    this.file.addEventListener('change', () => {
      const chosen = this.file.files?.[0];
      this.file.value = '';
      if (chosen) void this.upload(chosen);
    });
    const remove = el('button', { type: 'button', 'data-testid': 'skin-remove' }, 'Remove skin');
    remove.addEventListener('click', () => void this.remove(this.part.value || null));
    actions.append(upload, this.file, remove);
    this.root.appendChild(actions);

    this.status = el('div', { id: 'skin-status', class: 'why skin-status', 'data-testid': 'skin-status', 'aria-live': 'polite' });
    this.root.appendChild(this.status);
    this.showBadge();
    this.setObject(renderer.receipt);
  }

  /**
   * The badge names where the skin on the object came from, read from its parts: the model that
   * really drew it, "procedural (Nano Banana failed)" for a fallback, or "your image". With no skin
   * on yet it says whether Nano Banana is ready.
   */
  showBadge(): void {
    const live = this.brain.live;
    const parts = this.renderer.receipt ? (this.renderer.skinState()?.parts ?? []) : [];
    const badge = skinBadge(parts, live);
    this.badge.textContent = badge.text;
    this.badge.dataset.testid = `skin-source-${badge.kind}`;
    this.badge.dataset.live = String(badge.live);
    this.badge.title = live
      ? `Skins are drawn by Nano Banana (${this.brain.model('fast')}, or ${this.brain.model('high')} for high quality) through the key server. Only your description is sent. Each new image is paid; repeats come from the cache.`
      : 'Skins are drawn procedurally in the browser. No image model is called.';
  }

  /** Called whenever the slot changes. `why` 'rock' means a Moon mode put the test rock back. */
  setObject(receipt: Receipt | null, why: 'rock' | null = null): void {
    const names = receipt && this.renderer.receipt === receipt ? this.renderer.skin().partNames : [];
    const options: HTMLOptionElement[] = [el('option', { value: '' }, names.length > 1 ? `All parts (${names.length})` : 'Whole object')];
    if (names.length > 1) {
      const groups = new Map<string, number>();
      for (const n of names) {
        const last = singular(n.split(' ').pop()!.toLowerCase());
        groups.set(last, (groups.get(last) ?? 0) + 1);
      }
      for (const [word, count] of groups) if (count > 1 && !names.includes(word)) options.push(el('option', { value: `${word}s` }, `All ${word}s (${count})`));
      for (const n of new Set(names)) options.push(el('option', { value: n }, n));
    }
    this.part.replaceChildren(...options);
    if (receipt === null) {
      this.status.textContent =
        why === 'rock'
          ? 'The Moon modes put the 30 mm test rock back in the slot, so the object and its skin are gone. Make an object to paint again.'
          : 'Make an object first: the 30 mm test rock cannot take a skin.';
    } else {
      const state = this.renderer.skinState();
      const skinned = state?.parts.filter((p) => p.source !== null).length ?? 0;
      this.status.textContent = skinned > 0 ? `The ${displayName(receipt)} came back with its skin on ${skinned} part${skinned === 1 ? '' : 's'}.` : `Paint the ${displayName(receipt)}: type a look, pick a chip, or upload an image.`;
    }
    this.showBadge();
    this.sync();
  }

  /** The object panel calls this around every object request. */
  setBusy(busy: boolean): void {
    this.objectBusy = busy;
    this.sync();
  }

  get busy(): boolean {
    return this.drawing || this.objectBusy;
  }

  /** Paints the object in the slot now. Resolves with the line to show and say; never throws. */
  async request(req: SkinRequest): Promise<string> {
    const text = req.text.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) return this.say('Say or type a look to paint, such as gold or carbon fibre.');
    const ready = this.target(req.part);
    if (typeof ready === 'string') return this.say(ready);
    const { mesh, names, parts, receipt } = ready;
    const quality = req.quality ?? (this.high.checked ? 'high' : 'fast');
    this.setDrawing(true, this.brain.live ? `Asking ${modelName(this.brain.model(quality))} for ${text}...` : `Drawing ${text}...`);
    let image: SkinImage;
    try {
      image = await this.brain.draw(text, quality);
    } catch (error) {
      this.setDrawing(false);
      return this.say(`The skin could not be drawn: ${error instanceof Error ? error.message : String(error)}`);
    }
    return this.finish(mesh, receipt, names, parts, image, req.label ?? text);
  }

  /** Paints the operator's own image. It is decoded here and never uploaded anywhere. */
  async upload(file: File): Promise<string> {
    const ready = this.target(this.part.value || null);
    if (typeof ready === 'string') return this.say(ready);
    const { mesh, names, parts, receipt } = ready;
    this.setDrawing(true, `Reading ${file.name}...`);
    let image: SkinImage;
    try {
      image = await this.brain.fromFile(file);
    } catch (error) {
      this.setDrawing(false);
      return this.say(error instanceof Error ? error.message : String(error));
    }
    return this.finish(mesh, receipt, names, parts, image, 'your image');
  }

  /** Takes the skin off every part, or the parts a phrase names. */
  async remove(part: string | null = null): Promise<string> {
    const receipt = this.renderer.receipt;
    if (!receipt) return this.say('There is no object in the slot, so there is no skin to remove.');
    if (this.objectBusy) return this.say('Wait for the object request to finish.');
    const names = this.renderer.skin().partNames;
    const parts = matchParts(names, part);
    if (parts.length === 0) return this.say(`The ${displayName(receipt)} has no part called ${part}. Its parts are ${names.join(', ')}.`);
    const removed = this.renderer.removeSkin(parts);
    this.showBadge();
    if (removed === 0) return this.say(`There was no skin on ${whereText(names, parts)} to remove.`);
    return this.say(`Removed the skin from ${whereText(names, parts)}. The ${displayName(receipt)} shows its own colours there again.`);
  }

  private target(part: string | null | undefined): string | { mesh: NonNullable<SlotRenderer['objectMesh']>; names: string[]; parts: number[]; receipt: Receipt } {
    const receipt = this.renderer.receipt;
    const mesh = this.renderer.objectMesh;
    if (!receipt || !mesh) return 'There is no object to paint. Make one first: the 30 mm test rock cannot take a skin.';
    if (this.objectBusy) return 'Wait for the object request to finish, then paint it.';
    if (this.drawing) return 'A skin is still being drawn. Try again in a moment.';
    const names = this.renderer.skin().partNames;
    const chosen = part ?? (this.part.value || null);
    const parts = matchParts(names, chosen);
    if (parts.length === 0) return `The ${displayName(receipt)} has no part called ${chosen}. Its parts are ${names.join(', ')}.`;
    return { mesh, names, parts, receipt };
  }

  private finish(mesh: NonNullable<SlotRenderer['objectMesh']>, receipt: Receipt, names: string[], parts: number[], image: SkinImage, label: string): string {
    this.setDrawing(false);
    // A slow image may arrive after a new object replaced this one: then it is dropped.
    if (!this.renderer.applySkin(mesh, parts, image)) return this.say(`A new object arrived while the skin was drawn, so the ${label} skin was not applied.`);
    this.showBadge();
    const where = whereText(names, parts);
    const recipe = image.source === 'procedural' ? RECIPE_WORDS[recipeFor(image.text)] : null;
    const look = image.source === 'upload' ? `your image (${image.text})` : recipe && !label.toLowerCase().includes(recipe.split(' ')[0]!.slice(0, 4)) ? `${label} (as procedural ${recipe})` : label;
    let how: string;
    let spoken: string;
    if (image.source === 'nano-banana') {
      const name = modelName(image.model);
      const hit = image.cache === 'hit' || image.cache === 'session';
      const time = image.drawnMs !== null ? duration(image.drawnMs) : duration(image.ms);
      // A cache hit took this request's own time; the original drawing time is named as such.
      const cached = hit ? `, from the cache in ${duration(image.ms)}${image.drawnMs !== null ? ` (first drawn in ${time})` : ''}, so no new image was paid for` : '';
      how = hit ? `Drawn by ${name} (${image.model})${cached}.` : `Drawn by ${name} (${image.model}) in ${time}.`;
      spoken = `Drawn by ${name}${cached ? ', from the cache' : ` in ${time}`}.`;
    } else if (image.source === 'upload') {
      how = 'Decoded in this browser; the image was not sent anywhere.';
      spoken = 'It stays in this browser.';
    } else {
      how = image.note ? `${image.note}` : `Drawn procedurally in the browser in ${duration(image.ms)} (offline).`;
      spoken = image.note ? 'Nano Banana did not answer, so I drew it procedurally.' : 'Drawn procedurally, offline.';
    }
    const line = `Painted ${look} on ${where} of the ${displayName(receipt)}. ${how} ${PAINT_ONLY}`;
    this.status.textContent = line;
    return `Painted ${look} on ${where}. ${spoken} Paint only: the physics did not change.`;
  }

  private say(line: string): string {
    this.status.textContent = line;
    return line;
  }

  private setDrawing(drawing: boolean, line?: string): void {
    this.drawing = drawing;
    if (line) this.status.textContent = line;
    this.sync();
  }

  private sync(): void {
    const empty = this.renderer.receipt === null;
    // Each control is disabled itself (not the fieldset), so a disabled control is also out of
    // the Tab order and the page's own checks see exactly which ones are off.
    const off = this.busy || empty;
    for (const control of this.root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select')) {
      if (control !== this.file) control.disabled = off;
    }
    this.root.dataset.empty = String(empty);
    this.root.dataset.busy = String(this.busy);
    this.root.setAttribute('aria-busy', String(this.drawing));
  }
}
