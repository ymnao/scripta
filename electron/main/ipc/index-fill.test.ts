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
		index,
		yieldTick: async () => {}, // test では即座 resolve
		isRealPathAllowed: async () => true, // fake deps は境界通過を明示
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

	it("read 中 invalidation で epoch 不一致 → indexFile が no-op、skipUntilEpochChange で収束", async () => {
		const files = ["/ws/notes/a.md"];
		const texts = new Map([["/ws/notes/a.md", "aaa"]]);
		const { deps, currentEpoch, indexed } = makeFakeDeps(files, texts);
		let readCount = 0;
		deps.readFile = async (p: string) => {
			readCount++;
			if (readCount === 1) {
				// 1 回目の read 中にのみ invalidation が起きて epoch が進んだ状態を模す。
				currentEpoch.set(p, (currentEpoch.get(p) ?? 0) + 1);
			}
			return texts.get(p) ?? "";
		};
		kickIdleFill(ROOT, deps);
		await waitUntil(() => !_isRunningForTest(ROOT));
		// 1 回目の read: captured=0, current 変化 (1) → indexFile は fake で no-op → skip 記録 (epoch=0)
		// 2 回目の read: captured=1, current=1 → indexFile 成功 → indexed
		expect(indexed.get("/ws/notes/a.md")).toBe(1);
		expect(readCount).toBe(2);
	});

	it("indexFile が永久に valid にならない file (cutoff 超過相当) → skipUntilEpochChange で無限ループ回避", async () => {
		const files = ["/ws/notes/big.md"];
		const texts = new Map([["/ws/notes/big.md", "big"]]);
		const { deps, indexed } = makeFakeDeps(files, texts);
		// fake index を「indexFile 呼び出しでも valid にならない」ように差し替え。
		let indexFileCallCount = 0;
		deps.index = {
			...deps.index,
			indexFile: (_p, _text, _captured) => {
				indexFileCallCount++;
				// no-op: cutoff 超過相当。indexed に記録しない。
			},
			isIndexedAndValid: (_p) => false,
			currentEpochOf: (_p) => 0,
		};
		kickIdleFill(ROOT, deps);
		await waitUntil(() => !_isRunningForTest(ROOT));
		// 1 回だけ試みて skip 記録 → 次 tick で全 skip → picked=0 で bail
		expect(indexFileCallCount).toBe(1);
		expect(indexed.size).toBe(0);
	});

	it("isRealPathAllowed=false → readFile もせず skipUntilEpochChange で bail する (Phase D 境界)", async () => {
		const files = ["/ws/notes/evil.md", "/ws/notes/ok.md"];
		const texts = new Map([
			["/ws/notes/evil.md", "should not be read"],
			["/ws/notes/ok.md", "ok content"],
		]);
		const { deps, indexed } = makeFakeDeps(files, texts);
		let readCallCount = 0;
		const origRead = deps.readFile;
		deps.readFile = async (p: string) => {
			readCallCount++;
			return origRead(p);
		};
		// evil.md だけ realpath で reject する fake。
		deps.isRealPathAllowed = async (p) => p !== "/ws/notes/evil.md";
		kickIdleFill(ROOT, deps);
		await waitUntil(() => !_isRunningForTest(ROOT));
		// evil.md は readFile されず (境界チェックで先に落ちる)、ok.md は 1 度 read + index される。
		expect(readCallCount).toBe(1);
		expect(indexed.has("/ws/notes/evil.md")).toBe(false);
		expect(indexed.has("/ws/notes/ok.md")).toBe(true);
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
