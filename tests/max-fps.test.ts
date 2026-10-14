import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ThreeContextEvents } from "../src/core";
import {
	createScene,
	fakeXRSession,
	internals,
	measureDisplayHz,
	rateOf,
	sleep,
	sum,
	type TestScene,
	within,
} from "./helpers/scene";

// The render loop on a real WebGPURenderer: frame timing, three's TSL timer nodes, compute and
// rendered output. Frame timing is measured, so assertions leave room for a busy machine.

let hz = 60;
const open: TestScene[] = [];
const scene = async (...args: Parameters<typeof createScene>) => {
	const s = await createScene(...args);
	open.push(s);
	return s;
};

beforeAll(async () => {
	// Warm up: the first WebGPU scene compiles pipelines and drops a few frames doing it.
	const warmup = await createScene();
	await warmup.run(500);
	warmup.dispose();
	hz = await measureDisplayHz();
});

afterEach(() => {
	for (const s of open.splice(0)) s.dispose();
	vi.restoreAllMocks();
});

const close = (actual: number, expected: number, relative: number, absolute = 0) =>
	Math.abs(actual - expected) <= expected * relative + absolute;
/** Measured tick rate within 4% — frame timing on a shared machine wobbles a little. */
const expectRate = (rate: number, expected: number) =>
	expect(close(rate, expected, 0.04), `rate ${rate.toFixed(2)}, expected ${expected.toFixed(2)}`).toBe(true);

it("runs on the WebGPU backend", async () => {
	const s = await scene();
	expect(internals(s.renderer).backend.isWebGPUBackend).toBe(true);
});

describe("maxFps with maxFpsPatchesRenderer (default)", () => {
	it.each([Infinity, 60, 45, 30, 20, 10])("maxFps %s: ticks, TSL timers, compute and rendered frames follow the limit", async (maxFps) => {
		const s = await scene({ maxFps });
		s.samplePixels(3);
		await s.run(1500);
		const { tslDeltaSumMs, computeRuns } = await s.readGpu();
		const { ticks, ctxDeltas } = s.rec;
		const ctxSum = sum(ctxDeltas);
		const span = ticks[ticks.length - 1] - ticks[0];

		// three.js is patched only once a limit is set
		expect(s.isPatched(), "patched").toBe(maxFps !== Infinity);
		expectRate(rateOf(ticks), Math.min(maxFps, hz));
		expect(close(ctxSum, span, 0.03, 40), `getDeltaTime sum ${ctxSum} vs wall ${span}`).toBe(true);
		// TSL deltaTime covers the skipped frames just like getDeltaTime()
		expect(close(tslDeltaSumMs, ctxSum, 0.03, 40), `TSL ${tslDeltaSumMs} vs ctx ${ctxSum}`).toBe(true);
		// three's own frame work runs only on ticks
		expect(s.threeFramesDuringTicks(), `three frames, ids ${s.rec.threeFrameIds.join(",")}`).toBe(ticks.length - 1);
		expect(computeRuns, "compute runs").toBe(ticks.length);
		// rendered frames show the TSL time of their tick
		expect(s.rec.pixels.length, "pixel samples").toBeGreaterThan(3);
		expect(s.pixelError(), "pixel error").toBeLessThan(0.03);
		expect(s.rec.errors).toEqual([]);
	});
});

describe("maxFps with maxFpsPatchesRenderer: false", () => {
	it.each([60, 30, 10])("maxFps %s: ticks follow the limit, three keeps every display frame", async (maxFps) => {
		const s = await scene({ maxFps, maxFpsPatchesRenderer: false });
		await s.run(1500);
		const { tslDeltaSumMs, computeRuns } = await s.readGpu();
		const { ticks, ctxDeltas } = s.rec;
		const ctxSum = sum(ctxDeltas);
		const span = ticks[ticks.length - 1] - ticks[0];
		const displayFrames = span / (1000 / hz);

		expect(s.isPatched(), "patched").toBe(false);
		expectRate(rateOf(ticks), Math.min(maxFps, hz));
		expect(close(ctxSum, span, 0.03, 40), `getDeltaTime sum ${ctxSum} vs wall ${span}`).toBe(true);
		expect(computeRuns, "compute runs").toBe(ticks.length);
		// documented fallback: TSL deltaTime measures one display frame, three runs every frame
		expect(tslDeltaSumMs, `TSL ${tslDeltaSumMs} vs ctx ${ctxSum}`).toBeLessThan(ctxSum * (Math.min(maxFps, hz) / hz) * 1.3 + 40);
		const threeFrames = s.threeFramesDuringTicks();
		expect(close(threeFrames, displayFrames, 0.1), `three frames ${threeFrames} vs display frames ${displayFrames.toFixed(1)}`).toBe(true);
	});
});

