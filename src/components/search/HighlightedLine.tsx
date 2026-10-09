// SearchPanel.tsx から別 module に出しているのは、テストが vi.mock で呼び出し回数を
// 数えられるようにするため (同じ module 内の参照は mock した export を経由しない)。
export function HighlightedLine({
	line,
	matchStart,
	matchEnd,
}: {
	line: string;
	matchStart: number;
	matchEnd: number;
}) {
	const before = line.slice(0, matchStart);
	const match = line.slice(matchStart, matchEnd);
	const after = line.slice(matchEnd);
	return (
		<>
			{before}
			<mark className="search-panel-highlight">{match}</mark>
			{after}
		</>
	);
}
