export interface FileEntry {
	name: string;
	path: string;
	isDirectory: boolean;
}

export type FsKind = "create" | "modify" | "delete";

export interface FsChangeEvent {
	kind: FsKind;
	path: string;
}
