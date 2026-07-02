// #272 で 18 setter に散らばる `normalize? → save → set({[key]: value})` の共通 shape を hoist。
// TValues extends object 制約は、外すと keyof が string|number|symbol へ widen して
// key 引数の narrowing が壊れるため必須。

export function createPersistedSetter<TValues extends object>(
	set: (partial: Partial<TValues>) => void,
	save: (key: keyof TValues, value: unknown) => Promise<void>,
) {
	return <K extends keyof TValues>(
		key: K,
		normalize?: (value: TValues[K]) => TValues[K],
	): ((value: TValues[K]) => void) => {
		return (value: TValues[K]): void => {
			const next = normalize ? normalize(value) : value;
			void save(key, next);
			const patch: Partial<TValues> = {};
			patch[key] = next;
			set(patch);
		};
	};
}
