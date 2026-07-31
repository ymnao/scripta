// @vitest-environment node
//
// processMdFilesParallel の options が「認可 root は必ず宣言される」を **型で** 強制して
// いることを固定する (#407 Finding 1/3 → #434)。
//
// 旧 API は `index` と `indexRoot` を独立 optional field で持っており、`indexRoot` を書き忘れた
// caller が現れると realpath 再認可が無音で skip される fail-open だった。#407 はこれを
// `IndexOptions.root` の必須化で封じ、#434 で root が **index の有無と独立に** 必要になった
// (index を渡さない caller でも scan の symlink 境界判定に使う) ため options 直下の必須 field へ
// 移した。**この保証を守るのは runtime の assert ではなく型検査**なので、通常の unit test では
// 退行を捕まえられない (root を optional に戻す変更は既存 test を 1 つも落とさずに通る)。
//
// そこで `@ts-expect-error` を pin として使う。root を optional に戻す / index を旧来のフラット
// field へ差し戻すと「エラーになるはずの式がエラーにならない」= @ts-expect-error 自体が
// unused エラーになり、**typecheck job が落ちる**。CI の typecheck (tsconfig.node.json) が
// この file を含むことが前提 (含まれなくなったら pin は無効化されるので、そのときは
// tsconfig の include を直すこと)。
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn() },
}));

import { makeFakeIndex, never } from "../test-utils/search-fakes";
import { __testing } from "./search";

const { processMdFilesParallel } = __testing;

describe("processMdFilesParallel: index options の型契約 (#407 Finding 1/3)", () => {
	it("root 欠落 / 旧フラット field は型エラーになる", async () => {
		// **file 配列は空のまま維持すること**。ここで渡す options は意図的に malformed で、
		// processMdFilesParallel は suppress 判定しかせず不正な形を弾かない。file を 1 つでも
		// 足すと root 欠落側は resolveInsideRoot(ioPath, undefined) 内の path.relative が、
		// handle 欠落側は handle.isDisabled 参照が TypeError になる (fail-loud なので実害は
		// 無いが、型 pin の意図とは無関係な失敗で読み手を混乱させる)。
		const { handle } = makeFakeIndex();

		// root 欠落 = 認可 root を宣言しない形。#434 以降は index の有無に関わらず表現できない。
		// @ts-expect-error root は必須。省くと realpath 再認可も scan の symlink 境界判定も消える
		await processMdFilesParallel([], [], never, {
			index: { handle },
			process: () => {},
		});

		// index を渡さない caller でも root は省けない (#434 で追加された保証)。
		// @ts-expect-error root は必須
		await processMdFilesParallel([], [], never, {
			process: () => {},
		});

		// handle 欠落 = index を養う対象が無い半端な形。
		await processMdFilesParallel([], [], never, {
			root: "/tmp",
			// @ts-expect-error handle は必須
			index: {},
			process: () => {},
		});

		// 旧フラット field / IndexOptions.root は options に存在しない (差し戻し検出)。
		await processMdFilesParallel([], [], never, {
			root: "/tmp",
			index: { handle },
			// @ts-expect-error indexRoot は options.root へ統合済み
			indexRoot: "/tmp",
			process: () => {},
		});

		await processMdFilesParallel([], [], never, {
			root: "/tmp",
			// @ts-expect-error IndexOptions.root は options.root へ移設済み (#434)
			index: { handle, root: "/tmp" },
			process: () => {},
		});

		await processMdFilesParallel([], [], never, {
			root: "/tmp",
			index: { handle },
			// @ts-expect-error suppressIndex は IndexOptions.suppress へ統合済み
			suppressIndex: true,
			process: () => {},
		});

		// 上記 6 つの await が「空 file 集合の走査」として throw せず完走したことが、この case の
		// runtime 側の確認内容 (malformed options でも per-file ループに入らなければ無害)。
		// 末尾の assert は vitest が「assert を持たない it」を警告しないようにするための形式的な
		// もので、file 自体が収集対象から外れた退行はこの assert では検出できない
		// (実行されない assert は自身の非実行を検出できない)。その保証は typecheck 側が持つ。
		expect(true).toBe(true);
	});
});
