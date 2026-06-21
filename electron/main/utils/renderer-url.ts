import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// renderer の URL（pathname まで含む）が、scripta の renderer dir 配下かを判定する。
// will-navigate / window-open / permission の信頼判定で共通利用する。
//
// **pathname まで含めて厳密に判定する**のが本関数の本質的契約。origin だけだと
// 「file: スキームのローカル HTML 一般」「dev origin の任意 path」全部を trust に含めて
// しまい、子 window で renderer dir 外のローカル HTML に遷移されると clipboard 等の
// permission が漏れる（実 PoC で確認済み: conflict window から任意 local HTML へ遷移
// → navigator.clipboard.readText が成功）。
//
// dev: ELECTRON_RENDERER_URL の origin と一致 + pathname が allowed の prefix 配下
// prod: file: スキーム + osPath が RENDERER_FILE_DIR 配下（OS ネイティブで relative 判定）
const RENDERER_FILE_DIR = join(__dirname, "../renderer");

// file: URL を OS ネイティブパスへ変換し、base dir 配下かを判定する。
//
// URL.pathname を直接ネイティブパスとして比較すると、Windows で
//   URL pathname  : /C:/app/out/renderer/index.html
//   base dir      : C:\app\out\renderer
// のように形式と区切り文字が両方違って正規 URL も reject される。`fileURLToPath` で
// 必ずネイティブ表現へ変換してから `path.relative` + `path.isAbsolute` で判定する。
// 副次効果として encoded separator (%2F) や `..` segment も URL parser / fileURLToPath
// で正規化されるので、`relative` が `..` 始まりや絶対 path を返す経路で reject できる。
//
// `pathOps` を差し替え可能にしているのは host OS（macOS / Linux）上から Windows 形式の
// 入力を verify するため。production code は default の host OS ops を使う。
export interface PathOps {
	fileURLToPath: (u: URL) => string;
	relative: (from: string, to: string) => string;
	isAbsolute: (p: string) => boolean;
	// platform 別の path separator（POSIX: "/", Windows: "\\"）。`..foo` のような
	// 正当な名前を「parent 参照」と取り違えないよう、`..${sep}` 始まりかで厳密判定する。
	sep: string;
}

const DEFAULT_PATH_OPS: PathOps = { fileURLToPath, relative, isAbsolute, sep };

export function isFileUrlInsideDir(
	url: string,
	baseDir: string,
	pathOps: PathOps = DEFAULT_PATH_OPS,
): boolean {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "file:") return false;
		const osPath = pathOps.fileURLToPath(parsed);
		const rel = pathOps.relative(baseDir, osPath);
		// "": base そのもの（許可）
		// "..": 親 dir、または `..${sep}...`: より上位 / 兄弟（拒否）
		//   ※ `rel.startsWith("..")` だけだと `..cache/file.js` のような正当名も
		//   parent 参照と誤判定するため、separator まで含めた厳密判定にする
		// 絶対 path: Windows の drive 跨ぎ / UNC（拒否）
		if (rel === "") return true;
		if (rel === ".." || rel.startsWith(`..${pathOps.sep}`)) return false;
		return !pathOps.isAbsolute(rel);
	} catch {
		return false;
	}
}

export function isAllowedRendererUrl(url: string): boolean {
	const devUrl = process.env.ELECTRON_RENDERER_URL;
	if (devUrl) {
		try {
			const parsed = new URL(url);
			const allowed = new URL(devUrl);
			if (parsed.origin !== allowed.origin) return false;
			const basePath = allowed.pathname.endsWith("/")
				? allowed.pathname.slice(0, -1)
				: allowed.pathname;
			return parsed.pathname === basePath || parsed.pathname.startsWith(`${basePath}/`);
		} catch {
			return false;
		}
	}
	return isFileUrlInsideDir(url, RENDERER_FILE_DIR);
}
