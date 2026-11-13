import {expect, type BrowserContext, type Locator, type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {installUxFixtures} from './uxFixtures';

export type Outfit = {gender: 'Men' | 'Women'; head: string; body: string; legs: string; feet: string; accessory: string; animation: string};
export const WORKER: Outfit = {gender: 'Men', head: 'Men_head_Worker_0', body: 'Men_body_Worker_0', legs: 'Men_legs_Worker_0', feet: 'Men_feet_Worker_0', accessory: 'none', animation: 'Idle'};
export const SCIFI: Outfit = {gender: 'Women', head: 'Women_head_SciFi_150', body: 'Women_body_SciFi_300', legs: 'Women_legs_SciFi_200', feet: 'Women_feet_SciFi_100', accessory: 'none', animation: 'Idle'};
export const OUTFITS: Outfit[] = [WORKER, {...WORKER, accessory: 'Men_accessory_Kart_3000'}, {...WORKER, accessory: 'Men_accessory_RacingBulls_5000'}, SCIFI, {...SCIFI, accessory: 'Women_accessory_Charmander_2000'}];
const HEAD_WORKER = 'Women_head_Worker_0';
const hashes: Record<string, string> = {
    Men_head_Worker_0: '12f57b247785740196717060cf3d9c26cd901a79b3bc77c40bc3bf7f91cd883e',
    Men_body_Worker_0: '069ab65c35f3d2ea7a46b84fbec97025d3f5312893c8061779a516836112ab48',
    Men_legs_Worker_0: '812c4123fb4087eed0cd5d8f7df16b6a6fc678ec3b6f4edfec0e35e5f51ab464',
    Men_feet_Worker_0: 'a4fc307ed84819bbbedaa5a8e8226505dbe585d8f97aee2e29c3f0b1c3e9e28f',
    Men_accessory_Kart_3000: '543d1fa1e9a098dd6bea74621b180b12d9dc996b299a6414a2fae65a2f7b97ad',
    Men_accessory_RacingBulls_5000: 'f2946881c7b0ce86ee946351857fc82188c96362526a0234fb698fae5e7f3304',
    Women_head_SciFi_150: '9f2ffe15e2cc7f6b7928207937c106340469a58dc2a6d949de147865d398797b',
    Women_body_SciFi_300: '595097187fcd89bfbf8dd2e06eecb932e2c8f9ded42864c8ce0691102c1097a1',
    Women_legs_SciFi_200: '9700b8acf04e710b6eae7bf62ddc763badfb6c53b053611a5d496773e2e01dfe',
    Women_feet_SciFi_100: '7e10a8cea954417fd3f7ad3c174ed636803e9a73d73782068aea6f3a92c8304e',
    Women_accessory_Charmander_2000: 'b3306b9f8646890f21916c41de2b0a653fae66ff500216a53601f069ea482a58',
    Women_head_Worker_0: '38d723151d8d9c690b6afea854921e063da9359a6ac9bf615a98011bba9f204d',
};
const frontend = process.env.BEERCALL_WORKSPACE_FRONTEND ?? resolve(process.cwd(), '../beercall-frontend');
const backend = process.env.BEERCALL_WORKSPACE_BACKEND ?? resolve(process.cwd(), '../beercall-backend');
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');

export async function assertAvatarCandidate() {
    const directory = process.env.BEERCALL_USAGE_RESULTS;
    if (!directory) throw new Error('BEERCALL_USAGE_RESULTS is required');
    const identity = JSON.parse(await readFile(resolve(directory, 'candidate-identity.json'), 'utf8')) as {
        fSha: string; bSha: string; index: {containerSha256: string}; entries: {path: string; containerSha256: string}[];
    };
    expect(execFileSync('git', ['-C', frontend, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim()).toBe(identity.fSha);
    expect(execFileSync('git', ['-C', backend, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim()).toBe(identity.bSha);
    const paths = [{path: '/', containerSha256: identity.index.containerSha256}, ...identity.entries];
    await Promise.all(paths.map(async entry => {
        const response = await fetch(`http://127.0.0.1:8080${entry.path}`, {headers: {'Accept-Encoding': 'identity'}});
        expect(response.status, entry.path).toBe(200);
        expect(digest(Buffer.from(await response.arrayBuffer())), entry.path).toBe(entry.containerSha256);
    }));
}

interface Fiber {type?: unknown; memoizedProps?: Record<string, unknown>; memoizedState?: Hook | null; child?: Fiber; sibling?: Fiber; return?: Fiber}
interface Hook {memoizedState: unknown; queue?: {dispatch?: (value: unknown) => void}; next?: Hook | null}
interface Vector {x: number; y: number; z: number; clone(): Vector; set(x: number, y: number, z: number): Vector; applyMatrix4(matrix: unknown): Vector; project(camera: unknown): Vector; toArray(): number[]}
interface Box {min: Vector; max: Vector; clone(): Box; applyMatrix4(matrix: unknown): Box; isEmpty(): boolean}
interface ModelObject {isMesh?: boolean; isSkinnedMesh?: boolean; visible: boolean; userData?: {partKey?: string}; matrixWorld: unknown; boundingBox?: Box; geometry?: {boundingBox?: Box; computeBoundingBox(): void}; computeBoundingBox?(): void; updateMatrixWorld(force: boolean): void; traverse(callback: (object: ModelObject) => void): void}
interface Frame {signature: string; generation: number; copies: number; drawCalls: number}
interface View {id: string; signature: string; jobId: string; visible: boolean; prepare?: boolean; frame?: Frame; target: HTMLCanvasElement}
interface Job {id: string; signature: string; mode: string; ready: boolean; group?: ModelObject; camera?: {position: Vector; matrixWorldInverse: {toArray(): number[]}; projectionMatrix: {toArray(): number[]}}; framing?: {corners: number[][]; near: number; far: number}; presentation?: {phase: string}}
interface Registry {generation: number; getSnapshot(): {views: View[]; jobs: Job[]}}
interface Metrics {created: number; live: number; lost: number; restored: number; sources: number; views: {id: string; copies: number}[]}
export interface AvatarPixelProof {id: string; state: string | null; opaque: number; colors: number; width: number; height: number; current: boolean; ready: boolean; meshes: number; parts: string[]; corners: number[][]; clips: string[]; calls: number; copies: number; camera: number[]; viewMatrix: number[]; projectionMatrix: number[]}
interface ClientGraphics {
    visible(selector: string): HTMLElement[];
    read(selector: string, onlyVisible?: boolean, pixels?: boolean): AvatarPixelProof[];
    metrics(): Metrics;
    seedMessages(messages: unknown[]): void;
    hide(hidden: boolean): void;
    cleanup(): void;
}
declare global {interface Window {__avatarGraphics: ClientGraphics}}

export async function installAvatarGraphics(context: BrowserContext) {
    await context.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        const originalDraw = CanvasRenderingContext2D.prototype.drawImage;
        const entries: {canvas: WeakRef<HTMLCanvasElement>; context: WeakRef<WebGLRenderingContext | WebGL2RenderingContext>; lost: boolean}[] = [];
        const seen = new WeakSet<HTMLCanvasElement>();
        const copies = new WeakMap<HTMLCanvasElement, number>();
        const cleanup: (() => void)[] = [];
        const documentHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
        const originalGeolocation = Object.getOwnPropertyDescriptor(navigator, 'geolocation');
        const watches = new Map<number, number>(); let nextWatch = 0;
        const fix = (): GeolocationPosition => ({coords: {latitude: 48.8566, longitude: 2.3522, accuracy: 5,
            altitude: null, altitudeAccuracy: null, heading: null, speed: null}, timestamp: Date.now()}) as GeolocationPosition;
        Object.defineProperty(navigator, 'geolocation', {configurable: true, value: {
            getCurrentPosition(success: PositionCallback) {success(fix());},
            watchPosition(success: PositionCallback) {success(fix()); const id = ++nextWatch; watches.set(id, window.setInterval(() => success(fix()), 1000)); return id;},
            clearWatch(id: number) {window.clearInterval(watches.get(id)); watches.delete(id);},
        }});
        let lostCount = 0; let restoredCount = 0;
        const roots: WeakRef<{current: Fiber}>[] = []; const seenRoots = new WeakSet<object>();
        const global = window as unknown as Record<string, unknown>;
        const oldHook = global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        global.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {supportsFiber: true, renderers: new Map(), inject() {return 1;},
            onCommitFiberRoot(_id: number, root: {current: Fiber}) {if (!seenRoots.has(root)) {seenRoots.add(root); roots.push(new WeakRef(root));}},
            onCommitFiberUnmount() {}};
        HTMLCanvasElement.prototype.getContext = function(this: HTMLCanvasElement, ...args: unknown[]) {
            const result = Reflect.apply(original, this, args) as RenderingContext | null;
            if (result && (args[0] === 'webgl' || args[0] === 'webgl2') && !seen.has(this)) {
                seen.add(this);
                const entry = {canvas: new WeakRef(this), context: new WeakRef(result as WebGLRenderingContext | WebGL2RenderingContext), lost: false};
                entries.push(entry);
                const lost = () => {if (!entry.lost) {entry.lost = true; lostCount++;}};
                const restored = () => {if (entry.lost) {entry.lost = false; restoredCount++;}};
                this.addEventListener('webglcontextlost', lost); this.addEventListener('webglcontextrestored', restored);
                cleanup.push(() => {const canvas = entry.canvas.deref(); canvas?.removeEventListener('webglcontextlost', lost); canvas?.removeEventListener('webglcontextrestored', restored);});
            }
            return result;
        } as typeof original;
        CanvasRenderingContext2D.prototype.drawImage = function(this: CanvasRenderingContext2D, ...args: unknown[]) {
            const result = Reflect.apply(originalDraw, this, args);
            if (this.canvas.matches('[data-avatar-cell]')) copies.set(this.canvas, (copies.get(this.canvas) ?? 0) + 1);
            return result;
        } as typeof originalDraw;
        const fiberOf = (node: Element): Fiber | undefined => {
            const key = Object.keys(node).find(key => key.startsWith('__reactFiber$'));
            return key ? (node as unknown as Record<string, unknown>)[key] as Fiber : undefined;
        };
        const registryOf = (node: Element): Registry | undefined => {
            let fiber = fiberOf(node);
            while (fiber) {
                const session = (fiber.memoizedProps?.value ?? fiber.memoizedProps?.session) as {registry?: Registry} | undefined;
                if (session?.registry?.getSnapshot) return session.registry;
                fiber = fiber.return;
            }
        };
        const visible = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].filter(node => {
            const rect = node.getBoundingClientRect();
            let left = Math.max(0, rect.left), top = Math.max(0, rect.top), right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
            let parent: HTMLElement | null = node;
            while (parent) {
                const css = getComputedStyle(parent);
                if (css.display === 'none' || css.visibility === 'hidden') return false;
                if (parent !== node && /(auto|scroll|hidden|clip)/.test(css.overflow + css.overflowY)) {
                    const bounds = parent.getBoundingClientRect(); left = Math.max(left, bounds.left); top = Math.max(top, bounds.top); right = Math.min(right, bounds.right); bottom = Math.min(bottom, bounds.bottom);
                }
                parent = parent.parentElement;
            }
            return rect.width > 0 && rect.height > 0 && right > left && bottom > top;
        });
        const clipsFor = (group: ModelObject) => {
            const result = new Set<string>();
            const parts = (fiber?: Fiber) => {if (!fiber) return; if (typeof fiber.memoizedProps?.partKey === 'string' && typeof fiber.memoizedProps.currentAnim === 'string') result.add(fiber.memoizedProps.currentAnim); parts(fiber.child); parts(fiber.sibling);};
            // The framing controller receives this same groupRef before the
            // ModularAvatar sibling. Do not stop at that childless controller.
            const visit = (fiber?: Fiber) => {if (!fiber) return; const ref = fiber.memoizedProps?.groupRef as {current?: ModelObject} | undefined; if (ref?.current === group) parts(fiber.child); visit(fiber.child); visit(fiber.sibling);};
            roots.forEach(root => visit(root.deref()?.current));
            return [...result];
        };
        window.__avatarGraphics = {
            visible,
            read(selector, onlyVisible = true, includePixels = true) {
                return (onlyVisible ? visible(selector) : [...document.querySelectorAll<HTMLElement>(selector)]).map(node => {
                    const canvas = node instanceof HTMLCanvasElement ? node : node.querySelector<HTMLCanvasElement>('[data-avatar-cell]');
                    if (!canvas) throw new Error('The requested avatar cell has no presentation canvas');
                    const element = canvas.closest<HTMLElement>('[data-avatar-view]');
                    const registry = registryOf(canvas); const snapshot = registry?.getSnapshot();
                    const view = snapshot?.views.find(view => view.id === element?.dataset.avatarView);
                    const job = snapshot?.jobs.find(job => job.id === view?.jobId);
                    // Repeated getImageData on the application's canvas can make
                    // Chromium move it to CPU storage, changing later drawImage
                    // timings. Read an exact copy of its presented pixels instead.
                    let pixels: Uint8ClampedArray | undefined;
                    if (includePixels) {
                        const sample = document.createElement('canvas');
                        sample.width = canvas.width; sample.height = canvas.height;
                        const readback = sample.getContext('2d', {willReadFrequently: true});
                        readback?.drawImage(canvas, 0, 0);
                        pixels = readback?.getImageData(0, 0, sample.width, sample.height).data;
                    }
                    let opaque = 0; const colors = new Set<string>();
                    if (pixels) for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 0) {opaque++; colors.add(`${pixels[i] >> 4}:${pixels[i + 1] >> 4}:${pixels[i + 2] >> 4}`);}
                    let meshes = 0; const parts = new Set<string>(); const corners: number[][] = [];
                    job?.group?.updateMatrixWorld(true);
                    job?.group?.traverse(object => {
                        if (object.userData?.partKey) parts.add(object.userData.partKey);
                        if (!object.isMesh || !object.visible || !job?.camera) return;
                        meshes++;
                        if (object.isSkinnedMesh) object.computeBoundingBox?.(); else if (object.geometry && !object.geometry.boundingBox) object.geometry.computeBoundingBox();
                        const local = object.isSkinnedMesh ? object.boundingBox : object.geometry?.boundingBox;
                        if (!local || local.isEmpty()) return;
                        const box = local.clone().applyMatrix4(object.matrixWorld);
                        for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(box.min.clone().set(x, y, z).project(job.camera).toArray());
                    });
                    return {id: view?.id ?? '', state: element?.dataset.avatarState ?? null, opaque, colors: colors.size,
                        width: canvas.width, height: canvas.height, current: !!view?.frame && view.frame.signature === view.signature && view.frame.generation === registry?.generation,
                        ready: !!job?.ready, meshes, parts: [...parts], corners, clips: job?.group ? clipsFor(job.group) : [], calls: view?.frame?.drawCalls ?? 0, copies: copies.get(canvas) ?? 0,
                        camera: job?.camera?.position.toArray() ?? [], viewMatrix: job?.camera?.matrixWorldInverse.toArray() ?? [], projectionMatrix: job?.camera?.projectionMatrix.toArray() ?? []};
                });
            },
            metrics() {
                return {created: entries.length, live: entries.filter(entry => {const gl = entry.context.deref(); return !!gl && !gl.isContextLost();}).length,
                    lost: lostCount, restored: restoredCount,
                    sources: entries.filter(entry => {const canvas = entry.canvas.deref(), gl = entry.context.deref(); return !!gl && !gl.isContextLost() && !!canvas?.closest('[data-avatar-source]');}).length,
                    views: [...document.querySelectorAll<HTMLCanvasElement>('[data-avatar-cell]')].map(canvas => ({id: canvas.closest<HTMLElement>('[data-avatar-view]')?.dataset.avatarView ?? '', copies: copies.get(canvas) ?? 0}))};
            },
            seedMessages(messages) {
                const textarea = document.querySelector('textarea'); if (!textarea) throw new Error('Chat route not mounted');
                let fiber = fiberOf(textarea);
                while (fiber && typeof fiber.type !== 'function') fiber = fiber.return;
                let hook = fiber?.memoizedState;
                while (hook) {
                    if (Array.isArray(hook.memoizedState) && typeof hook.next?.memoizedState === 'boolean' &&
                        (hook.next.next?.memoizedState === null || typeof hook.next.next?.memoizedState === 'string') && hook.queue?.dispatch) {
                        hook.queue.dispatch(messages); hook.next.queue?.dispatch?.(false); hook.next.next?.queue?.dispatch?.(null); return;
                    }
                    hook = hook.next;
                }
                throw new Error('No genuine useChat state found: fixture refuses to inject fake message DOM');
            },
            hide(hidden) {Object.defineProperty(document, 'hidden', {configurable: true, get: () => hidden}); document.dispatchEvent(new Event('visibilitychange'));},
            cleanup() {
                HTMLCanvasElement.prototype.getContext = original; CanvasRenderingContext2D.prototype.drawImage = originalDraw;
                cleanup.forEach(dispose => dispose());
                watches.forEach(timer => window.clearInterval(timer)); watches.clear();
                if (originalGeolocation) Object.defineProperty(navigator, 'geolocation', originalGeolocation); else delete (navigator as unknown as Record<string, unknown>).geolocation;
                if (documentHidden) Object.defineProperty(document, 'hidden', documentHidden); else delete (document as unknown as Record<string, unknown>).hidden;
                if (oldHook === undefined) delete global.__REACT_DEVTOOLS_GLOBAL_HOOK__; else global.__REACT_DEVTOOLS_GLOBAL_HOOK__ = oldHook;
            },
        };
    });
}

function profile(id: number, avatar: Outfit) {
    return {id, username: `AvatarFixture${id}`, caps: 123, score: 456, title: 'Synthetic profile', avatar,
        shop_items: [{id: HEAD_WORKER, name: 'Fixture new head', category: 'head' as const, gender: 'Women' as const, price: 0, is_owned: true}],
        squads: [{id: 900001, name: 'Synthetic squad', icon: 'beer', color: '#F59E0B'}], unlocked_badges: [],
        stats: {aperos_created: 0, aperos_joined: 0, aperos_declined: 0, aperos_missed: 0, fraud_count: 0}};
}
export async function avatarFixture(context: BrowserContext, options: {own?: Outfit; contacts?: Outfit[]; delayModels?: boolean} = {}) {
    await assertAvatarCandidate();
    await installAvatarGraphics(context);
    const own = profile(900001, options.own ?? WORKER);
    const contacts = (options.contacts ?? OUTFITS).map((outfit, index) => profile(900006 + index, outfit));
    const senders = [profile(900101, WORKER), profile(900102, SCIFI), profile(900103, {...SCIFI, head: HEAD_WORKER})];
    const controls = {failedModels: new Set<string>(), criticalFailed: false, deferredFailed: false, released: !options.delayModels,
        requests: [] as string[], failedRequests: [] as string[]};
    let release!: () => void; const gate = new Promise<void>(resolveGate => {release = resolveGate;});
    const fixtures = await installUxFixtures(context, {assets: true, profileMode: 'own', simulations: [
        {method: 'GET', path: /^\/api\/auth\/profile(?:\/\d+)?$/, respond: route => {
            const match = new URL(route.request().url()).pathname.match(/profile\/(\d+)/);
            const selected = match ? [own, ...contacts, ...senders].find(profile => profile.id === Number(match[1])) : own;
            return route.fulfill({json: selected ?? own});
        }},
        {method: 'GET', path: '/api/auth/connections', respond: route => route.fulfill({json: contacts})},
    ]});
    await context.route('**/models/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/models/prepared/manifest.json') return route.fulfill({status: 404, body: 'Production FBX fallback'});
        const name = path.slice('/models/'.length).replace(/\.fbx$/, '');
        if (['Bar', 'Swimming_pool', 'Floaty_Island'].includes(name)) return route.fulfill({status: 503, body: 'World preparation intentionally isolated'});
        if (!hashes[name]) {fixtures.failures.push(`Unexpected avatar model: ${path}`); return route.abort();}
        controls.requests.push(`${name}.fbx`);
        if (!controls.released) await gate;
        if (controls.failedModels.has(`${name}.fbx`)) {controls.failedRequests.push(path); return route.fulfill({status: 503, body: 'Synthetic model failure'});}
        const bytes = await readFile(resolve(backend, 'static/models', `${name}.fbx`));
        expect(digest(bytes), `Model bytes for ${name}`).toBe(hashes[name]);
        return route.fulfill({contentType: 'application/octet-stream', body: bytes});
    });
    const manifest = JSON.parse(await readFile(resolve(frontend, 'public/animations/manifest.json'), 'utf8')) as {critical: {url: string}; deferred: {url: string}};
    await context.route('**/animations/**', route => {
        const path = new URL(route.request().url()).pathname;
        if ((path === manifest.critical.url && controls.criticalFailed) || (path === manifest.deferred.url && controls.deferredFailed)) {
            controls.failedRequests.push(path); return route.fulfill({status: 503, body: 'Synthetic animation failure'});
        }
        return route.fallback();
    });
    // Browser E2E image has no Firebase credentials by design. Inject synthetic
    // messages into the real hook state, not DOM/fake portraits. Transport is
    // separately covered by unit tests; no Firebase connection/write is needed.
    const messages = Array.from({length: 30}, (_, index) => ({id: `avatar-message-${index}`, userId: senders[index % 3].id,
        username: `Synthetic sender ${index % 3}`, text: `Avatar fixture message ${index}`, timestamp: 1_700_000_000_000 + index * 1000}));
    return {
        ...fixtures, controls, newHead: HEAD_WORKER,
        releaseModels() {controls.released = true; release();},
        async seedChat(page: Page) {
            await page.locator('textarea').waitFor();
            await page.getByText('Erreur de connexion au chat', {exact: true}).waitFor();
            await page.evaluate(messages => window.__avatarGraphics.seedMessages(messages), messages);
            await page.getByText('Avatar fixture message 29', {exact: true}).waitFor();
        },
        async finish(page: Page) {
            // R3F reports a rejected loader promise as pageerror even when the
            // avatar boundary presents its local retry. Accept only the exact
            // 503s this fixture actually injected; keep every other error fatal.
            const injectedErrors = new Set(controls.failedRequests.filter(path => path.startsWith('/models/')).map(path =>
                `Could not load ${path}: fetch for "http://127.0.0.1:8080${path}" responded with 503: Service Unavailable`));
            expect(fixtures.failures, 'Aucune requête non simulée').toEqual([]);
            expect(fixtures.pageErrors.filter(error => !injectedErrors.has(error)), 'Aucune erreur applicative hors panne injectée').toEqual([]);
            await page.evaluate(() => window.__avatarGraphics.cleanup());
        },
    };
}

