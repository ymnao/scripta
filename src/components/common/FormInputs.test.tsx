import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	NumberInput,
	RangeInput,
	SelectInput,
	TextareaInput,
	TextInput,
	Toggle,
} from "./FormInputs";

describe("Toggle", () => {
	it("OFF のときクリックで true を渡す", async () => {
		const onChange = vi.fn();
		render(<Toggle id="t" label="隠しファイル" checked={false} onChange={onChange} />);

		const toggle = screen.getByRole("switch", { name: "隠しファイル" });
		expect(toggle).toHaveAttribute("aria-checked", "false");
		await userEvent.click(toggle);

		expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
	});

	it("ON のときクリックで false を渡す", async () => {
		const onChange = vi.fn();
		render(<Toggle id="t" label="隠しファイル" checked onChange={onChange} />);

		const toggle = screen.getByRole("switch", { name: "隠しファイル" });
		expect(toggle).toHaveAttribute("aria-checked", "true");
		await userEvent.click(toggle);

		expect(onChange).toHaveBeenCalledExactlyOnceWith(false);
	});
});

describe("SelectInput", () => {
	it("数値の選択肢は数値のまま渡す", async () => {
		const onChange = vi.fn();
		render(
			<SelectInput
				id="s"
				label="レベル"
				value={2}
				options={[
					{ value: 1, label: "H1" },
					{ value: 2, label: "H2" },
					{ value: 3, label: "H3" },
				]}
				onChange={onChange}
			/>,
		);

		const select = screen.getByRole("combobox", { name: "レベル" });
		expect(select).toHaveValue("2");
		await userEvent.selectOptions(select, "H3");

		expect(onChange).toHaveBeenCalledExactlyOnceWith(3);
	});

	it("文字列の選択肢はそのまま渡す", async () => {
		const onChange = vi.fn();
		render(
			<SelectInput
				id="s"
				label="テーマ"
				value="light"
				options={[
					{ value: "light", label: "ライト" },
					{ value: "dark", label: "ダーク" },
				]}
				onChange={onChange}
			/>,
		);

		await userEvent.selectOptions(screen.getByRole("combobox", { name: "テーマ" }), "ダーク");

		expect(onChange).toHaveBeenCalledExactlyOnceWith("dark");
	});
});

describe("NumberInput", () => {
	function renderNumber() {
		const props = {
			id: "n",
			label: "文字サイズ",
			value: 14,
			min: 8,
			max: 32,
			step: 1,
			unit: "px",
			onChange: vi.fn(),
		};
		const { rerender } = render(<NumberInput {...props} />);
		return {
			onChange: props.onChange,
			input: screen.getByRole("spinbutton", { name: "文字サイズ" }),
			rerenderWithValue: (value: number) => rerender(<NumberInput {...props} value={value} />),
		};
	}

	it("入力中は onChange を呼ばず、blur で確定する", async () => {
		const { onChange, input } = renderNumber();

		await userEvent.clear(input);
		await userEvent.type(input, "20");
		expect(onChange).not.toHaveBeenCalled();

		await userEvent.tab();
		expect(onChange).toHaveBeenCalledExactlyOnceWith(20);
		expect(input).toHaveValue(20);
	});

	it("Enter で確定する", async () => {
		const { onChange, input } = renderNumber();

		await userEvent.clear(input);
		await userEvent.type(input, "20{Enter}");

		expect(onChange).toHaveBeenCalledExactlyOnceWith(20);
		expect(input).not.toHaveFocus();
	});

	it("IME 変換中の Enter では確定しない", async () => {
		const { onChange, input } = renderNumber();

		await userEvent.clear(input);
		await userEvent.type(input, "20");
		fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
		fireEvent.keyDown(input, { key: "Enter", isComposing: true });

		expect(onChange).not.toHaveBeenCalled();
		expect(input).toHaveFocus();
	});

	it("max を超えた値は max に丸めて表示も戻す", async () => {
		const { onChange, input } = renderNumber();

		await userEvent.clear(input);
		await userEvent.type(input, "100");
		await userEvent.tab();

		expect(onChange).toHaveBeenCalledExactlyOnceWith(32);
		expect(input).toHaveValue(32);
	});

	it("min を下回る値は min に丸めて表示も戻す", async () => {
		const { onChange, input } = renderNumber();

		await userEvent.clear(input);
		await userEvent.type(input, "2");
		await userEvent.tab();

		expect(onChange).toHaveBeenCalledExactlyOnceWith(8);
		expect(input).toHaveValue(8);
	});

	it("外から value が変わると表示も変わる", () => {
		const { input, rerenderWithValue } = renderNumber();

		rerenderWithValue(18);

		expect(input).toHaveValue(18);
	});
});

