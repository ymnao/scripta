import type { ErrorKind } from "../types/errors";

// kind 付きエラー（preload が IPC reject を unmarshal した後に renderer へ渡す形）を
// 生成する test helper。non-transient 判定や kind 分岐を検証するテストで使う。
export function kindError(kind: ErrorKind, message: string): Error {
	return Object.assign(new Error(message), { kind });
}
