// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn() },
}));

import { __testing } from "./update";

const { compareVersions, checkForUpdateInner } = __testing;

describe("compareVersions", () => {
	it("hasUpdate when latest > current", () => {
		const info = compareVersions("0.1.0", {
			tag_name: "v1.0.0",
			html_url: "https://github.com/ymnao/scripta/releases/tag/v1.0.0",
		});
		expect(info.hasUpdate).toBe(true);
		expect(info.latestVersion).toBe("1.0.0");
		expect(info.currentVersion).toBe("0.1.0");
		expect(info.releaseUrl).toBe("https://github.com/ymnao/scripta/releases/tag/v1.0.0");
	});

	it("no update when latest == current", () => {
		const info = compareVersions("0.1.0", {
			tag_name: "v0.1.0",
			html_url: "u",
		});
		expect(info.hasUpdate).toBe(false);
	});

	it("no update when latest is older", () => {
		const info = compareVersions("0.1.0", {
			tag_name: "v0.0.9",
			html_url: "u",
		});
		expect(info.hasUpdate).toBe(false);
	});

	it("treats prerelease tag as older than release current", () => {
		const info = compareVersions("1.0.0", {
			tag_name: "v1.0.0-beta.1",
			html_url: "u",
		});
		expect(info.hasUpdate).toBe(false);
	});

	it("rejects invalid current version with explicit error", () => {
		expect(() => compareVersions("not-a-version", { tag_name: "v1.0.0", html_url: "u" })).toThrow(
			/Invalid current version/,
		);
	});

	it("rejects invalid latest tag with explicit error", () => {
		expect(() => compareVersions("0.1.0", { tag_name: "invalid-tag", html_url: "u" })).toThrow(
			/Invalid latest version/,
		);
	});

	it("accepts tag without v prefix", () => {
		const info = compareVersions("0.1.0", {
			tag_name: "1.0.0",
			html_url: "u",
		});
		expect(info.hasUpdate).toBe(true);
	});
});

describe("checkForUpdateInner", () => {
	it("rejects invalid currentVersion before network", async () => {
		// fetch を pass する経路に行かないことを確かめるため、即 reject する。
		await expect(checkForUpdateInner("not-a-version")).rejects.toThrow(/Invalid current version/);
	});
});
