export const themes = [
  { id: 'forest', name: '林间光影', description: '树影、蓝天与油画笔触' },
  { id: 'mountain-blue', name: '山青蓝', description: '青蓝远山与清透冷光' },
  { id: 'wild-red', name: '西野红', description: '暖调红棕与柔和金属光' },
] as const;

export type ThemeId = typeof themes[number]['id'];

export function applyTheme(value: string) {
  const theme = themes.some(item => item.id === value) ? value : 'forest';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('project-grid-theme', theme); } catch {}
}

export function restoreTheme() {
  try { applyTheme(localStorage.getItem('project-grid-theme') || 'forest'); }
  catch { applyTheme('forest'); }
}
