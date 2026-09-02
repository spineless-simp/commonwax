export type Theme = "dark" | "dim" | "light" | "dark-hc" | "light-hc" | "win95" | "xp-mce";

export const THEMES: { value: Theme; label: string; hint: string }[] = [
  { value: "dark", label: "Dark", hint: "The default listening surface" },
  { value: "dim", label: "Dim", hint: "A muted middle ground — dimmer than Light" },
  { value: "light", label: "Light", hint: "A bright surface with the same layout" },
  { value: "dark-hc", label: "Dark, high contrast", hint: "Pure black with sharper edges and text" },
  { value: "light-hc", label: "Light, high contrast", hint: "Pure white with sharper edges and text" },
  { value: "win95", label: "Windows 95", hint: "A gray, beveled, mid-90s desktop" },
  { value: "xp-mce", label: "Windows XP Media Center Edition", hint: "Luna blue, rolling hills, and a green Start-style play button" },
];

export const CHROME_BY_THEME: Record<Theme, string> = {
  dark: "#080a09",
  dim: "#262922",
  light: "#ececE6",
  "dark-hc": "#000000",
  "light-hc": "#ffffff",
  win95: "#d4d0c8",
  "xp-mce": "#245edb",
};

export function currentTheme(): Theme {
  return (localStorage.getItem("cw:theme") as Theme) || "dark";
}

export function applyTheme(theme: Theme) {
  if (theme === "dark") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("cw:theme", theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", CHROME_BY_THEME[theme]);
}
