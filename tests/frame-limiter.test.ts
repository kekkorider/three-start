import { afterEach, describe, expect, it, vi } from "vitest";
import { FrameLimiter } from "../src/core/utils/frame-limiter";
import {
	frameSteps,
	maxTicksInWindow,
	simulateDisplay,
	tickRate,
} from "./helpers/simulate-display";

// The schedule alone, fed synthetic rAF timestamps: deterministic and fast.

const DISPLAYS = [30, 60, 75, 90, 120, 144, 165, 240, 59.94];
const LIMITS = [1, 10, 24, 30, 45, 50, 60, 72, 90, 120, 144];

const relErr = (actual: number, expected: number) => Math.abs(actual - expected) / expected;

describe("FrameLimiter: limit below the display rate", () => {
	it.each(DISPLAYS)("%s Hz, no jitter: exact rate, every gap floor/ceil of display frames", (hz) => {
		const failures: string[] = [];
		for (const maxFps of LIMITS.filter((f) => f < hz)) {
			const { ticks } = simulateDisplay({ hz, maxFps });
			const k = hz / maxFps;
			const offPattern = frameSteps(ticks).filter((s) => s < Math.floor(k) || s > Math.ceil(k));
			const rate = tickRate(ticks);
			if (relErr(rate, maxFps) > 0.005) failures.push(`${maxFps} fps: rate ${rate.toFixed(3)}`);
			if (offPattern.length) failures.push(`${maxFps} fps: ${offPattern.length} gaps off floor/ceil(${k.toFixed(2)})`);
			if (maxTicksInWindow(ticks) > Math.ceil(maxFps) + 1) failures.push(`${maxFps} fps: ${maxTicksInWindow(ticks)} ticks in 1 s`);
		}
		expect(failures).toEqual([]);
	});

	it.each(DISPLAYS)("%s Hz, ±1 ms timestamp jitter: exact rate, steady cadence", (hz) => {
		const failures: string[] = [];
		// Past a quarter of a frame the jitter stops being small next to the frame itself.
		const jitter = Math.min(1, 1000 / hz / 4);
		for (const maxFps of LIMITS.filter((f) => f < hz)) {
			const { ticks } = simulateDisplay({ hz, maxFps, jitter });
			const k = hz / maxFps;
			const offPattern = frameSteps(ticks).filter((s) => s < Math.floor(k) || s > Math.ceil(k));
			const rate = tickRate(ticks);
			if (relErr(rate, maxFps) > 0.005) failures.push(`${maxFps} fps: rate ${rate.toFixed(3)}`);
			// Divisors of the display rate must stay perfectly regular; other limits may slip a
			// frame where a display frame sits right at the half-frame boundary.
			const allowed = Number.isInteger(k) ? 0 : ticks.length * 0.02;
			if (offPattern.length > allowed) failures.push(`${maxFps} fps: ${offPattern.length} gaps off floor/ceil(${k.toFixed(2)})`);
		}
		expect(failures).toEqual([]);
	});
});

describe("FrameLimiter: limit at or above the display rate", () => {
	it.each(DISPLAYS)("%s Hz: every display frame ticks", (hz) => {
		const failures: string[] = [];
		for (const maxFps of [Math.ceil(hz * 1.01), 1000, Infinity]) {
			const { ticks, frames } = simulateDisplay({ hz, maxFps, jitter: 1 });
			if (ticks.length !== frames) failures.push(`${maxFps} fps: ${frames - ticks.length} frames skipped`);
		}
		expect(failures).toEqual([]);
	});

	it("limit equal to the display rate skips nothing", () => {
		for (const hz of [60, 120, 144]) {
			const { ticks, frames } = simulateDisplay({ hz, maxFps: hz, jitter: 1 });
			expect(ticks.length, `${hz} Hz`).toBe(frames);
		}
	});

	it("a display slightly faster than the limit drops only what the limit requires", () => {
		// 60.05 Hz at maxFps 60: 3 extra frames a minute must go.
		const { ticks, frames } = simulateDisplay({ hz: 60.05, maxFps: 60, jitter: 0.5, seconds: 60 });
		const skipped = frames - ticks.length;
		expect(skipped).toBeGreaterThanOrEqual(3);
		expect(skipped).toBeLessThanOrEqual(5);
	});
});

