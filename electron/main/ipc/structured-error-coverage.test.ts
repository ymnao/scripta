import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 全 IPC ハンドラが structured-error の `handle()` ラッパー経由で登録されることを保証する
// 構造ガード。生の `ipcMain.handle(` を直接使うと、throw された errno / path / git エラーが
// serializeIpcError されず renderer へ kind なしで届く（= isTransientError が誤って transient
// 判定し withRetry が不要にリトライする等の回帰）。新規ハンドラがラッパーを忘れたら fail させる。

const IPC_DIR = dirname(fileURLToPath(import.meta.url));

function ipcSourceFiles(): string[] {
	return readdirSync(IPC_DIR).filter(
		(f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts",
	);
}

describe("IPC handler structured-error coverage", () => {
	it("registers every handler via handle() (no raw ipcMain.handle in ipc/)", () => {
		const offenders = ipcSourceFiles().filter((f) =>
			readFileSync(join(IPC_DIR, f), "utf8").includes("ipcMain.handle"),
		);
		expect(offenders).toEqual([]);
	});
});
