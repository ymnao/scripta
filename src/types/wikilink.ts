export interface WikilinkReference {
	filePath: string;
	lineNumber: number;
	column: number;
	lineContent: string;
	contextBefore: string[];
	contextAfter: string[];
}

export interface UnresolvedWikilink {
	pageName: string;
	references: WikilinkReference[];
}
