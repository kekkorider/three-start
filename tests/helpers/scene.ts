import { deltaTime, Fn, fract, If, instanceIndex, instancedArray, time, vec3 } from "three/tsl";
import * as THREE from "three/webgpu";
import { ThreeContextEvents, ThreeStart, type ThreeStartOptions } from "../../src/core";

/** three internals the tests look into. */
export interface RendererAnimation {
	getContext(): AnimationFrameProvider;
	setContext(context: AnimationFrameProvider): void;
	getAnimationLoop(): ((time: number, xrFrame?: unknown) => void) | null;
	setAnimationLoop(callback: ((time: number, xrFrame?: unknown) => void) | null): void;
	start(): void;
	stop(): void;
	_requestId: number | null;
}
interface RendererInternals {
	_animation: RendererAnimation;
	_nodes: { nodeFrame: { deltaTime: number; frameId: number; time: number } } | null;
	xr: { isPresenting: boolean };
	backend: { isWebGPUBackend?: boolean };
}
export const internals = (renderer: THREE.Renderer) => renderer as unknown as RendererInternals;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
/** Average per second between the first and the last timestamp (ms). */
export const rateOf = (stamps: number[]) => (stamps.length - 1) / ((stamps[stamps.length - 1] - stamps[0]) / 1000);
export const within = (stamps: number[], from: number, to: number) => stamps.filter((t) => t >= from && t < to);

export async function measureDisplayHz(): Promise<number> {
	const stamps: number[] = [];
	await new Promise<void>((resolve) => {
		const frame = (t: number) => {
			stamps.push(t);
			if (stamps.length < 61) requestAnimationFrame(frame);
			else resolve();
		};
		requestAnimationFrame(frame);
	});
	return rateOf(stamps);
}

