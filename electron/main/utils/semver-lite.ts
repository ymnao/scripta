// 旧 Tauri 版 src-tauri/src/commands/updater.rs が使う `semver` crate の最小サブセットを
// stdlib のみで実装する。Stage 5 の用途は GitHub Releases の tag_name と
// アプリの currentVersion 比較のみで、SemVer 2.0.0 の以下を満たせば十分:
// - "x.y.z" 必須
// - 任意の "-pre.identifiers" prerelease
// - "+build" build metadata は **比較に含めない** (SemVer 2.0.0 §10)
// - prerelease なし > prerelease あり (§11)
// - prerelease 内 numeric は数値比較、alpha は ASCII 辞書順 (§11)

export interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	prerelease: string[]; // 空 = release
}

export function parseSemver(v: string): ParsedVersion {
	if (typeof v !== "string" || v.length === 0) {
		throw new Error(`Invalid version '${v}'`);
	}
	// build metadata は比較に使わないので drop
	const buildIdx = v.indexOf("+");
	const noBuild = buildIdx >= 0 ? v.slice(0, buildIdx) : v;
	// prerelease を分離
	const dashIdx = noBuild.indexOf("-");
	const core = dashIdx >= 0 ? noBuild.slice(0, dashIdx) : noBuild;
	const pre = dashIdx >= 0 ? noBuild.slice(dashIdx + 1) : "";

	const parts = core.split(".");
	if (parts.length !== 3) {
		throw new Error(`Invalid version '${v}'`);
	}
	const ints: number[] = [];
	for (const part of parts) {
		if (!/^\d+$/.test(part)) {
			throw new Error(`Invalid version '${v}'`);
		}
		// SemVer §2: numeric identifier (major / minor / patch) は leading zero 禁止。
		// "0" はそのまま OK だが "01" "00" は invalid（旧 Rust `semver` crate と挙動を揃える）。
		if (part.length > 1 && part.startsWith("0")) {
			throw new Error(`Invalid version '${v}'`);
		}
		const n = Number(part);
		if (!Number.isInteger(n) || n < 0) {
			throw new Error(`Invalid version '${v}'`);
		}
		ints.push(n);
	}

	let prerelease: string[] = [];
	if (dashIdx >= 0) {
		// "1.0.0-" のように hyphen 直後が空のケースは §9 違反（identifier 必須）。
		if (pre.length === 0) throw new Error(`Invalid version '${v}'`);
		prerelease = pre.split(".");
		// SemVer §9: prerelease identifier は [0-9A-Za-z-] のみ、空も不可。
		for (const id of prerelease) {
			if (id.length === 0 || !/^[0-9A-Za-z-]+$/.test(id)) {
				throw new Error(`Invalid version '${v}'`);
			}
			// numeric identifier は leading zero 禁止 (§9)
			if (/^\d+$/.test(id) && id.length > 1 && id.startsWith("0")) {
				throw new Error(`Invalid version '${v}'`);
			}
		}
	}

	return { major: ints[0], minor: ints[1], patch: ints[2], prerelease };
}

export function compareSemver(a: ParsedVersion, b: ParsedVersion): number {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	if (a.patch !== b.patch) return a.patch - b.patch;
	const aPre = a.prerelease.length > 0;
	const bPre = b.prerelease.length > 0;
	// SemVer §11: prerelease なしの方が新しい
	if (!aPre && !bPre) return 0;
	if (!aPre) return 1;
	if (!bPre) return -1;
	const len = Math.min(a.prerelease.length, b.prerelease.length);
	for (let i = 0; i < len; i++) {
		const ax = a.prerelease[i];
		const bx = b.prerelease[i];
		const aIsNum = /^\d+$/.test(ax);
		const bIsNum = /^\d+$/.test(bx);
		if (aIsNum && bIsNum) {
			const an = Number(ax);
			const bn = Number(bx);
			if (an !== bn) return an - bn;
		} else if (aIsNum) {
			return -1; // numeric < alpha
		} else if (bIsNum) {
			return 1;
		} else {
			if (ax < bx) return -1;
			if (ax > bx) return 1;
		}
	}
	// 識別子数が多い方が新しい (§11)
	return a.prerelease.length - b.prerelease.length;
}

export function stripVPrefix(v: string): string {
	if (v.length === 0) return v;
	const c = v.charCodeAt(0);
	if (c === 0x76 || c === 0x56) return v.slice(1); // 'v' or 'V'
	return v;
}