describe("when maxFpsPatchesRenderer patches three.js", () => {
	it("without maxFps three.js is left untouched", async () => {
		const s = await scene();
		await s.run(500);
		expect(s.isPatched()).toBe(false);
		expect(s.rec.ticks.length).toBeGreaterThan(hz * 0.4);
	});

	it("a limit set while the loop runs patches from the next frame; Infinity again lets every frame through", async () => {
		const s = await scene();
		s.starter.start();
		s.starter.mount(s.container);
		await sleep(500);
		expect(s.isPatched(), "before the limit").toBe(false);

		s.ctx.maxFps = 20;
		const limitedAt = performance.now();
		const firstLimitedTick = s.rec.ticks.length;
		await sleep(1000);
		expect(s.isPatched(), "after the limit").toBe(true);
		const limited = within(s.rec.ticks, limitedAt + 150, performance.now());
		expectRate(rateOf(limited), 20);
		// past the switch, three's frame work and TSL deltaTime follow the ticks
		const ids = s.rec.threeFrameIds.slice(firstLimitedTick + 2);
		expect(ids[ids.length - 1] - ids[0], `three frame ids ${ids.join(",")}`).toBe(ids.length - 1);
		const tsl = s.rec.tslDeltas.slice(firstLimitedTick + 2);
		const ctx = s.rec.ctxDeltas.slice(firstLimitedTick + 2);
		expect(close(sum(tsl), sum(ctx), 0.03, 20), `TSL ${sum(tsl)} vs ctx ${sum(ctx)}`).toBe(true);

		s.ctx.maxFps = Infinity;
		const unlimitedAt = performance.now();
		await sleep(800);
		s.starter.stopLoop();
		expect(s.isPatched(), "patch stays").toBe(true);
		expectRate(rateOf(within(s.rec.ticks, unlimitedAt + 150, performance.now())), hz);
	});
});

