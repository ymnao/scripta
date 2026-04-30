export interface FileEntry {
	name: string;
	path: string;
	isDirectory: boolean;
}

export interface FsChangeEvent {
	kind: "create" | "modify" | "delete";
	path: string;
}
