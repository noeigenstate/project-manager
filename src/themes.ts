export const themes = [
  { id: 'forest', name: '林间光影', description: 'High Sierra · 山湖与秋日林光' },
  { id: 'mountain-blue', name: '山青蓝', description: 'Big Sur · 青山与蔚蓝海岸' },
  { id: 'wild-red', name: '西野红', description: 'Sierra · 暮色云霞与暖红山峰' },
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
