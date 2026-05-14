import { createHash } from "crypto";
import { isRecord } from "../utils/guards.js";

const DETERMINISTIC_EPOCH_MS = Date.UTC(2000, 0, 1);

export function canonicalizeUnknown(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => canonicalizeUnknown(typeof entry === "undefined" ? null : entry));
	}

	if (!isRecord(value)) {
		return value;
	}

	return Object.fromEntries(
		Object.keys(value)
			.sort((left, right) => left.localeCompare(right))
			.flatMap((key) => {
				const entry = value[key];
				if (typeof entry === "undefined") {
					return [];
				}

				return [[key, canonicalizeUnknown(entry)] as const];
			})
	);
}

export function stableStringify(value: unknown): string {
	return JSON.stringify(canonicalizeUnknown(value));
}

export function deterministicHash(value: unknown): string {
	return createHash("sha256").update(stableStringify(value), "utf-8").digest("hex");
}

export function deterministicId(prefix: string, payload: unknown, length = 12): string {
	const safeLength = Math.max(6, Math.min(64, Math.floor(length)));
	return `${prefix}-${deterministicHash(payload).slice(0, safeLength)}`;
}

export function stableSortStrings(values: string[]): string[] {
	return [...values].sort((left, right) => left.localeCompare(right));
}

export function stableSortBy<T>(values: T[], keySelector: (value: T) => string): T[] {
	return [...values].sort((left, right) => {
		const keyCompare = keySelector(left).localeCompare(keySelector(right));
		if (keyCompare !== 0) {
			return keyCompare;
		}

		return stableStringify(left).localeCompare(stableStringify(right));
	});
}

function normalizeSeed(seed: number): number {
	const normalized = Math.floor(Math.abs(seed)) >>> 0;
	return normalized === 0 ? 1 : normalized;
}

export type DeterministicContext = {
	seed: number;
	baseTimestamp: number;
	logicalTime: number;
};

export function deterministicContextFromHash(hash: string): DeterministicContext {
	const fixedTimestamp = Number.parseInt(hash.slice(0, 12), 16);
	const seed = Number.parseInt(hash.slice(12, 20), 16);
	return {
		baseTimestamp: Number.isFinite(fixedTimestamp) ? fixedTimestamp : 0,
		seed: normalizeSeed(Number.isFinite(seed) ? seed : 1),
		logicalTime: 0,
	};
}

export function cloneDeterministicContext(context: DeterministicContext): DeterministicContext {
	return {
		seed: normalizeSeed(context.seed),
		baseTimestamp: Math.max(0, Math.floor(context.baseTimestamp)),
		logicalTime: Math.max(0, Math.floor(context.logicalTime)),
	};
}

function nextLogicalTimestamp(context: DeterministicContext): number {
	context.logicalTime = Math.max(0, Math.floor(context.logicalTime)) + 1;
	return Math.max(0, Math.floor(context.baseTimestamp)) + context.logicalTime;
}

export function deterministicTimestampFromCounter(counter: number): string {
	const safeCounter = Math.max(0, Math.floor(counter));
	return new Date(DETERMINISTIC_EPOCH_MS + (safeCounter * 1000)).toISOString();
}

export function deterministicTimestampFromString(input: string): string {
	const hash = deterministicHash({ input });
	const seconds = Number.parseInt(hash.slice(0, 8), 16);
	return deterministicTimestampFromCounter(Number.isFinite(seconds) ? seconds : 0);
}

export class SeededRandom {
	private state: number;

	constructor(seed: number) {
		this.state = normalizeSeed(seed);
	}

	next(): number {
		// xorshift32 with deterministic unsigned arithmetic.
		let x = this.state >>> 0;
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		this.state = normalizeSeed(x >>> 0);
		return this.state / 0x100000000;
	}

	nextInt(maxExclusive: number): number {
		const max = Math.max(1, Math.floor(maxExclusive));
		return Math.floor(this.next() * max);
	}
}
