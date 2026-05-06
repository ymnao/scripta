import { request as httpsRequest } from "node:https";
import { ipcMain } from "electron";
import type { UpdateInfo } from "../../../src/types/update";
import { compareSemver, parseSemver, stripVPrefix } from "../utils/semver-lite";

// 旧 Tauri 版 src-tauri/src/commands/updater.rs `check_for_update_inner` を Node stdlib
// に移植。GitHub Releases API から latest release を取得し、tag_name を `v` 前置きを
// 除いた SemVer として現在バージョンと比較する。
//
// electron-updater は **Stage 6** (コードサイニング / 公証 / 配布) の作業に合流させる。
// Stage 5 ではチェックのみ → ダイアログ → ブラウザで GitHub Releases に飛ばす UX で
// 旧 Tauri 版の挙動を 1:1 で再現する（renderer 側 useUpdateCheck.ts は変更不要）。

const GITHUB_API_URL = "https://api.github.com/repos/ymnao/scripta/releases/latest";
const MAX_RESPONSE_BYTES = 100 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

interface GitHubRelease {
	tag_name: string;
	html_url: string;
}

function isGitHubRelease(v: unknown): v is GitHubRelease {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o.tag_name === "string" && typeof o.html_url === "string";
}

export function compareVersions(currentVersion: string, release: GitHubRelease): UpdateInfo {
	let current: ReturnType<typeof parseSemver>;
	try {
		current = parseSemver(currentVersion);
	} catch (e) {
		throw new Error(`Invalid current version '${currentVersion}': ${(e as Error).message}`);
	}
	const latestStr = stripVPrefix(release.tag_name);
	let latest: ReturnType<typeof parseSemver>;
	try {
		latest = parseSemver(latestStr);
	} catch (e) {
		throw new Error(`Invalid latest version '${latestStr}': ${(e as Error).message}`);
	}
	return {
		hasUpdate: compareSemver(latest, current) > 0,
		latestVersion: latestStr,
		currentVersion,
		releaseUrl: release.html_url,
	};
}

async function fetchLatestRelease(): Promise<GitHubRelease> {
	const url = new URL(GITHUB_API_URL);
	return new Promise<GitHubRelease>((resolve, reject) => {
		const req = httpsRequest(
			{
				hostname: url.hostname,
				port: 443,
				path: `${url.pathname}${url.search}`,
				method: "GET",
				headers: {
					"User-Agent": "scripta",
					Accept: "application/vnd.github+json",
				},
				timeout: REQUEST_TIMEOUT_MS,
			},
			(res) => {
				const chunks: Buffer[] = [];
				let total = 0;
				let settled = false;
				res.on("data", (chunk: Buffer) => {
					if (settled) return;
					total += chunk.length;
					if (total > MAX_RESPONSE_BYTES) {
						settled = true;
						res.destroy();
						reject(new Error("Response too large"));
						return;
					}
					chunks.push(chunk);
				});
				res.on("end", () => {
					if (settled) return;
					settled = true;
					const status = res.statusCode ?? 0;
					if (status < 200 || status >= 300) {
						reject(new Error(`Failed to fetch releases: HTTP ${status}`));
						return;
					}
					try {
						const text = Buffer.concat(chunks).toString("utf8");
						const json = JSON.parse(text) as unknown;
						if (!isGitHubRelease(json)) {
							reject(new Error("Failed to parse response: missing fields"));
							return;
						}
						resolve(json);
					} catch (e) {
						reject(new Error(`Failed to parse response: ${(e as Error).message}`));
					}
				});
				res.on("error", (e) => {
					if (settled) return;
					settled = true;
					reject(e);
				});
			},
		);
		req.on("timeout", () => {
			req.destroy(new Error("Request timeout"));
		});
		req.on("error", reject);
		req.end();
	});
}

export async function checkForUpdateInner(currentVersion: string): Promise<UpdateInfo> {
	// network 前に currentVersion を validate する（旧 Rust と同方針：レイテンシのある
	// network 失敗より、まず手元の即時 fail を優先）。
	try {
		parseSemver(currentVersion);
	} catch (e) {
		throw new Error(`Invalid current version '${currentVersion}': ${(e as Error).message}`);
	}
	const release = await fetchLatestRelease();
	return compareVersions(currentVersion, release);
}

export function registerUpdateIpc(): void {
	ipcMain.handle("update:check", (_event, currentVersion: string) =>
		checkForUpdateInner(currentVersion),
	);
}

export const __testing = { compareVersions, checkForUpdateInner };
