// `-webkit-app-region` は Electron frameless window のドラッグ領域指定に使うが、
// React.CSSProperties の標準型には含まれないため module augmentation でリテラル型を追加する。
// これにより `style={{ WebkitAppRegion: "drag" }}` が `as` cast 不要で書ける。
import "react";

declare module "react" {
	interface CSSProperties {
		WebkitAppRegion?: "drag" | "no-drag";
	}
}
