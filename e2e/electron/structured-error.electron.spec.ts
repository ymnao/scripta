import {
	decodeIpcError,
	getErrorKind,
	getStructuredMessage,
	IPC_ERROR_SENTINEL,
} from "../../src/types/errors";
import { expect, test } from "./helpers/launch";

// 領域: 構造化エラーの IPC + contextBridge round-trip（real main → preload → renderer）。
//
// 背景の回帰: contextBridge は Error の message / stack のみを renderer（main world）へ
// 渡し、`kind` / `code` / `path` 等のカスタムプロパティを剥がす。そのため「preload で
// decode して error.kind を付与 → renderer は error.kind で分岐」という設計は実 bridge 上で
// 成立せず、全構造化エラーが UNKNOWN（「予期しないエラー」）に化けていた（git の
// nothing-to-commit が手動同期で誤って「同期に失敗」と表示される症状で顕在化）。
//
// renderer-only e2e は window.api を mock するため preload / contextBridge を踏まず、
// unit テストは codec 単体なので、この境界バグを検出できなかった。本テストは実 Electron で
// 構造化エラーを 1 つ往復させ、bridge を越えた後も renderer が kind / 表示メッセージを
// 復元できることを safety net 化する（特定 kind ではなく round-trip 機構を保証するため、
// セットアップ不要で確定的に出せる INVALID_PATH を代表に使う。GIT_NOTHING_TO_COMMIT 等
// 他の kind も同じ機構で運ばれる）。
test.describe("structured error round-trip (electron)", () => {
	test("contextBridge を越えても構造化エラーの kind が renderer で復元できる", async ({
		launch,
	}) => {
		const { page } = await launch();

		// 実 main の fs:read は空パスを path-guard で INVALID_PATH として reject する。
		// window.api を直接叩く（commands.ts の withRetry を介さない）ことで、preload →
		// contextBridge → renderer の素の往復を踏む。
		const result = await page.evaluate(async () => {
			const api = (window as unknown as { api: { readFile: (p: string) => Promise<unknown> } }).api;
			try {
				await api.readFile("");
				return { threw: false, message: "", ownKeys: [] as string[], hasOwnKind: false };
			} catch (e) {
				const isObj = typeof e === "object" && e !== null;
				return {
					threw: true,
					message: e instanceof Error ? e.message : String(e),
					ownKeys: isObj ? Object.getOwnPropertyNames(e) : [],
					hasOwnKind: isObj && Object.hasOwn(e, "kind"),
				};
			}
		});

		expect(result.threw).toBe(true);

		// 真因の記録: contextBridge はカスタムプロパティを剥がすため、renderer に届いた
		// error は own `kind` プロパティを持たない（message / stack のみ）。kind は message
		// に載った sentinel payload 経由でしか渡らない。
		expect(result.hasOwnKind).toBe(false);
		expect(result.ownKeys).not.toContain("kind");

		// 修正の核心: preload が sentinel payload を message に載せ直しているため、bridge を
		// 越えた message から kind を復元できる。
		expect(result.message).toContain(IPC_ERROR_SENTINEL);
		expect(decodeIpcError(result.message)?.kind).toBe("INVALID_PATH");

		// renderer のエラーユーティリティ（message から復元する版）が機能すること。
		const reconstructed = new Error(result.message);
		expect(getErrorKind(reconstructed)).toBe("INVALID_PATH");

		// 表示用の素メッセージは sentinel を剥がした human-readable な detail になる。
		const detail = getStructuredMessage(reconstructed);
		expect(detail).not.toContain(IPC_ERROR_SENTINEL);
		expect(detail).toContain("Invalid path");
	});
});
