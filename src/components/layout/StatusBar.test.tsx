import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBar } from "./StatusBar";

describe("StatusBar", () => {
	it('shows "未保存" when saveStatus is unsaved', () => {
		render(<StatusBar saveStatus="unsaved" />);
		expect(screen.getByText("未保存")).toBeInTheDocument();
	});

	it('shows "保存中..." when saveStatus is saving', () => {
		render(<StatusBar saveStatus="saving" />);
		expect(screen.getByText("保存中...")).toBeInTheDocument();
	});

	it('shows "保存済み" when saveStatus is saved', () => {
		render(<StatusBar saveStatus="saved" />);
		expect(screen.getByText("保存済み")).toBeInTheDocument();
	});

	it('shows "保存失敗" when saveStatus is error', () => {
		render(<StatusBar saveStatus="error" />);
		expect(screen.getByText("保存失敗")).toBeInTheDocument();
	});

	it("shows no status text when saveStatus is not provided", () => {
		render(<StatusBar />);
		expect(screen.queryByText("保存済み")).not.toBeInTheDocument();
		expect(screen.queryByText("未保存")).not.toBeInTheDocument();
		expect(screen.queryByText("保存中...")).not.toBeInTheDocument();
		expect(screen.queryByText("保存失敗")).not.toBeInTheDocument();
	});

	it("shows cursor info when provided", () => {
		render(<StatusBar cursorInfo={{ line: 10, col: 5, chars: 1234 }} />);
		expect(screen.getByText("Ln 10, Col 5")).toBeInTheDocument();
		expect(screen.getByText("1234 chars")).toBeInTheDocument();
	});

	it("does not show cursor info when not provided", () => {
		render(<StatusBar saveStatus="saved" />);
		expect(screen.queryByText(/Ln \d+/)).not.toBeInTheDocument();
		expect(screen.queryByText(/chars/)).not.toBeInTheDocument();
	});
});
