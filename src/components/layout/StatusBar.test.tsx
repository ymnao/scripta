import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBar } from "./StatusBar";

describe("StatusBar", () => {
	it("shows nothing when saveStatus is idle", () => {
		render(<StatusBar saveStatus="idle" />);
		expect(screen.queryByText("Saving...")).not.toBeInTheDocument();
		expect(screen.queryByText("Saved")).not.toBeInTheDocument();
		expect(screen.queryByText("Save failed")).not.toBeInTheDocument();
	});

	it('shows "Saving..." when saveStatus is saving', () => {
		render(<StatusBar saveStatus="saving" />);
		expect(screen.getByText("Saving...")).toBeInTheDocument();
	});

	it('shows "Saved" when saveStatus is saved', () => {
		render(<StatusBar saveStatus="saved" />);
		expect(screen.getByText("Saved")).toBeInTheDocument();
	});

	it('shows "Save failed" when saveStatus is error', () => {
		render(<StatusBar saveStatus="error" />);
		expect(screen.getByText("Save failed")).toBeInTheDocument();
	});

	it("shows nothing when saveStatus is not provided", () => {
		render(<StatusBar />);
		expect(screen.queryByText("Saving...")).not.toBeInTheDocument();
		expect(screen.queryByText("Saved")).not.toBeInTheDocument();
		expect(screen.queryByText("Save failed")).not.toBeInTheDocument();
	});
});
