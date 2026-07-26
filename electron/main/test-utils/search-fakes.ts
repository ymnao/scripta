// テスト fixture: `processMdFilesParallel` の L2 / L3 handle を差し替えるための fake 群。
//
// search-index-gate.test.ts (#413 のゲート) / search-l2-symlink-admission.test.ts (#416 の
// L2 admission) が同型の stub を各自に持っていたので、`InvertedIndexHandle` /
// `ContentCacheHandle` の member が増減したときに 1 箇所だけ直せば済むよう集約する
// (temp-workspace.ts と同じ「散在パターンを test-utils に寄せる」方針)。
//
// 各 test がファイルを分けている理由は path-guard を mock するかどうかであって fixture の
// 形ではないため、この集約は test 間の独立性に影響しない。
import type { ContentCacheHandle, InvertedIndexHandle } from "../ipc/search-cache";

export interface FakeIndex {
	handle: InvertedIndexHandle;
	/** indexFile が呼ばれた file とその内容。 */
	indexed: Map<string, string>;
	/** disabled を test 中に切り替えるための box (handle は getter 経由で読む)。 */
	disabled: { value: boolean };
}

/**
 * `indexFile` された内容を Map に貯めるだけの InvertedIndexHandle fake。
 * `isIndexedAndValid` は「一度でも indexFile された file」を valid とみなす。
 */
export function makeFakeIndex(): FakeIndex {
	const indexed = new Map<string, string>();
	const disabled = { value: false };
	const handle: InvertedIndexHandle = {
		indexFile(ioPath: string, text: string, _capturedEpoch: number): void {
			indexed.set(ioPath, text);
		},
		currentEpochOf(_ioPath: string): number {
			return 0;
		},
		isIndexedAndValid(ioPath: string): boolean {
			return indexed.has(ioPath);
		},
		getCandidates() {
			return { kind: "fallback" } as const;
		},
		verify(): void {},
		collectViolations(): string[] | null {
			return null;
		},
		get isDisabled(): boolean {
			return disabled.value;
		},
	};
	return { handle, indexed, disabled };
}

export interface FakeCache {
	cache: ContentCacheHandle;
	/** cache.set で格納された内容 (admission を通ったもの)。 */
	stored: Map<string, string>;
	/** cache.set に渡された capturedGeneration (stale-insert race 防御の pin 用)。 */
	captured: Map<string, number>;
	/** handle が返す generation。test 中に bump して evict の発生を模す。 */
	generation: { value: number };
}

/**
 * `preloaded` を L2-hit として返し、`set` された内容は `stored` に貯める
 * ContentCacheHandle fake。admission cutoff と generation 判定は **持たない**
 * (呼び手が set を呼んだか / どの generation を渡したかだけを観測するため、
 * 実 handle のように不一致で破棄したりはしない)。
 * `preloaded` 省略時は常に L2-miss になる。
 */
export function makeFakeCache(preloaded: Map<string, string> = new Map()): FakeCache {
	const stored = new Map<string, string>();
	const captured = new Map<string, number>();
	const generation = { value: 0 };
	const cache: ContentCacheHandle = {
		get(ioPath: string): string | undefined {
			return preloaded.get(ioPath);
		},
		set(ioPath: string, text: string, capturedGeneration: number): void {
			stored.set(ioPath, text);
			captured.set(ioPath, capturedGeneration);
		},
		get generation(): number {
			return generation.value;
		},
	};
	return { cache, stored, captured, generation };
}

/** `processMdFilesParallel` の isStale / shouldBail に渡す「打ち切らない」判定。 */
export const never = (): boolean => false;
