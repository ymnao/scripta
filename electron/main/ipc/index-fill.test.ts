// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import {
	_cancelAllIdleFillForTest,
	_isRunningForTest,
	type IdleFillDeps,
	kickIdleFill,
} from "./index-fill";

const ROOT = "/ws/notes";

interface FakeIndexHandle {
	indexFile(path: string, text: string, capturedEpoch: number): void;
	currentEpochOf(path: string): number;
	isIndexedAndValid(path: string): boolean;
	readonly isDisabled: boolean;
}

function makeFakeDeps(
	initialFiles: string[],
	texts: Map<string, string>,
): {
	deps: IdleFillDeps;
	indexed: Map<string, number>;
	currentEpoch: Map<string, number>;
	alive: { value: boolean };
	disabled: { value: boolean };
} {
	const indexed = new Map<string, number>(); // path → captured epoch (record)
	const currentEpoch = new Map<string, number>();
	const alive = { value: true };
	const disabled = { value: false };

	const index: FakeIndexHandle = {
		indexFile: (p: string, _text: string, captured: number) => {
			if ((currentEpoch.get(p) ?? 0) !== captured) return; // race skip
			indexed.set(p, captured);
		},
		currentEpochOf: (p: string) => currentEpoch.get(p) ?? 0,
		isIndexedAndValid: (p: string) => indexed.get(p) === (currentEpoch.get(p) ?? 0),
		get isDisabled(): boolean {
			return disabled.value;
		},
	};

	const deps: IdleFillDeps = {
		listIoFiles: () => initialFiles,
		readFile: async (p: string) => texts.get(p) ?? "",
		isAlive: () => alive.value,
		getIndex: () => (alive.value ? index : undefined),
		yieldTick: async () => {}, // test では即座 resolve
	};

	return { deps, indexed, currentEpoch, alive, disabled };
}

afterEach(() => {
	_cancelAllIdleFillForTest();
});

describe("index-fill: kickIdleFill", () => {
	it("kick 冪等性: 同時に 2 回 kick しても実 fill は 1 度のみ", async () => {
		const texts = new Map([
			["/ws/notes/a.md", "aaa"],
			["/ws/notes/b.md", "bbb"],
		]);
		const { deps } = makeFakeDeps(["/ws/notes/a.md", "/ws/notes/b.md"], texts);
		kickIdleFill(ROOT, deps);
		expect(_isRunningForTest(ROOT)).toBe(true);
		// 2 回目の kick は no-op (既存 state を再利用)
		kickIdleFill(ROOT, deps);
		expect(_isRunningForTest(ROOT)).toBe(true);
		// 完了を待つ
		await waitUntil(() => !_isRunningForTest(ROOT));
		expect(_isRunningForTest(ROOT)).toBe(false);
	});

	it("fill 進行: 3 file 中未 indexed のものが全て indexed になる", async () => {
		const files = ["/ws/notes/a.md", "/ws/notes/b.md", "/ws/notes/c.md"];
		const texts = new Map(files.map((f) => [f, `text of ${f}`]));
		const { deps, indexed } = makeFakeDeps(files, texts);
		kickIdleFill(ROOT, deps);
		await waitUntil(() => !_isRunningForTest(ROOT));
		for (const f of files) {
			expect(indexed.has(f)).toBe(true);
		}
	});

	it("workspace release で bail: isAlive() が false になったら次 tick で停止", async () => {
		const files = ["/ws/notes/a.md", "/ws/notes/b.md", "/ws/notes/c.md", "/ws/notes/d.md"];
		const texts = new Map(files.map((f) => [f, `text of ${f}`]));
		const { deps, alive, indexed } = makeFakeDeps(files, texts);
		// TICK_SIZE=4 なので 1 tick で全て indexed されてしまう可能性がある。
		// isAlive を最初の readFile 完了直後に false にするため、readFile 内で反応させる。
		let readCount = 0;
		deps.readFile = async (p: string) => {
			readCount++;
			if (readCount === 1) alive.value = false;
			return texts.get(p) ?? "";
		};
		kickIdleFill(ROOT, deps);
		await waitUntil(() => !_isRunningForTest(ROOT));
		expect(_isRunningForTest(ROOT)).toBe(false);
		// 最初の 1 file の indexFile 呼び出し後、isAlive() チェックで即座に break するはず。
		// 少なくとも全 4 file が indexed されてはいない (bail が効いている)。
		expect(indexed.size).toBeLessThan(files.length);
	});

	it("isDisabled で bail: index が disabled なら fill 停止", async () => {
		const files = ["/ws/notes/a.md", "/ws/notes/b.md"];
		const texts = new Map(files.map((f) => [f, `text of ${f}`]));
		const { deps, disabled, indexed } = makeFakeDeps(files, texts);
		disabled.value = true;
		kickIdleFill(ROOT, deps);
		await waitUntil(() => !_isRunningForTest(ROOT));
		expect(indexed.size).toBe(0);
	});

	it("read 中 invalidation で epoch 不一致 → indexFile が no-op", async () => {
		const files = ["/ws/notes/a.md"];
		const texts = new Map([["/ws/notes/a.md", "aaa"]]);
		const { deps, currentEpoch, indexed, alive } = makeFakeDeps(files, texts);
		let readCount = 0;
		deps.readFile = async (p: string) => {
			readCount++;
			if (readCount === 1) {
				// 1 回目の read 中にのみ invalidation が起きて epoch が進んだ状態を模す。
				currentEpoch.set(p, (currentEpoch.get(p) ?? 0) + 1);
			} else {
				// 2 回目以降 (再 tick での retry) は workspace を release して無限ループを防ぐ
				// (このテストの主張は「1 回の race で no-op になること」のみで、
				// retry の収束性は別テストの範囲)。
				alive.value = false;
			}
			return texts.get(p) ?? "";
		};
		kickIdleFill(ROOT, deps);
		await waitUntil(() => !_isRunningForTest(ROOT));
		// captured (0) != current (1) なので indexFile は no-op
		expect(indexed.has("/ws/notes/a.md")).toBe(false);
		expect(readCount).toBeGreaterThanOrEqual(1);
	});

	it("全 file valid = 即完了: picked=0 で exit、running が false になる", async () => {
		const files = ["/ws/notes/a.md"];
		const texts = new Map([["/ws/notes/a.md", "aaa"]]);
		const { deps, indexed, currentEpoch } = makeFakeDeps(files, texts);
		// 事前に valid 状態を作っておく
		indexed.set("/ws/notes/a.md", 0);
		currentEpoch.set("/ws/notes/a.md", 0);
		let readCalled = false;
		deps.readFile = async (p: string) => {
			readCalled = true;
			return texts.get(p) ?? "";
		};
		kickIdleFill(ROOT, deps);
		await waitUntil(() => !_isRunningForTest(ROOT));
		expect(readCalled).toBe(false);
		expect(_isRunningForTest(ROOT)).toBe(false);
	});
});

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}
