import type { Page } from '@playwright/test';
import { evaluatePick, jawContactSummary, type PickReport, type PickSample } from '../src/control/pickCheck';
import type { ContactReport, Vec3 } from '../src/sim/simulation';

/** Shared by the S2 and S3 browser tests: sample a scripted synthetic pick and score it. */
interface RawSample extends Omit<PickSample, 'jawsTouching' | 'jawMinDist'> {
  contacts: ContactReport[];
}

interface RunWindow {
  __pickRun?: Promise<{ restZ: number; samples: RawSample[] }>;
}

/** Resets the scene and samples the scripted pick once per frame until the script is done. */
export async function startRun(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sim = window.__sim!;
    sim.reset();
    const restZ = sim.getBodyPos('cube')![2];
    const samples: RawSample[] = [];
    (window as unknown as RunWindow).__pickRun = new Promise((resolve) => {
      const sample = () => {
        const input = sim.input() as Record<string, unknown>;
        if (input.phase) {
          samples.push({
            t: sim.simTime,
            phase: input.phase as string,
            phaseIndex: input.phaseIndex as number,
            settled: input.settled as boolean,
            waypoint: input.waypoint as Vec3,
            site: sim.getSitePos('gripper')!,
            cube: sim.getBodyPos('cube')!,
            grip: sim.controller().grip ?? 0,
            contacts: sim.contacts('cube'),
          });
        }
        if (input.done) resolve({ restZ, samples });
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  });
}

export async function finishRun(page: Page): Promise<PickReport & { samples: number }> {
  const { restZ, samples } = await page.evaluate(() => (window as unknown as RunWindow).__pickRun!);
  const report = evaluatePick(
    samples.map(({ contacts, ...rest }) => ({ ...rest, ...jawContactSummary(contacts) })),
    restZ,
  );
  return { ...report, samples: samples.length };
}

/** Collects page errors and console errors, which every test expects to stay empty. */
export function watchProblems(page: Page, problems: string[]): void {
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
  });
}
