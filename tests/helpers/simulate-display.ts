import { FrameLimiter } from "../../src/core/utils/frame-limiter";

export interface DisplayOptions {
	/** Display refresh rate. */
	hz: number;
	maxFps: number;
	seconds?: number;
	/** ± ms of uniform noise on every rAF timestamp. */
	jitter?: number;
	/** Share of display frames the browser drops. */
	dropRate?: number;
	/** ms into the run after which no frames come for `gapMs` (a hidden tab). */
	gapAt?: number;
	gapMs?: number;
	/** ms into the run at which `maxFps` becomes `switchTo`. */
	switchAt?: number;
	switchTo?: number;
	/** ms into the run at which the display rate becomes `hzAfter` (the window moved to another screen). */
	hzSwitchAt?: number;
	hzAfter?: number;
}

export interface SimTick {
	/** Index of the display frame the tick ran on. */
	frame: number;
	/** Its rAF timestamp. */
	ts: number;
}

export interface SimResult {
	ticks: SimTick[];
	/** Display frames the browser delivered. */
	frames: number;
}

/**
 * Feeds a `FrameLimiter` the rAF timestamps of a simulated display, the way the render loop
 * does: the first frame restarts the schedule, every later one asks `shouldSkip`.
 * Deterministic: noise comes from a seeded generator.
 */
export function simulateDisplay(o: DisplayOptions): SimResult {
	const { hz, seconds = 20, jitter = 0, dropRate = 0, gapMs = 3000 } = o;
	let seed = 7;
	const random = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	const limiter = new FrameLimiter();
	limiter.maxFps = o.maxFps;

	const ticks: SimTick[] = [];
	let frames = 0;
	let t = 0;
	let period = 1000 / hz;
	let switched = false;
	for (let frame = 0; t < seconds * 1000; frame++, t += period) {
		if (o.hzSwitchAt !== undefined && o.hzAfter && t >= o.hzSwitchAt) period = 1000 / o.hzAfter;
		if (o.switchAt !== undefined && !switched && t >= o.switchAt) {
			limiter.maxFps = o.switchTo ?? Infinity;
			switched = true;
		}
		if (dropRate && random() < dropRate) continue;
		const gap = o.gapAt !== undefined && t > o.gapAt ? gapMs : 0;
		// Chrome reports rAF timestamps rounded to 0.1 ms.
		const ts = Math.round((1000 + t + gap + (random() * 2 - 1) * jitter) * 10) / 10;
		frames++;
		if (ticks.length === 0) {
			limiter.restart(ts);
			ticks.push({ frame, ts });
		} else if (!limiter.shouldSkip(ts)) {
			ticks.push({ frame, ts });
		}
	}
	return { ticks, frames };
}

/** Average ticks per second between the first and the last tick. */
export function tickRate(ticks: SimTick[]): number {
	return (ticks.length - 1) / ((ticks[ticks.length - 1].ts - ticks[0].ts) / 1000);
}

/** The most ticks any `windowMs` long window holds. */
export function maxTicksInWindow(ticks: SimTick[], windowMs = 1000): number {
	let max = 0;
	for (let i = 0, j = 0; i < ticks.length; i++) {
		while (ticks[i].ts - ticks[j].ts >= windowMs) j++;
		max = Math.max(max, i - j + 1);
	}
	return max;
}

/** Gaps between consecutive ticks, in display frames. */
export function frameSteps(ticks: SimTick[]): number[] {
	return ticks.slice(1).map((t, i) => t.frame - ticks[i].frame);
}
