import { expect, type Page } from '@playwright/test';

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
      for (const { proto, method, orig } of originalDrawMethods) {
        (proto as Record<string, unknown>)[method] = orig;
      }
      for (const cleanup of cleanups) cleanup();
      cleanups.length = 0;
      delete (document as unknown as { hidden?: boolean }).hidden;
      delete window.__stabilityMetrics;
      delete window.__stabilityCanvasDraws;
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
    __stabilitySetDocumentHidden?: (hidden: boolean) => boolean;
    __getStabilitySnapshot?: () => StabilityMetricsSnapshot;
    __stabilityIsPatched?: () => boolean;
    __teardownStabilityMetrics?: () => void;
    __beercall_scene_metrics?: Record<string, { drawCalls?: number; timestamp?: number; frames?: number }>;
  }
}
