/**
 * The stop latch. Once set it stays set until someone clears it on purpose: while it is
 * set the control loop sends no new commands, so every actuator (jaw included) keeps the
 * command it had at the moment of the stop. Setting it again while set changes nothing.
 */
export class StopLatch {
  private reason: string | null = null;
  private stoppedAt: number | null = null;
  private count = 0;
  private readonly listeners = new Set<(stopped: boolean) => void>();

  get stopped(): boolean {
    return this.reason !== null;
  }

  /** Why it was set ('space key', later 'stop gesture'), or null. */
  get why(): string | null {
    return this.reason;
  }

  /** How many times it went from clear to set. */
  get stops(): number {
    return this.count;
  }

  /** Simulated or wall time passed to stop(), whichever the caller uses. */
  get since(): number | null {
    return this.stoppedAt;
  }

  /** Sets the latch. Returns true only when this call changed it from clear to set. */
  stop(reason: string, at: number | null = null): boolean {
    if (this.reason !== null) return false;
    this.reason = reason;
    this.stoppedAt = at;
    this.count++;
    this.emit();
    return true;
  }

  /** Clears the latch. Returns true only when it was set. */
  clear(): boolean {
    if (this.reason === null) return false;
    this.reason = null;
    this.stoppedAt = null;
    this.emit();
    return true;
  }

  onChange(listener: (stopped: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.stopped);
  }
}

/** True for a Space key press that is not typing into a text field. */
export function isStopKey(event: Pick<KeyboardEvent, 'code' | 'key' | 'repeat'>, target: EventTarget | null): boolean {
  if (event.code !== 'Space' && event.key !== ' ') return false;
  const element = target as { tagName?: string; isContentEditable?: boolean } | null;
  const tag = element?.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element?.isContentEditable) return false;
  return true;
}
