// @vitest-environment node
//
// processMdFilesParallel の index options が「handle と root は必ず揃う」を **型で** 強制して
// いることを固定する (#407 Finding 1/3)。
//
// 旧 API は `index` と `indexRoot` を独立 optional field で持っており、`indexRoot` を書き忘れた
// caller が現れると realpath 再認可が無音で skip される fail-open だった。root を必須プロパティに
// したことでその状態は表現できなくなったが、**この保証を守るのは runtime の assert ではなく
// 型検査**なので、通常の unit test では退行を捕まえられない (root を optional に戻す変更は
// 既存 test を 1 つも落とさずに通る)。
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
	it("handle だけ / root だけの index options は型エラーになる", async () => {
		// **file 配列は空のまま維持すること**。ここで渡す options は意図的に malformed で、
		// processMdFilesParallel は suppress 判定しかせず不正な形を弾かない。file を 1 つでも
		// 足すと root 欠落側は resolveInsideRoot(ioPath, undefined) 内の path.relative が、
		// handle 欠落側は handle.isDisabled 参照が TypeError になる (fail-loud なので実害は
		// 無いが、型 pin の意図とは無関係な失敗で読み手を混乱させる)。
		const { handle } = makeFakeIndex();

		// root 欠落 = 旧 API の「index だけ渡して indexRoot を書き忘れる」fail-open 形。
		await processMdFilesParallel([], [], never, {
			// @ts-expect-error root は必須。省くと realpath 再認可が無音で skip される旧挙動に戻る
			index: { handle },
			process: () => {},
		});

		// handle 欠落 = 認可 root だけ宣言して index を養う対象が無い半端な形。
		await processMdFilesParallel([], [], never, {
			// @ts-expect-error handle は必須
			index: { root: "/tmp" },
			process: () => {},
		});

		// 旧フラット field は options に存在しない (差し戻し検出)。
		await processMdFilesParallel([], [], never, {
			index: { handle, root: "/tmp" },
			// @ts-expect-error indexRoot は IndexOptions.root へ統合済み
			indexRoot: "/tmp",
			process: () => {},
		});

		await processMdFilesParallel([], [], never, {
			index: { handle, root: "/tmp" },
			// @ts-expect-error suppressIndex は IndexOptions.suppress へ統合済み
			suppressIndex: true,
			process: () => {},
		});

		// 上記 4 つの await が「空 file 集合の走査」として throw せず完走したことが、この case の
		// runtime 側の確認内容 (malformed options でも per-file ループに入らなければ無害)。
		// 末尾の assert は vitest が「assert を持たない it」を警告しないようにするための形式的な
		// もので、file 自体が収集対象から外れた退行はこの assert では検出できない
		// (実行されない assert は自身の非実行を検出できない)。その保証は typecheck 側が持つ。
		expect(true).toBe(true);
	});
});