describe("RangeInput", () => {
	function renderRange(onChange = vi.fn()) {
		render(
			<RangeInput
				id="r"
				label="余白"
				value={20}
				min={0}
				max={50}
				step={1}
				unit="mm"
				onChange={onChange}
			/>,
		);
		return {
			onChange,
			slider: screen.getByRole("slider", { name: "余白" }),
			text: screen.getByRole("textbox", { name: "余白の値" }),
		};
	}

	it("スライダーを動かすと数値で渡す", () => {
		const { onChange, slider } = renderRange();

		fireEvent.change(slider, { target: { value: "30" } });

		expect(onChange).toHaveBeenCalledExactlyOnceWith(30);
	});

	it("テキスト欄は blur で確定する", async () => {
		const { onChange, text } = renderRange();

		await userEvent.clear(text);
		await userEvent.type(text, "35");
		expect(onChange).not.toHaveBeenCalled();

		await userEvent.tab();
		expect(onChange).toHaveBeenCalledExactlyOnceWith(35);
	});

	it("テキスト欄は Enter で確定する", async () => {
		const { onChange, text } = renderRange();

		await userEvent.clear(text);
		await userEvent.type(text, "35{Enter}");

		expect(onChange).toHaveBeenCalledExactlyOnceWith(35);
		expect(text).not.toHaveFocus();
	});

	it("IME 変換中の Enter では確定しない", async () => {
		const { onChange, text } = renderRange();

		await userEvent.clear(text);
		await userEvent.type(text, "35");
		fireEvent.keyDown(text, { key: "Enter", keyCode: 229 });
		fireEvent.keyDown(text, { key: "Enter", isComposing: true });

		expect(onChange).not.toHaveBeenCalled();
		expect(text).toHaveFocus();
	});

	it("範囲外の値は min / max に丸める", async () => {
		const { onChange, text } = renderRange();

		await userEvent.clear(text);
		await userEvent.type(text, "99");
		await userEvent.tab();
		await userEvent.clear(text);
		await userEvent.type(text, "-5");
		await userEvent.tab();

		expect(onChange.mock.calls).toEqual([[50], [0]]);
	});

	it("数値でない入力は onChange を呼ばず表示を value に戻す", async () => {
		const { onChange, text } = renderRange();

		await userEvent.clear(text);
		await userEvent.type(text, "abc");
		await userEvent.tab();

		expect(onChange).not.toHaveBeenCalled();
		expect(text).toHaveValue("20");
	});

	it("入力せずに blur しても onChange を呼ばない", async () => {
		const { onChange, text } = renderRange();

		await userEvent.click(text);
		await userEvent.tab();

		expect(onChange).not.toHaveBeenCalled();
	});

	it("テキスト欄の入力途中でスライダーを動かすと、入力途中の値を捨てる", async () => {
		const { onChange, slider, text } = renderRange();

		await userEvent.clear(text);
		await userEvent.type(text, "4");
		fireEvent.change(slider, { target: { value: "30" } });

		expect(text).toHaveValue("20");
		await userEvent.click(text);
		await userEvent.tab();
		expect(onChange).toHaveBeenCalledExactlyOnceWith(30);
	});
});

