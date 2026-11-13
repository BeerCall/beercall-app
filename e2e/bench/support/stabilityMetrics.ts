import { expect, type Page, type Locator } from '@playwright/test';

export type ContextStatus = 'live' | 'lost' | 'restored';

export interface SerializedContextSnapshot {
  id: string;
  status: ContextStatus;
  canvasId: string;
  drawCalls: number;
  lastDrawTimestamp: number;
  createdTimestamp: number;
  lostTimestamp: number | null;
  restoredTimestamp: number | null;
  canvasConnected: boolean;
  contextCollected: boolean;
}

export interface StabilityMetricsSnapshot {
  contextsCreated: number;
  activeContexts: number;
  contextsLost: number;
  contextsRestored: number;
  drawCalls: number;
  contexts: SerializedContextSnapshot[];
}

export async function installStabilityMetrics(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let nextContextId = 0;
    let nextCanvasId = 0;
    const cleanups: Array<() => void> = [];
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    const canvasCopies = new WeakMap<HTMLCanvasElement, number>();
    const originalDrawMethods: Array<{ proto: object; method: string; orig: Function }> = [];

    interface InternalTrackedEntry {
      id: string;
      contextRef: WeakRef<object>;
      canvasRef: WeakRef<HTMLCanvasElement>;
      canvasId: string;
      documentRef: WeakRef<Document>;
      status: ContextStatus;
      drawCalls: number;
      lastDrawTimestamp: number;
      createdTimestamp: number;
      lostTimestamp: number | null;
      restoredTimestamp: number | null;
    }

    const contextEntries = new WeakMap<object, InternalTrackedEntry>();
    const canvasDraws = new WeakMap<HTMLCanvasElement, number>();
    const trackedEntries: InternalTrackedEntry[] = [];
    function weakCleanup(canvasRef: WeakRef<HTMLCanvasElement>, onLost: () => void, onRestored: () => void) {
      // Cette fermeture est créée hors getContext : aucun `this`/canvas natif
      // ne reste retenu par la liste des nettoyages après son démontage.
      return () => {
        const canvas = canvasRef.deref();
        canvas?.removeEventListener('webglcontextlost', onLost);
        canvas?.removeEventListener('webglcontextrestored', onRestored);
      };
    }

    const metrics = {
      contextsCreated: 0,
      contextsLost: 0,
      contextsRestored: 0,
      drawCalls: 0,
    };

    window.__stabilityMetrics = {
      get contextsCreated() { return metrics.contextsCreated; },
      get contextsLost() { return metrics.contextsLost; },
      get contextsRestored() { return metrics.contextsRestored; },
      get drawCalls() { return metrics.drawCalls; },
      get activeContexts() {
        return trackedEntries.filter(
          e => (e.status === 'live' || e.status === 'restored') && e.contextRef.deref() !== undefined,
        ).length;
      },
    };

    window.__stabilityCanvasDraws = (canvas: HTMLCanvasElement) => canvasDraws.get(canvas) ?? 0;
    window.__stabilityCanvasCopies = canvas => canvasCopies.get(canvas) ?? 0;
    CanvasRenderingContext2D.prototype.drawImage = function(this: CanvasRenderingContext2D, ...args: unknown[]) {
      const result = Reflect.apply(originalDrawImage, this, args);
      if (this.canvas.matches('[data-avatar-cell]')) {
        if (!this.canvas.hasAttribute('data-stability-id')) this.canvas.setAttribute('data-stability-id', `cell_${++nextCanvasId}`);
        canvasCopies.set(this.canvas, (canvasCopies.get(this.canvas) ?? 0) + 1);
      }
      return result;
    } as typeof originalDrawImage;

    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
      const context = Reflect.apply(originalGetContext, this, args) as RenderingContext | null;
      const type = args[0];
      if (context && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
        const obj = context as object;
        let entry = contextEntries.get(obj);
        if (!entry) {
          const id = `ctx_${++nextContextId}`;
          let canvasId = this.getAttribute('data-stability-id');
          if (!canvasId) {
            canvasId = `canvas_${++nextCanvasId}`;
            this.setAttribute('data-stability-id', canvasId);
          }
          entry = {
            id,
            contextRef: new WeakRef(obj),
            canvasRef: new WeakRef(this),
            canvasId,
            documentRef: new WeakRef(this.ownerDocument ?? document),
            status: 'live',
            drawCalls: 0,
            lastDrawTimestamp: 0,
            createdTimestamp: Date.now(),
            lostTimestamp: null,
            restoredTimestamp: null,
          };
          contextEntries.set(obj, entry);
          trackedEntries.push(entry);
          metrics.contextsCreated++;

          const onLost = () => {
            entry!.status = 'lost';
            entry!.lostTimestamp = Date.now();
            metrics.contextsLost++;
          };
          const onRestored = () => {
            // Restaurations réactivent le même identifiant
            entry!.status = 'restored';
            entry!.restoredTimestamp = Date.now();
            metrics.contextsRestored++;
          };

          this.addEventListener('webglcontextlost', onLost);
          this.addEventListener('webglcontextrestored', onRestored);
          cleanups.push(weakCleanup(entry.canvasRef, onLost, onRestored));
        }
      }
      return context;
    } as typeof HTMLCanvasElement.prototype.getContext;

    const instrument = (proto: object | undefined, method: string) => {
      if (!proto) return;
      const record = proto as Record<string, unknown>;
      const orig = record[method];
      if (typeof orig !== 'function') return;
      originalDrawMethods.push({ proto, method, orig: orig as Function });
      record[method] = function (this: object, ...args: unknown[]) {
        const entry = contextEntries.get(this);
        if (entry) {
          entry.drawCalls++;
          entry.lastDrawTimestamp = Date.now();
          const canvas = entry.canvasRef.deref();
          if (canvas) {
            canvasDraws.set(canvas, (canvasDraws.get(canvas) ?? 0) + 1);
          }
        }
        metrics.drawCalls++;
        return (orig as (...inner: unknown[]) => unknown).apply(this, args);
      };
    };

    for (const proto of [window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype]) {
      for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
        instrument(proto, m);
      }
    }

    window.__stabilitySetDocumentHidden = (hidden: boolean) => {
      const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
      if (!descriptor?.configurable) return false;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event('visibilitychange'));
      return true;
    };

    window.__getStabilitySnapshot = (): StabilityMetricsSnapshot => ({
      contextsCreated: metrics.contextsCreated,
      contextsLost: metrics.contextsLost,
      contextsRestored: metrics.contextsRestored,
      activeContexts: trackedEntries.filter(
        e => (e.status === 'live' || e.status === 'restored') && e.contextRef.deref() !== undefined,
      ).length,
      drawCalls: metrics.drawCalls,
      contexts: trackedEntries.map(e => ({
        id: e.id,
        canvasId: e.canvasId,
        status: e.status,
        drawCalls: e.drawCalls,
        lastDrawTimestamp: e.lastDrawTimestamp,
        createdTimestamp: e.createdTimestamp,
        lostTimestamp: e.lostTimestamp,
        restoredTimestamp: e.restoredTimestamp,
        canvasConnected: Boolean(e.canvasRef.deref()?.isConnected),
        contextCollected: e.contextRef.deref() === undefined,
      })),
    });

    window.__stabilityIsPatched = () => {
      return HTMLCanvasElement.prototype.getContext !== originalGetContext;
    };

    window.__teardownStabilityMetrics = () => {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      CanvasRenderingContext2D.prototype.drawImage = originalDrawImage;
      for (const { proto, method, orig } of originalDrawMethods) {
        (proto as Record<string, unknown>)[method] = orig;
      }
      for (const cleanup of cleanups) cleanup();
      cleanups.length = 0;
      delete (document as unknown as { hidden?: boolean }).hidden;
      delete window.__stabilityMetrics;
      delete window.__stabilityCanvasDraws;
      delete window.__stabilityCanvasCopies;
      delete window.__stabilitySetDocumentHidden;
      delete window.__getStabilitySnapshot;
      delete window.__stabilityIsPatched;
      delete window.__teardownStabilityMetrics;
    };
  });
}