const srgbToLinear = (c: number) => {
	const v = c / 255;
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

export interface PixelSample {
	red: number;
	tslTime: number;
}

/**
 * A `ThreeStart` on a small canvas, wired to observe the render loop and TSL:
 * - every tick records the time, `getDeltaTime()`, three's TSL `deltaTime` / `frameId`;
 * - a compute pass, dispatched on every tick, accumulates TSL `deltaTime` and counts its runs
 *   in a storage buffer that `readGpu()` reads back;
 * - a full-screen mesh shows `fract(time / 2)` in red, so `samplePixels()` can check that a
 *   rendered frame used the current TSL `time`.
 */
export async function createScene(options: ThreeStartOptions = {}, { init = true } = {}) {
	const container = document.createElement("div");
	container.style.cssText = "position:fixed;right:0;bottom:0;width:64px;height:64px";
	document.body.append(container);

	const starter = new ThreeStart(options);
	const { ctx } = starter;
	const renderer = ctx.renderer;
	if (init && options.autoInitRenderer !== false) await renderer.init();

	const rec = {
		ticks: [] as number[],
		ctxDeltas: [] as number[],
		tslDeltas: [] as number[],
		threeFrameIds: [] as number[],
		pixels: [] as PixelSample[],
		errors: [] as unknown[],
	};

	const gpu = instancedArray(2, "float");
	// `compute(1)` still dispatches a whole workgroup: one invocation writes, or the
	// non-atomic `addAssign`s race and sometimes count a run twice.
	const computeNode = Fn(() => {
		If(instanceIndex.equal(0), () => {
			gpu.element(0).addAssign(deltaTime);
			gpu.element(1).addAssign(1);
		});
	})().compute(1);
	const material = new THREE.MeshBasicNodeMaterial();
	material.colorNode = vec3(fract(time.mul(0.5)), 0, 0);
	ctx.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(10, 10), material));
	ctx.camera.position.z = 2;

	ctx.on(ThreeContextEvents.Error, (error) => rec.errors.push(error));
	ctx.on(ThreeContextEvents.Update, () => {
		rec.ticks.push(performance.now());
		rec.ctxDeltas.push(ctx.getDeltaTime() * 1000);
		const nodeFrame = internals(renderer)._nodes?.nodeFrame;
		if (nodeFrame) {
			rec.tslDeltas.push(nodeFrame.deltaTime * 1000);
			rec.threeFrameIds.push(nodeFrame.frameId);
		}
		(renderer as THREE.WebGPURenderer).compute(computeNode);
	});

	let sampleEvery = 0;
	let rendered = 0;
	const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
	ctx.on(ThreeContextEvents.RenderAfter, () => {
		if (!sampleEvery || ++rendered % sampleEvery || !probe) return;
		const canvas = renderer.domElement;
		probe.drawImage(canvas, canvas.width / 2, canvas.height / 2, 1, 1, 0, 0, 1, 1);
		const nodeFrame = internals(renderer)._nodes?.nodeFrame;
		rec.pixels.push({ red: probe.getImageData(0, 0, 1, 1).data[0], tslTime: nodeFrame?.time ?? Number.NaN });
	});

	return {
		starter,
		ctx,
		renderer,
		rec,
		container,
		/** Start, mount, and run the loop for `ms`, then stop it so the counters settle. */
		async run(ms: number) {
			starter.start();
			starter.mount(container);
			await sleep(ms);
			starter.stopLoop();
		},
		/** Sample the rendered centre pixel after every `n`-th render. */
		samplePixels(n: number) {
			sampleEvery = n;
		},
		/** `{ tslDeltaSumMs, computeRuns }` read back from the GPU. */
		async readGpu() {
			const buffer = await (renderer as THREE.WebGPURenderer).getArrayBufferAsync(gpu.value);
			const [tslDeltaSum, computeRuns] = new Float32Array(buffer as ArrayBuffer);
			return { tslDeltaSumMs: tslDeltaSum * 1000, computeRuns };
		},
		/** Largest gap between a sampled pixel and the TSL `time` it should show (0..0.5). */
		pixelError() {
			let worst = 0;
			for (const p of rec.pixels) {
				const d = Math.abs(srgbToLinear(p.red) - ((p.tslTime * 0.5) % 1));
				worst = Math.max(worst, Math.min(d, 1 - d));
			}
			return worst;
		},
		/** Frames three ran its own frame work on (TSL timers, `info`), from the first tick to the last. */
		threeFramesDuringTicks() {
			const ids = rec.threeFrameIds;
			return ids[ids.length - 1] - ids[0];
		},
		threeFrameId() {
			return internals(renderer)._nodes?.nodeFrame.frameId ?? 0;
		},
		isPatched() {
			return internals(renderer)._animation.getContext() !== (globalThis as unknown as AnimationFrameProvider);
		},
		dispose() {
			starter.dispose();
			container.remove();
		},
	};
}

export type TestScene = Awaited<ReturnType<typeof createScene>>;

/** Replays what three's `XRManager` does on session start and end, with a fake session. */
export function fakeXRSession(scene: TestScene) {
	const anim = internals(scene.renderer)._animation;
	const xr = internals(scene.renderer).xr;
	const session: AnimationFrameProvider = {
		requestAnimationFrame: (callback) => requestAnimationFrame((t) => callback(t)),
		cancelAnimationFrame: (id) => cancelAnimationFrame(id),
	};
	let savedContext: AnimationFrameProvider;
	let savedLoop: ReturnType<RendererAnimation["getAnimationLoop"]>;
	return {
		session,
		start() {
			savedContext = anim.getContext();
			savedLoop = anim.getAnimationLoop();
			anim.stop();
			xr.isPresenting = true;
			anim.setAnimationLoop(savedLoop);
			anim.setContext(session);
			anim.start();
		},
		end() {
			xr.isPresenting = false;
			anim.stop();
			anim.setAnimationLoop(savedLoop);
			anim.setContext(savedContext);
			anim.start();
		},
	};
}
