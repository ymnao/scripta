import { join } from "node:path";
import { expect, test } from "./helpers/launch";
import { seedSettings, tinyPng, writeWorkspaceFiles } from "./helpers/fixtures";
import type { Page } from "@playwright/test";

// 領域5: Asset URL（`scripta-asset://` protocol + path-guard）。
// workspace 内画像が protocol 越しに配信され、workspace 外パスは path-guard で
// 拒否される（403 → img error）ことを実 main で踏む。mock では protocol handler /
// `isPathWithinAnyAllowedRoot` の実挙動を検出できない。
// Phase 3 で `convertFileSrc` → `buildAssetUrl` rename 予定（ADR-0003 候補）の baseline。

// fs パスを convertFileSrc で scripta-asset URL 化し、<img> として実ロードを試みる。
// CSP img-src が scripta-asset: を許可するため、許可パスは load、拒否パスは error になる。
function tryLoadAsset(page: Page, fsPath: string): Promise<boolean> {
	return page.evaluate((p) => {
		const src = window.api.convertFileSrc(p);
		return new Promise<boolean>((resolve) => {
			const img = new Image();
			img.onload = () => resolve(img.naturalWidth > 0);
			img.onerror = () => resolve(false);
			img.src = src;
		});
	}, fsPath);
}

test.describe("asset url protocol (electron)", () => {
	test("workspace 内画像は scripta-asset:// で配信され、外部パスは path-guard で拒否される", async ({
		launch,
		userDataDir,
		workspaceDir,
	}) => {
		writeWorkspaceFiles(workspaceDir, { "assets/pic.png": tinyPng() });
		// workspace 外（allowed root 外）に実在する画像。404 ではなく path-guard で
		// 拒否されることを示すため、わざと実ファイルとして置く。
		writeWorkspaceFiles(userDataDir, { "outside.png": tinyPng() });
		seedSettings(userDataDir, { workspacePath: workspaceDir });

		const { page } = await launch();
		// workspace 復元 = allowed root 登録完了（protocol handler の path-guard が通る前提）。
		await expect(page.getByRole("button", { name: "ワークスペース検索" })).toBeVisible();

		// 内部画像は配信される。
		expect(await tryLoadAsset(page, join(workspaceDir, "assets/pic.png"))).toBe(true);

		// 外部の実ファイルは path-guard が拒否（403）→ img error。
		expect(await tryLoadAsset(page, join(userDataDir, "outside.png"))).toBe(false);
	});
});