export async function teardownStabilityMetrics(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      if (typeof window.__teardownStabilityMetrics === 'function') {
        window.__teardownStabilityMetrics();
      }
    });
  } catch (_) {
    // Si la page a déjà été fermée ou naviguée
  }
}

export async function getStabilitySnapshot(page: Page): Promise<StabilityMetricsSnapshot> {
  return page.evaluate(() => {
    if (typeof window.__getStabilitySnapshot !== 'function') {
      throw new Error('__getStabilitySnapshot non disponible : harnais non initialisé');
    }
    return window.__getStabilitySnapshot();
  });
}

export async function assertCleanTeardown(page: Page): Promise<void> {
  const issues = await page.evaluate(() => {
    const problems: string[] = [];
    if (window.__stabilityIsPatched?.()) {
      problems.push('HTMLCanvasElement.prototype.getContext toujours patché');
    }
    if (window.__stabilityMetrics !== undefined) {
      problems.push('window.__stabilityMetrics toujours présent');
    }
    if (window.__stabilityCanvasDraws !== undefined) {
      problems.push('window.__stabilityCanvasDraws toujours présent');
    }
    if (window.__stabilityCanvasCopies !== undefined) problems.push('window.__stabilityCanvasCopies toujours présent');
    if (window.__stabilitySetDocumentHidden !== undefined) {
      problems.push('window.__stabilitySetDocumentHidden toujours présent');
    }
    if (window.__getStabilitySnapshot !== undefined) {
      problems.push('window.__getStabilitySnapshot toujours présent');
    }
    if (window.__teardownStabilityMetrics !== undefined) {
      problems.push('window.__teardownStabilityMetrics toujours présent');
    }
    const fnStr = Function.prototype.toString.call(HTMLCanvasElement.prototype.getContext);
    if (!fnStr.includes('[native code]') && !fnStr.includes('native')) {
      problems.push(`getContext non natif : ${fnStr.slice(0, 50)}`);
    }
    return problems;
  });
  if (issues.length > 0) {
    throw new Error(`Teardown qui laisse un patch : ${issues.join(' ; ')}`);
  }
}