describe("render loop scenarios", () => {
	it("maxFps changes while the loop runs: 60 → 10 → Infinity → 30", async () => {
		const s = await scene({ maxFps: 60 });
		s.starter.start();
		s.starter.mount(s.container);
		const marks: [number, number][] = [];
		for (const maxFps of [60, 10, Infinity, 30]) {
			s.ctx.maxFps = maxFps;
			marks.push([maxFps, performance.now()]);
			await sleep(1000);
		}
		const end = performance.now();
		s.starter.stopLoop();
		marks.forEach(([maxFps, from], i) => {
			const segment = within(s.rec.ticks, from + 150, marks[i + 1]?.[1] ?? end);
			expect(close(rateOf(segment), Math.min(maxFps, hz), 0.05), `segment ${maxFps}`).toBe(true);
		});
		const { tslDeltaSumMs } = await s.readGpu();
		expect(close(tslDeltaSumMs, sum(s.rec.ctxDeltas), 0.02, 30)).toBe(true);
	});

	it("stopLoop / runLoop: no ticks while stopped, no delay or long delta after", async () => {
		const s = await scene({ maxFps: 30 });
		s.starter.start();
		s.starter.mount(s.container);
		await sleep(500);
		s.starter.stopLoop();
		const stoppedAt = s.rec.ticks.length;
		await sleep(500);
		expect(s.rec.ticks.length).toBe(stoppedAt);
		const restartedAt = performance.now();
		s.starter.runLoop();
		await sleep(1000);
		const after = s.rec.ticks.slice(stoppedAt);
		expect(after[0] - restartedAt).toBeLessThan(2 * (1000 / hz) + 10);
		expect(s.rec.ctxDeltas[stoppedAt]).toBeLessThan(1000 / hz + 10);
		expectRate(rateOf(after), Math.min(30, hz));
	});

	it("manageLoopManually: patched and limited from the manual runLoop()", async () => {
		const s = await scene({ maxFps: 20, manageLoopManually: true });
		s.starter.start();
		s.starter.mount(s.container);
		await sleep(300);
		expect(s.rec.ticks).toEqual([]);
		expect(s.isPatched()).toBe(false);
		s.starter.runLoop();
		await sleep(1000);
		expect(s.isPatched()).toBe(true);
		expectRate(rateOf(s.rec.ticks), 20);
		expect(s.threeFramesDuringTicks()).toBe(s.rec.ticks.length - 1);
	});

	it("autoInitRenderer: false: patched once init() resolves inside runLoop()", async () => {
		const s = await scene({ maxFps: 30, autoInitRenderer: false }, { init: false });
		expect(s.renderer.initialized).toBe(false);
		await s.run(1500);
		const { tslDeltaSumMs } = await s.readGpu();
		expect(s.isPatched()).toBe(true);
		expectRate(rateOf(s.rec.ticks), Math.min(30, hz));
		expect(s.threeFramesDuringTicks()).toBe(s.rec.ticks.length - 1);
		expect(close(tslDeltaSumMs, sum(s.rec.ctxDeltas), 0.03, 40)).toBe(true);
	});

	it.each([1, 30, Infinity])("dispose() at maxFps %s restores three's rAF provider and stops its loop", async (maxFps) => {
		const s = await createScene({ maxFps });
		s.starter.start();
		s.starter.mount(s.container);
		await sleep(400);
		const anim = internals(s.renderer)._animation;
		const ticks = s.rec.ticks.length;
		s.dispose();
		expect(anim.getContext()).toBe(globalThis);
		expect(anim._requestId).toBeNull();
		const frameId = s.threeFrameId();
		await sleep(300);
		expect(s.threeFrameId()).toBe(frameId);
		expect(s.rec.ticks.length).toBe(ticks);
	});

	it("create / dispose cycles leave no rAF loop behind", async () => {
		const count = async () => {
			let calls = 0;
			const original = window.requestAnimationFrame;
			window.requestAnimationFrame = (cb) => {
				calls++;
				return original.call(window, cb);
			};
			await sleep(500);
			window.requestAnimationFrame = original;
			return calls;
		};
		const baseline = await count();
		for (let i = 0; i < 8; i++) {
			const s = await createScene({ maxFps: 15 });
			s.starter.start();
			s.starter.mount(s.container);
			await sleep(60);
			s.dispose();
		}
		expect(await count()).toBeLessThanOrEqual(baseline + 3);
	});

	it.each([true, false])("WebXR session (maxFpsPatchesRenderer: %s): unlimited during, limited after", async (patch) => {
		const s = await scene({ maxFps: 30, maxFpsPatchesRenderer: patch });
		s.starter.start();
		s.starter.mount(s.container);
		await sleep(600);
		const xr = fakeXRSession(s);
		const anim = internals(s.renderer)._animation;
		const providerBefore = anim.getContext();
		const t0 = performance.now();
		const f0 = s.threeFrameId();
		xr.start();
		await sleep(1000);
		const t1 = performance.now();
		const f1 = s.threeFrameId();
		xr.end();
		await sleep(1000);
		const t2 = performance.now();
		s.starter.stopLoop();

		expectRate(rateOf(within(s.rec.ticks, t0 + 50, t1)), hz);
		// one three loop during the session, not the session's plus a leftover one
		expect(close((f1 - f0) / ((t1 - t0) / 1000), hz, 0.1)).toBe(true);
		expectRate(rateOf(within(s.rec.ticks, t1 + 150, t2)), Math.min(30, hz));
		expect(anim.getContext()).toBe(providerBefore);
		expect(s.rec.ctxDeltas.every(Number.isFinite)).toBe(true);
		expect(s.rec.errors).toEqual([]);
	});

	it("WebXR session already presenting at runLoop(): unlimited, patched on a later runLoop()", async () => {
		const s = await scene({ maxFps: 30, manageLoopManually: true });
		s.starter.start();
		s.starter.mount(s.container);
		const xr = fakeXRSession(s);
		xr.start();
		s.starter.runLoop();
		await sleep(1000);
		expectRate(rateOf(s.rec.ticks.slice(3)), hz);
		expect(internals(s.renderer)._animation.getContext()).toBe(xr.session);
		xr.end();
		// three restores the loop it saved when the session started — none here — so restart ours
		s.starter.stopLoop();
		s.starter.runLoop();
		const t1 = performance.now();
		await sleep(1000);
		expect(s.isPatched()).toBe(true);
		expectRate(rateOf(within(s.rec.ticks, t1 + 150, performance.now())), Math.min(30, hz));
	});

	it("two ThreeStart instances keep their own limits", async () => {
		const a = await scene({ maxFps: 30 });
		const b = await scene({ maxFps: 15 });
		b.container.style.right = "70px";
		a.starter.start();
		a.starter.mount(a.container);
		b.starter.start();
		b.starter.mount(b.container);
		await sleep(1500);
		a.starter.stopLoop();
		b.starter.stopLoop();
		expectRate(rateOf(a.rec.ticks), Math.min(30, hz));
		expectRate(rateOf(b.rec.ticks), 15);
		expect(close((await a.readGpu()).tslDeltaSumMs, sum(a.rec.ctxDeltas), 0.03, 40)).toBe(true);
		expect(close((await b.readGpu()).tslDeltaSumMs, sum(b.rec.ctxDeltas), 0.03, 40)).toBe(true);
	});

	it("a throwing Update listener doesn't break the limit", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const s = await scene({ maxFps: 30 });
		s.ctx.on(ThreeContextEvents.Update, () => {
			throw new Error("boom");
		});
		await s.run(1000);
		expectRate(rateOf(s.rec.ticks), Math.min(30, hz));
		expect(s.rec.errors.length).toBeGreaterThanOrEqual(s.rec.ticks.length - 1);
	});

	it("a renderer without three's animation API falls back to skipping in the loop", async () => {
		const s = await scene({ maxFps: 20, manageLoopManually: true });
		const anim = internals(s.renderer)._animation as unknown as Record<string, unknown>;
		anim.getContext = undefined;
		s.starter.start();
		s.starter.mount(s.container);
		s.starter.runLoop();
		await sleep(1000);
		s.starter.stopLoop();
		delete anim.getContext;
		const { tslDeltaSumMs } = await s.readGpu();
		expectRate(rateOf(s.rec.ticks), 20);
		expect(tslDeltaSumMs).toBeLessThan(sum(s.rec.ctxDeltas) * (20 / hz) * 1.3 + 40);
		expect(s.rec.errors).toEqual([]);
	});

	it("timescale scales getDeltaTime() but not TSL timers, as documented", async () => {
		const s = await scene({ maxFps: 30 });
		s.ctx.setTimescale(0.5);
		await s.run(1500);
		const { tslDeltaSumMs } = await s.readGpu();
		const span = s.rec.ticks[s.rec.ticks.length - 1] - s.rec.ticks[0];
		expect(close(sum(s.rec.ctxDeltas.slice(1)), span * 0.5, 0.03, 20)).toBe(true);
		expect(close(tslDeltaSumMs, span, 0.04, 40)).toBe(true);
	});

	it("a 500 ms main-thread stall: one long delta, no burst after", async () => {
		const s = await scene({ maxFps: 30 });
		s.starter.start();
		s.starter.mount(s.container);
		await sleep(500);
		const t = performance.now();
		while (performance.now() - t < 500) {
			// block the main thread
		}
		const resumed = performance.now();
		await sleep(1000);
		expect(within(s.rec.ticks, resumed, resumed + 300).length).toBeLessThanOrEqual(Math.ceil(Math.min(30, hz) * 0.3) + 2);
		expectRate(rateOf(within(s.rec.ticks, resumed + 300, performance.now())), Math.min(30, hz));
		expect(Math.max(...s.rec.ctxDeltas)).toBeGreaterThan(450);
	});

	it("ctx.render() with the loop stopped renders the current TSL time", async () => {
		const s = await scene({ maxFps: 10, manageLoopManually: true });
		s.starter.start();
		s.starter.mount(s.container);
		s.samplePixels(1);
		await sleep(200);
		const before = s.rec.pixels.length;
		s.ctx.render();
		await sleep(300);
		s.ctx.render();
		const [first, second] = s.rec.pixels.slice(before);
		expect(s.rec.pixels.length - before).toBe(2);
		expect(second.tslTime).toBeGreaterThan(first.tslTime);
		expect(s.pixelError()).toBeLessThan(0.03);
	});
});