export const THUMBNAILS = '[data-testid^="avatar-thumb-"] [data-avatar-cell]';
export const PROFILE = '[data-avatar-view-name="profile"] [data-avatar-cell]';
export const PLAYER = '[data-avatar-view-name="dashboard"] [data-avatar-cell]';
export const HEADS = '[data-avatar-view-name="chat-head"] [data-avatar-cell]';
// Approved protocol: at 320x568 the third portrait begins at y=581.
// Never wait for an offscreen cell as if it were visible. The separate middle
// position below still requires three simultaneous, genuinely clipped cells.
export async function connectionsAtTop(page: Page) {
    await expect(page.getByTestId('connections-scrollport')).toHaveJSProperty('scrollTop', 0);
    const compact = page.viewportSize()?.height === 568;
    return avatarsVisible(page, THUMBNAILS, compact ? 2 : 3);
}
export async function threeConnectionsVisible(page: Page) {
    if (page.viewportSize()?.height === 568) {
        await page.getByTestId('connections-scrollport').evaluate(node => {node.scrollTop = 128;});
    }
    return avatarsVisible(page, THUMBNAILS, 3);
}
export function assertRealAvatar(proof: AvatarPixelProof) {
    expect(proof.state).toBe('frame-ready'); expect(proof.current).toBe(true); expect(proof.ready).toBe(true);
    expect(proof.opaque).toBeGreaterThan(10); expect(proof.colors).toBeGreaterThan(2);
    expect(proof.meshes).toBeGreaterThan(0); expect(proof.calls).toBeGreaterThan(0); expect(proof.copies).toBeGreaterThan(0);
    expect(proof.corners.length).toBeGreaterThan(0);
    // Check every corner, but avoid thousands of traced assertion events per
    // mesh collection. The per-coordinate maxima preserve the exact bounds.
    expect(proof.corners.every(corner => corner.every(Number.isFinite))).toBe(true);
    expect(Math.max(...proof.corners.map(corner => Math.abs(corner[0])))).toBeLessThanOrEqual(1);
    expect(Math.max(...proof.corners.map(corner => Math.abs(corner[1])))).toBeLessThanOrEqual(1);
    expect(proof.viewMatrix).toHaveLength(16); expect(proof.projectionMatrix).toHaveLength(16);
}
export async function avatarsVisible(page: Page, selector: string, minimum = 1) {
    await page.waitForFunction(({selector, minimum}) => {
        const nodes = window.__avatarGraphics.visible(selector);
        return nodes.length >= minimum && nodes.every(node => node.closest<HTMLElement>('[data-avatar-state]')?.dataset.avatarState === 'frame-ready');
    }, {selector, minimum});
    const proofs = await page.evaluate(selector => window.__avatarGraphics.read(selector), selector);
    expect(proofs.length).toBeGreaterThanOrEqual(minimum); proofs.forEach(assertRealAvatar);
    return proofs;
}
export async function measureNavigation(page: Page, button: Locator, selector: string) {
    await button.evaluate((element, selector) => {
        element.addEventListener('click', () => {
            const global = window as unknown as {__avatarNavigation?: {start: number; elapsed?: number}};
            const sample = {start: performance.now(), elapsed: undefined as number | undefined}; global.__avatarNavigation = sample;
            const check = () => {
                const nodes = window.__avatarGraphics.visible(selector);
                if (nodes.length > 0 && nodes.every(node => node.closest<HTMLElement>('[data-avatar-state]')?.dataset.avatarState === 'frame-ready')) sample.elapsed = performance.now() - sample.start;
                else requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
        }, {capture: true, once: true});
    }, selector);
    await button.click();
    await page.waitForFunction(() => (window as unknown as {__avatarNavigation?: {elapsed?: number}}).__avatarNavigation?.elapsed !== undefined);
    const elapsed = await page.evaluate(() => (window as unknown as {__avatarNavigation: {elapsed: number}}).__avatarNavigation.elapsed);
    // Keep readback out of the measured series. Each navigation still checks
    // its own scene/copy certificate; full presented pixels are checked at the
    // end of the series, and in the separate presence tests.
    const evidence = await page.evaluate(selector => window.__avatarGraphics.read(selector, true, false), selector);
    expect(evidence.length).toBeGreaterThan(0);
    for (const view of evidence) {expect(view.current).toBe(true); expect(view.ready).toBe(true); expect(view.meshes).toBeGreaterThan(0); expect(view.calls).toBeGreaterThan(0);}
    return elapsed;
}
export const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(0.95 * values.length) - 1];