declare global {
  interface Window {
    __stabilityMetrics?: {
      readonly contextsCreated: number;
      readonly contextsLost: number;
      readonly contextsRestored: number;
      readonly drawCalls: number;
      readonly activeContexts: number;
    };
    __stabilityCanvasDraws?: (canvas: HTMLCanvasElement) => number;
    __stabilityCanvasCopies?: (canvas: HTMLCanvasElement) => number;
    __stabilitySetDocumentHidden?: (hidden: boolean) => boolean;
    __getStabilitySnapshot?: () => StabilityMetricsSnapshot;
    __stabilityIsPatched?: () => boolean;
    __teardownStabilityMetrics?: () => void;
    __beercall_scene_metrics?: Record<string, { drawCalls?: number; timestamp?: number; frames?: number }>;
  }
}

/** Prove this 2D cell's own scene/copy, never a neighbour's WebGL calls. */
export async function assertAvatarPresentation(canvas: Locator) {
  const proof = await canvas.evaluate(element => {
    const cell = element as HTMLCanvasElement;
    type Group = {traverse(callback: (node: {isMesh?: boolean; visible: boolean}) => void): void};
    type Registry = {generation: number; getSnapshot(): {views: {id: string; jobId: string; signature: string; frame?: {signature: string; generation: number; drawCalls: number}}[]; jobs: {id: string; ready: boolean; group?: Group}[]}};
    type Fiber = {return?: Fiber; memoizedProps?: {value?: {registry?: Registry}; session?: {registry?: Registry}}};
    const key = Object.keys(cell).find(key => key.startsWith('__reactFiber$'));
    let fiber = key ? (cell as unknown as Record<string, Fiber>)[key] : undefined;
    let registry: Registry | undefined;
    while (fiber) {registry = (fiber.memoizedProps?.value ?? fiber.memoizedProps?.session)?.registry; if (registry) break; fiber = fiber.return;}
    const snapshot = registry?.getSnapshot();
    const id = cell.closest<HTMLElement>('[data-avatar-view]')?.dataset.avatarView;
    const view = snapshot?.views.find(view => view.id === id);
    const job = snapshot?.jobs.find(job => job.id === view?.jobId);
    let meshes = 0; job?.group?.traverse(node => {if (node.isMesh && node.visible) meshes++;});
    const scratch = document.createElement('canvas'); scratch.width = cell.width; scratch.height = cell.height;
    const context = scratch.getContext('2d', {willReadFrequently: true}); context?.drawImage(cell, 0, 0);
    const pixels = context?.getImageData(0, 0, scratch.width, scratch.height).data;
    let opaque = 0; const colors = new Set<string>();
    if (pixels) for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 0) {opaque++; colors.add(`${pixels[i] >> 4}:${pixels[i + 1] >> 4}:${pixels[i + 2] >> 4}`);}
    return {current: !!view?.frame && view.frame.signature === view.signature && view.frame.generation === registry?.generation,
      ready: !!job?.ready, meshes, calls: view?.frame?.drawCalls ?? 0, copies: window.__stabilityCanvasCopies?.(cell) ?? 0, opaque, colors: colors.size};
  });
  expect(proof.current).toBe(true); expect(proof.ready).toBe(true); expect(proof.meshes).toBeGreaterThan(0);
  expect(proof.calls).toBeGreaterThan(0); expect(proof.copies).toBeGreaterThan(0);
  expect(proof.opaque).toBeGreaterThan(10); expect(proof.colors).toBeGreaterThan(2);
  return proof;
}
