export interface SearchResult {
	filePath: string;
	lineNumber: number;
	lineContent: string;
	matchStart: number;
	matchEnd: number;
}

// 全文検索の結果件数上限。main (searchFilesImpl) が打ち切り判定に使い、
// renderer (SearchPanel) が notice 文言の件数表示に使う。IPC 境界の両側で
// 同じ値を意味するため、双方から import できるここを唯一の定義にする
// (e2e/helpers/electron-api-mock.ts のみ browser scope 注入の制約で複製)。
export const MAX_SEARCH_RESULTS = 10_000;

// searchFiles の IPC 戻り値。件数上限 (MAX_SEARCH_RESULTS) に達した場合
// truncated = true になり、SearchPanel が打ち切り notice を表示する。
export interface SearchFilesResponse {
	results: SearchResult[];
	truncated: boolean;
}
