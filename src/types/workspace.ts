export interface FileEntry {
	name: string;
	path: string;
	isDirectory: boolean;
}

export type FsKind = "create" | "modify" | "delete";

export interface FsChangeEvent {
	kind: FsKind;
	path: string;
	// main 側の search cache だけが読む。省略時はディレクトリかどうか不明として扱い、
	// `.md` で終わる path は file とみなされる。
	isDir?: boolean;
}
