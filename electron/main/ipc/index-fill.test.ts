// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createIdleFillState, type IdleFillDeps, kickIdleFill } from "./index-fill";

interface FakeIndexHandle {
	indexFile(path: string, text: string, capturedEpoch: number): void;
	currentEpochOf(path: string): number;
	isIndexedAndValid(path: string): boolean;
	readonly isSaturated: boolean;
}

function makeFakeDeps(
	initialFiles: string[],
	texts: Map<string, string>,
): {
	deps: IdleFillDeps;
	indexed: Map<string, number>;
	currentEpoch: Map<string, number>;
	alive: { value: boolean };
	saturated: { value: boolean };
	reads: { value: number };
} {
	const indexed = new Map<string, number>(); // path → captured epoch (record)
	const currentEpoch = new Map<string, number>();
	const alive = { value: true };
	const saturated = { value: false };
	const reads = { value: 0 };

	const index: FakeIndexHandle = {
		indexFile: (p: string, _text: string, captured: number) => {
			if ((currentEpoch.get(p) ?? 0) !== captured) return; // race skip
			indexed.set(p, captured);
		},
		currentEpochOf: (p: string) => currentEpoch.get(p) ?? 0,
		isIndexedAndValid: (p: string) => indexed.get(p) === (currentEpoch.get(p) ?? 0),
		get isSaturated(): boolean {
			return saturated.value;
		},
	};

	const deps: IdleFillDeps = {
		listIoFiles: () => initialFiles,
		readFile: async (p: string) => {
			reads.value++;
			return texts.get(p) ?? "";
		},
		isAlive: () => alive.value,
		state: createIdleFillState(),
		index,
		yieldTick: async () => {}, // test では即座 resolve
		// fake deps は境界通過を明示する。identity 解決 = 「symlink でない通常 file」相当。
		resolveAllowed: async (p: string) => p,
	};

	return { deps, indexed, currentEpoch, alive, saturated, reads };
}

