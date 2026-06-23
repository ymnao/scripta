export interface WikilinkReference {
	filePath: string;
	lineNumber: number;
	byteOffset: number;
	lineContent: string;
	contextBefore: string[];
	contextAfter: string[];
}

export interface UnresolvedWikilink {
	pageName: string;
	references: WikilinkReference[];
}

// 対象ノートを参照している側のファイル 1 つと、その中の参照位置一覧。
// WikilinkReference.filePath は参照元 (= sourceFile と同値) を指す。
export interface BacklinkSource {
	sourceFile: string;
	references: WikilinkReference[];
}
