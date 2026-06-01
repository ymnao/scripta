import type { UpdateInfo } from "../../../src/types/update";
import { httpFetch } from "../utils/http-fetch";
import { handle } from "../utils/ipc-handle";
import { compareSemver, parseSemver, stripVPrefix } from "../utils/semver-lite";

// `check_for_update_inner`。GitHub Releases API から latest release を取得し、
// tag_name を `v` 前置きを除いた SemVer として現在バージョンと比較する。
//
// electron-updater は **Stage 6** (コードサイニング / 公証 / 配布) の作業に合流させる。
// Stage 5 ではチェックのみ → ダイアログ → ブラウザで GitHub Releases に飛ばす UX に
// する（renderer 側 useUpdateCheck.ts は変更不要）。

// 配布パイプライン (electron-builder.yml の publish / .github/workflows/release.yml の
// gh release upload) は current repo を自動推定し ymnao/scripta-next の Release に成果物を
// 置く。リリース切り替え (旧 ymnao/scripta を rename → 本リポを ymnao/scripta として公開)
// のタイミングで本 URL も "scripta-next" → "scripta" に戻す必要がある。
const GITHUB_API_URL = "https://api.github.com/repos/ymnao/scripta-next/releases/latest";
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
	const res = await httpFetch({
		url: new URL(GITHUB_API_URL),
		headers: {
			"User-Agent": "scripta",
			Accept: "application/vnd.github+json",
		},
		timeoutMs: REQUEST_TIMEOUT_MS,
		maxBodyBytes: MAX_RESPONSE_BYTES,
		// 100KB を超える GitHub release レスポンスは異常 → 切り詰めずに reject。
		onMaxExceeded: "reject",
	});
	if (res.statusCode < 200 || res.statusCode >= 300) {
		throw new Error(`Failed to fetch releases: HTTP ${res.statusCode}`);
	}
	let json: unknown;
	try {
		json = JSON.parse(res.body.toString("utf8"));
	} catch (e) {
		throw new Error(`Failed to parse response: ${(e as Error).message}`);
	}
	if (!isGitHubRelease(json)) {
		throw new Error("Failed to parse response: missing fields");
	}
	return json;
}

export async function checkForUpdateInner(currentVersion: string): Promise<UpdateInfo> {
	// network 前に currentVersion を validate する（レイテンシのある
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
	handle("update:check", (_event, currentVersion: string) => checkForUpdateInner(currentVersion));
}

export const __testing = { compareVersions, checkForUpdateInner };
