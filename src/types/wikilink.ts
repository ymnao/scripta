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
// displayName / displayPath は scanBacklinksImpl で workspacePath / sourceFile から
// 1 度だけ計算する render-time hoist 済 field (renderer での毎 render allocation 削減)。
export interface BacklinkSource {
	sourceFile: string;
	displayName: string;
	displayPath: string;
	references: WikilinkReference[];
}
