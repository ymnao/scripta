export interface SearchResult {
	filePath: string;
	lineNumber: number;
	lineContent: string;
	matchStart: number;
	matchEnd: number;
}