describe("FrameLimiter: irregular frames", () => {
	it.each([60, 120, 144])("%s Hz with 3%% dropped frames: rate holds, no 1 s burst", (hz) => {
		for (const maxFps of [10, 24, 30, 45, 60, 90].filter((f) => f <= hz)) {
			const { ticks } = simulateDisplay({ hz, maxFps, jitter: 0.5, dropRate: 0.03 });
			const expected = Math.min(maxFps, hz * 0.97);
			expect(relErr(tickRate(ticks), expected), `${maxFps} fps rate`).toBeLessThan(0.035);
			expect(maxTicksInWindow(ticks), `${maxFps} fps window`).toBeLessThanOrEqual(Math.ceil(maxFps) + 2);
		}
	});

	it.each([60, 120, 144])("%s Hz after a 3 s gap (hidden tab): no catch-up burst", (hz) => {
		for (const maxFps of [10, 30, 60].filter((f) => f <= hz)) {
			const { ticks } = simulateDisplay({ hz, maxFps, jitter: 0.5, seconds: 8, gapAt: 2000 });
			const resumed = ticks.findIndex((t, i) => i > 0 && t.ts - ticks[i - 1].ts > 2000);
			expect(resumed, `${maxFps} fps: gap present`).toBeGreaterThan(0);
			const inHalfSecond = ticks.slice(resumed).filter((t) => t.ts - ticks[resumed].ts < 500).length;
			expect(inHalfSecond, `${maxFps} fps`).toBeLessThanOrEqual(Math.ceil(maxFps * 0.5) + 1);
		}
	});

	it.each([
		[60, 144],
		[144, 60],
		[120, 60],
	])("display rate changes %s → %s Hz (window moved): cadence recovers", (hz, hzAfter) => {
		const { ticks } = simulateDisplay({ hz, hzAfter, hzSwitchAt: 3000, maxFps: 30, jitter: 0.5, seconds: 8 });
		const after = ticks.filter((t) => t.ts > 1000 + 3500);
		expect(relErr(tickRate(after), 30)).toBeLessThan(0.01);
		const k = hzAfter / 30;
		const offPattern = frameSteps(after).filter((s) => s < Math.floor(k) || s > Math.ceil(k));
		expect(offPattern).toEqual([]);
	});
});

describe("FrameLimiter: changing maxFps", () => {
	const cases: [number, number][] = [
		[10, 60],
		[60, 10],
		[1, 30],
		[30, Infinity],
		[Infinity, 24],
		[24, 1],
		[50, 45],
	];
	it.each([60, 120, 144])("%s Hz: the new limit applies from the next tick", (hz) => {
		for (const [from, to] of cases) {
			const { ticks } = simulateDisplay({ hz, maxFps: from, switchAt: 3000, switchTo: to, jitter: 0.5, seconds: 6 });
			const before = ticks.filter((t) => t.ts < 4000);
			const after = ticks.filter((t) => t.ts >= 4000);
			const expected = Math.min(to, hz);
			const firstGap = after[0].ts - before[before.length - 1].ts;
			const longestInterval = 1000 / Math.min(from, to, hz);
			expect(relErr(tickRate(after), expected), `${from}→${to} rate`).toBeLessThan(0.01);
			expect(firstGap, `${from}→${to} first tick`).toBeLessThanOrEqual(longestInterval + 1000 / hz + 2);
		}
	});

	it("restart() makes the next tick due one interval later", () => {
		const limiter = new FrameLimiter();
		limiter.maxFps = 30;
		limiter.restart(1000);
		const ticked: number[] = [];
		for (let frame = 1; frame <= 6; frame++) {
			const ts = 1000 + (frame * 1000) / 60;
			if (!limiter.shouldSkip(ts)) ticked.push(ts);
		}
		expect(ticked.map((t) => Math.round(t - 1000))).toEqual([33, 67, 100]);
	});
});

describe("FrameLimiter: maxFps validation", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each([0, -5, Number.NaN, undefined, null])("%s warns and falls back to Infinity", (value) => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const limiter = new FrameLimiter();
		limiter.maxFps = value as unknown as number;
		expect(limiter.maxFps).toBe(Infinity);
		expect(warn).toHaveBeenCalledOnce();
	});

	it("keeps positive values, fractional ones included", () => {
		const limiter = new FrameLimiter();
		for (const v of [0.5, 24, 1000, Infinity]) {
			limiter.maxFps = v;
			expect(limiter.maxFps).toBe(v);
		}
	});
});
