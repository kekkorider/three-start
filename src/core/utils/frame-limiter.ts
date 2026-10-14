/** Display frames sampled to estimate the display frame period. */
const FRAME_PERIOD_SAMPLES = 8;
/** Frame deltas longer than this (ms) are gaps — a hidden tab, a stall — not display frames. */
const MAX_FRAME_PERIOD_MS = 100;

/**
 * @internal The `maxFps` schedule of the render loop: given the rAF timestamp of every display
 * frame, decides which of them a loop tick runs on. Knows nothing about rendering, so it can
 * be driven by synthetic timestamps.
 */
export class FrameLimiter {
	/** Upper limit of ticks per second; `Infinity` = every display frame. Non-positive values warn and fall back to `Infinity`. */
	get maxFps(): number {
		return this._maxFps;
	}

	set maxFps(value: number) {
		if (!(value > 0)) {
			console.warn(`[three-start] maxFps must be a positive number, got ${value}; using Infinity`);
			value = Infinity;
		}
		this._maxFps = value;
		this._interval = value === Infinity ? 0 : 1000 / value;
	}

	private _maxFps = Infinity;
	/** ms between ticks; `0` — no limit. */
	private _interval = 0;
	/** Scheduled time of the last tick, in rAF timestamps. */
	private _lastTickAt = 0;
	/** Timestamp of the last display frame seen; `-1` — none yet. */
	private _prevFrameAt = -1;
	/** Ring of recent display frame deltas (ms). */
	private readonly _frameDeltas = new Float64Array(FRAME_PERIOD_SAMPLES);
	private readonly _sortedDeltas = new Float64Array(FRAME_PERIOD_SAMPLES);
	private _frameDeltaIndex = 0;
	private _frameDeltaCount = 0;

	/** Starts the schedule from a tick that ran regardless of the limit — the first one after `runLoop()`. */
	restart(timestamp: number): void {
		this._lastTickAt = timestamp;
		this._sampleFramePeriod(timestamp);
	}

	/** `true` when the limit leaves this display frame out; `false` — a tick runs on it. Call once per display frame. */
	shouldSkip(timestamp: number): boolean {
		const halfFrame = this._sampleFramePeriod(timestamp) / 2;
		const interval = this._interval;
		if (interval === 0) {
			this._lastTickAt = timestamp;
			return false;
		}
		// A tick goes to the display frame nearest its due time. rAF timestamps jitter by a
		// millisecond or two, so an exact comparison would randomly push a tick a frame late.
		if (timestamp - this._lastTickAt < interval - halfFrame) return true;
		// Keep the cadence on the schedule; after a long gap (raised limit, hidden tab) start anew.
		this._lastTickAt += interval;
		if (timestamp - this._lastTickAt > interval) this._lastTickAt = timestamp;
		return false;
	}

	/**
	 * Records a display frame and returns the display frame period estimate (ms): the median
	 * of recent frame deltas, so neither jitter nor dropped frames sway it.
	 */
	private _sampleFramePeriod(timestamp: number): number {
		const delta = timestamp - this._prevFrameAt;
		this._prevFrameAt = timestamp;
		if (delta > 0 && delta < MAX_FRAME_PERIOD_MS) {
			this._frameDeltas[this._frameDeltaIndex] = delta;
			this._frameDeltaIndex = (this._frameDeltaIndex + 1) % FRAME_PERIOD_SAMPLES;
			if (this._frameDeltaCount < FRAME_PERIOD_SAMPLES) this._frameDeltaCount++;
		}
		const count = this._frameDeltaCount;
		if (count === 0) return 0;
		// Until the ring fills up, only its first `count` slots hold samples.
		const sorted =
			count === FRAME_PERIOD_SAMPLES ? this._sortedDeltas : this._sortedDeltas.subarray(0, count);
		for (let i = 0; i < count; i++) sorted[i] = this._frameDeltas[i];
		sorted.sort();
		return sorted[count >> 1];
	}
}
