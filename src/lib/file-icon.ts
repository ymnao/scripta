import type { LucideIcon } from "lucide-react";
import { File, FileCode, FileJson, FileText } from "lucide-react";

const extensionMap: Record<string, LucideIcon> = {
	".md": FileText,
	".txt": FileText,
	".json": FileJson,
	".ts": FileCode,
	".tsx": FileCode,
	".js": FileCode,
	".jsx": FileCode,
	".css": FileCode,
	".html": FileCode,
};

export function getFileIcon(fileName: string): LucideIcon {
	const dotIndex = fileName.lastIndexOf(".");
	if (dotIndex === -1) return File;
	const ext = fileName.slice(dotIndex).toLowerCase();
	return extensionMap[ext] ?? File;
}