describe("index-fill: kickIdleFill", () => {
	it("kick 冪等性: 同時に 2 回 kick しても実 fill は 1 度のみ", async () => {
		const texts = new Map([
			["/ws/notes/a.md", "aaa"],
			["/ws/notes/b.md", "bbb"],
		]);
		const { deps } = makeFakeDeps(["/ws/notes/a.md", "/ws/notes/b.md"], texts);
		kickIdleFill(deps);
		expect(deps.state.running).toBe(true);
		// 2 回目の kick は no-op (既存 state を再利用)
		kickIdleFill(deps);
		expect(deps.state.running).toBe(true);
		// 完了を待つ
		await waitUntil(() => !deps.state.running);
	});

	it("fill 進行: 3 file 中未 indexed のものが全て indexed になる", async () => {
		const files = ["/ws/notes/a.md", "/ws/notes/b.md", "/ws/notes/c.md"];
		const texts = new Map(files.map((f) => [f, `text of ${f}`]));
		const { deps, indexed } = makeFakeDeps(files, texts);
		kickIdleFill(deps);
		await waitUntil(() => !deps.state.running);
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
		kickIdleFill(deps);
		await waitUntil(() => !deps.state.running);
		// readFile 直後の isAlive() チェックで break し、indexFile は呼ばれないはず。
		expect(indexed.size).toBe(0);
	});

	it("isSaturated で bail: index が saturated なら fill 停止", async () => {
		const files = ["/ws/notes/a.md", "/ws/notes/b.md"];
		const texts = new Map(files.map((f) => [f, `text of ${f}`]));
		const { deps, saturated, indexed } = makeFakeDeps(files, texts);
		saturated.value = true;
		kickIdleFill(deps);
		await waitUntil(() => !deps.state.running);
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
		kickIdleFill(deps);
		await waitUntil(() => !deps.state.running);
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
		kickIdleFill(deps);
		await waitUntil(() => !deps.state.running);
		// 1 回だけ試みて skip 記録 → 次 tick で全 skip → picked=0 で bail
		expect(indexFileCallCount).toBe(1);
		expect(indexed.size).toBe(0);
	});

	it("resolveAllowed=null → readFile もせず skipUntilEpochChange で bail する (Phase D 境界)", async () => {
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
		deps.resolveAllowed = async (p) => (p === "/ws/notes/evil.md" ? null : p);
		kickIdleFill(deps);
		await waitUntil(() => !deps.state.running);
		// evil.md は readFile されず (境界チェックで先に落ちる)、ok.md は 1 度 read + index される。
		expect(readCallCount).toBe(1);
		expect(indexed.has("/ws/notes/evil.md")).toBe(false);
		expect(indexed.has("/ws/notes/ok.md")).toBe(true);
	});

	it("resolveAllowed が別 path を返す (workspace 内 alias) → read も index もしない (#413 Finding 2)", async () => {
		// workspace 内 symlink `link.md` が `real.md` を指すケース。index の key は link.md 側に
		// 付く一方、watcher (followSymlinks: false) の modify は real.md でしか来ないため
		// invalidate が波及しない。よって alias は index に載せず、未 index のまま毎回 scan させる。
		// **#406 Finding 2 との関係**: 「解決済み path で readFile する」経路は、alias を read 前に
		// skip するようになったことで index-fill からは到達不能になった (非 alias は resolved === p
		// なので readFile の引数も p と一致する)。resolveAllowed の戻り値は alias 判定に使う。
		// search.ts 側の piggyback は scan のために読む必要があるので resolved 読みを維持しており、
		// #406 の pin は search.test.ts の "reads the resolved target ..." が引き続き担う。
		const files = ["/ws/notes/link.md", "/ws/notes/ok.md"];
		const texts = new Map([
			["/ws/notes/real.md", "real content"],
			["/ws/notes/ok.md", "ok content"],
		]);
		const { deps, indexed } = makeFakeDeps(files, texts);
		const readPaths: string[] = [];
		deps.resolveAllowed = async (p) => (p === "/ws/notes/link.md" ? "/ws/notes/real.md" : p);
		deps.readFile = async (p: string) => {
			readPaths.push(p);
			return texts.get(p) ?? "";
		};
		kickIdleFill(deps);
		await waitUntil(() => !deps.state.running);
		// alias は解決先も symlink path も読まない (index 目的の read しかしないため)。
		expect(readPaths).toEqual(["/ws/notes/ok.md"]);
		expect(indexed.has("/ws/notes/link.md")).toBe(false);
		expect(indexed.has("/ws/notes/real.md")).toBe(false);
		expect(indexed.has("/ws/notes/ok.md")).toBe(true);
		// skipUntilEpochChange に倒れているので tick を回し切って終了する。無限 retry の
		// 退行は上の waitUntil が timeout で throw して検出する (この時点の
		// deps.state.running は waitUntil 成功後なので恒真であり、assert には含めない)。
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
		kickIdleFill(deps);
		await waitUntil(() => !deps.state.running);
		expect(readCalled).toBe(false);
	});

	describe("skip 記録の kick 跨ぎ保持 (#589 A1)", () => {
		const BIG = "/ws/notes/big.md";

		function makeCutoffDeps(): ReturnType<typeof makeFakeDeps> {
			const fake = makeFakeDeps([BIG], new Map([[BIG, "big"]]));
			// cutoff 超過相当: indexFile を呼んでも valid にならない。
			fake.deps.index = {
				...fake.deps.index,
				indexFile: () => {},
				isIndexedAndValid: () => false,
			};
			return fake;
		}

		it("indexFile に reject される file は 2 回目の kick で再 read されない", async () => {
			const { deps, reads } = makeCutoffDeps();
			kickIdleFill(deps);
			await waitUntil(() => !deps.state.running);
			expect(reads.value).toBe(1);
			kickIdleFill(deps);
			await waitUntil(() => !deps.state.running);
			expect(reads.value).toBe(1);
		});

		it("skip 済み file は epoch が進んだ後の kick で再 read される", async () => {
			const { deps, reads, currentEpoch } = makeCutoffDeps();
			kickIdleFill(deps);
			await waitUntil(() => !deps.state.running);
			expect(reads.value).toBe(1);
			currentEpoch.set(BIG, 1);
			kickIdleFill(deps);
			await waitUntil(() => !deps.state.running);
			expect(reads.value).toBe(2);
		});
	});

	describe("tick を跨ぐ cursor 再開 (#589 C1)", () => {
		// TICK_SIZE (4) を超える件数にして、1 kick 内で複数 tick を回す。
		const FILES = Array.from({ length: 10 }, (_, i) => `/ws/notes/f${i}.md`);

		// 再開位置は index 結果には現れない (先頭から舐め直しても valid な file は picked に
		// 数えずに通過するので、read 順も最終状態も同じになる)。そこで各 tick で最初に
		// isIndexedAndValid を問われた path を tick の開始位置として観測する。
		function trackTicks(
			deps: IdleFillDeps,
			onYield: (tick: number) => void = () => {},
		): { tickStarts: () => string[] } {
			const visits: string[][] = [[]];
			const base = deps.index;
			deps.index = {
				indexFile: base.indexFile,
				currentEpochOf: base.currentEpochOf,
				isIndexedAndValid: (p: string) => {
					visits[visits.length - 1].push(p);
					return base.isIndexedAndValid(p);
				},
				get isSaturated(): boolean {
					return base.isSaturated;
				},
			};
			deps.yieldTick = async () => {
				onYield(visits.length);
				visits.push([]);
			};
			return { tickStarts: () => visits.map((v) => v[0]) };
		}

		it("次の tick は前 tick が読んだ file の続きから舐める", async () => {
			const { deps, indexed } = makeFakeDeps(FILES, new Map());
			const { tickStarts } = trackTicks(deps);
			kickIdleFill(deps);
			await waitUntil(() => !deps.state.running);
			// f8, f9 を読んだ tick 3 の末尾で cursor が先頭へ戻り、tick 4 は全 valid で bail する。
			expect(tickStarts()).toEqual([FILES[0], FILES[4], FILES[8], FILES[0]]);
			expect(indexed.size).toBe(FILES.length);
		});

		it("cursor より手前で stale になった file は末尾から折り返して回収する", async () => {
			const { deps, indexed, currentEpoch } = makeFakeDeps(FILES, new Map());
			// 末尾 2 件を index 済みにしておき、cursor から末尾までに picked が出ない状態を作る。
			indexed.set(FILES[8], 0);
			indexed.set(FILES[9], 0);
			const readPaths: string[] = [];
			deps.readFile = async (p: string) => {
				readPaths.push(p);
				return "";
			};
			trackTicks(deps, (tick) => {
				// tick 2 (f4..f7) を読み終え cursor が f8 を指した時点で、読み済みの f1 を変更する。
				if (tick === 2) currentEpoch.set(FILES[1], 1);
			});
			kickIdleFill(deps);
			await waitUntil(() => !deps.state.running);
			expect(readPaths).toEqual([...FILES.slice(0, 8), FILES[1]]);
			expect(indexed.get(FILES[1])).toBe(1);
		});

		it("file 数が変わった次の tick は先頭から舐め直す", async () => {
			const files = [...FILES];
			const { deps, indexed } = makeFakeDeps(files, new Map());
			const { tickStarts } = trackTicks(deps, (tick) => {
				// 先頭側への挿入で並びがずれる。cursor を据え置くと位置の意味が変わる。
				if (tick === 1) files.unshift("/ws/notes/e.md");
			});
			kickIdleFill(deps);
			await waitUntil(() => !deps.state.running);
			expect(tickStarts()[1]).toBe("/ws/notes/e.md");
			expect(indexed.size).toBe(files.length);
		});
	});

	it("旧 state の loop が readFile 待ちでも別 state の kick は走る", async () => {
		const files = ["/ws/notes/a.md"];
		const texts = new Map([["/ws/notes/a.md", "aaa"]]);
		const first = makeFakeDeps(files, texts);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		first.deps.readFile = async (p: string) => {
			await gate;
			return texts.get(p) ?? "";
		};
		kickIdleFill(first.deps);
		await waitUntil(() => first.deps.state.running);

		const second = makeFakeDeps(files, texts);
		kickIdleFill(second.deps);
		await waitUntil(() => !second.deps.state.running);
		expect(second.reads.value).toBeGreaterThan(0);

		first.alive.value = false;
		release();
		await waitUntil(() => !first.deps.state.running);
	});
});

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}
