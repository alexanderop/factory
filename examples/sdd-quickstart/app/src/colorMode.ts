export type ColorMode = 'light' | 'dark';

export const COLOR_MODE_STORAGE_KEY = 'color-mode';

export function applyInitialColorMode({
	prefersDark,
	getStored,
}: {
	prefersDark: () => boolean;
	getStored: () => ColorMode | null;
}): void {
	const stored = getStored();
	const isDark = stored !== null ? stored === 'dark' : prefersDark();
	document.documentElement.classList.toggle('dark', isDark);
}

export function toggleColorMode({ setStored }: { setStored: (mode: ColorMode) => void }): void {
	const next: ColorMode = document.documentElement.classList.toggle('dark') ? 'dark' : 'light';
	setStored(next);
}