describe.each([
	{ name: "TextInput", Input: TextInput },
	{ name: "TextareaInput", Input: TextareaInput },
])("$name", ({ Input }) => {
	const getField = () => screen.getByRole("textbox", { name: "ブランチ" });

	function Controlled({
		initial,
		onChange,
	}: {
		initial: string;
		onChange: (value: string) => void;
	}) {
		const [value, setValue] = useState(initial);
		return (
			<Input
				id="x"
				label="ブランチ"
				value={value}
				onChange={(v) => {
					onChange(v);
					setValue(v);
				}}
			/>
		);
	}

	it("入力中は onChange を呼ばず、blur で確定する", async () => {
		const onChange = vi.fn();
		render(<Input id="x" label="ブランチ" value="main" onChange={onChange} />);

		await userEvent.type(getField(), "-dev");
		expect(onChange).not.toHaveBeenCalled();

		await userEvent.tab();
		expect(onChange).toHaveBeenCalledExactlyOnceWith("main-dev");
	});

	it("値が変わっていなければ blur で onChange を呼ばない", async () => {
		const onChange = vi.fn();
		render(<Input id="x" label="ブランチ" value="main" onChange={onChange} />);

		await userEvent.click(getField());
		await userEvent.tab();

		expect(onChange).not.toHaveBeenCalled();
	});

	it("確定前にアンマウントすると、入力途中の値を渡す", async () => {
		const onChange = vi.fn();
		const { unmount } = render(<Input id="x" label="ブランチ" value="main" onChange={onChange} />);

		await userEvent.type(getField(), "-dev");
		unmount();

		expect(onChange).toHaveBeenCalledExactlyOnceWith("main-dev");
	});

	it("値が変わっていなければアンマウントで onChange を呼ばない", () => {
		const onChange = vi.fn();
		const { unmount } = render(<Input id="x" label="ブランチ" value="main" onChange={onChange} />);

		unmount();

		expect(onChange).not.toHaveBeenCalled();
	});

	it("確定済みの値はアンマウントで再送しない", async () => {
		const onChange = vi.fn();
		const { unmount } = render(<Controlled initial="main" onChange={onChange} />);

		await userEvent.type(getField(), "-dev");
		await userEvent.tab();
		unmount();

		expect(onChange).toHaveBeenCalledExactlyOnceWith("main-dev");
	});

	it("onChange を差し替えた後のアンマウントでは、新しい onChange に渡す", async () => {
		const first = vi.fn();
		const second = vi.fn();
		const { rerender, unmount } = render(
			<Input id="x" label="ブランチ" value="main" onChange={first} />,
		);

		await userEvent.type(getField(), "-dev");
		rerender(<Input id="x" label="ブランチ" value="main" onChange={second} />);
		unmount();

		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledExactlyOnceWith("main-dev");
	});

	it("外から value が変わると表示も変わり、アンマウントで再送しない", () => {
		const onChange = vi.fn();
		const { rerender, unmount } = render(
			<Input id="x" label="ブランチ" value="main" onChange={onChange} />,
		);

		rerender(<Input id="x" label="ブランチ" value="develop" onChange={onChange} />);
		expect(getField()).toHaveValue("develop");
		unmount();

		expect(onChange).not.toHaveBeenCalled();
	});
});

describe("TextInput", () => {
	it("Enter で確定する", async () => {
		const onChange = vi.fn();
		render(<TextInput id="x" label="ブランチ" value="main" onChange={onChange} />);

		const input = screen.getByRole("textbox", { name: "ブランチ" });
		await userEvent.type(input, "-dev{Enter}");

		expect(onChange).toHaveBeenCalledExactlyOnceWith("main-dev");
		expect(input).not.toHaveFocus();
	});

	it("IME 変換中の Enter では確定しない", async () => {
		const onChange = vi.fn();
		render(<TextInput id="x" label="ブランチ" value="main" onChange={onChange} />);

		const input = screen.getByRole("textbox", { name: "ブランチ" });
		await userEvent.type(input, "-dev");
		fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
		fireEvent.keyDown(input, { key: "Enter", isComposing: true });

		expect(onChange).not.toHaveBeenCalled();
		expect(input).toHaveFocus();
	});
});

describe("TextareaInput", () => {
	it("Enter は改行として入力され、確定しない", async () => {
		const onChange = vi.fn();
		render(<TextareaInput id="x" label="除外" value=".DS_Store" onChange={onChange} />);

		const textarea = screen.getByRole("textbox", { name: "除外" });
		await userEvent.type(textarea, "{Enter}.git/");

		expect(onChange).not.toHaveBeenCalled();
		expect(textarea).toHaveValue(".DS_Store\n.git/");
		expect(textarea).toHaveFocus();
	});

	it("helperText を渡したときだけ説明文を出す", () => {
		const { container, rerender } = render(
			<TextareaInput
				id="x"
				label="除外"
				value=""
				onChange={vi.fn()}
				helperText="1 行 1 パターン"
			/>,
		);
		expect(screen.getByText("1 行 1 パターン")).toBeInTheDocument();

		rerender(<TextareaInput id="x" label="除外" value="" onChange={vi.fn()} />);
		expect(container.querySelector("p")).toBeNull();
	});
});
