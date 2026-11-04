// @ts-check
// Expressive Code (code blocks) for the krun site: two small hand-made themes
// that reuse the site palette, a copy button on every block, and soft wrapping
// that keeps indentation so long commands stay readable on phones.
import { defineEcConfig, ExpressiveCodeTheme } from "@astrojs/starlight/expressive-code";

/**
 * @param {{ name: string, type: "dark" | "light", bg: string, fg: string, chrome: string,
 *   line: string, comment: string, keyword: string, string: string, number: string,
 *   fn: string, key: string, punctuation: string, selection: string }} p
 */
function theme(p) {
  return new ExpressiveCodeTheme({
    name: p.name,
    type: p.type,
    colors: {
      "editor.background": p.bg,
      "editor.foreground": p.fg,
      "editor.selectionBackground": p.selection,
      "editorGroupHeader.tabsBackground": p.chrome,
      "tab.activeBackground": p.bg,
      "tab.activeForeground": p.fg,
      "tab.inactiveForeground": p.comment,
      "tab.border": p.line,
      "editorGroup.border": p.line,
      "terminal.background": p.bg,
      "terminal.foreground": p.fg,
      focusBorder: p.keyword,
    },
    tokenColors: [
      {
        scope: ["comment", "punctuation.definition.comment"],
        settings: { foreground: p.comment, fontStyle: "italic" },
      },
      {
        scope: [
          "keyword",
          "storage",
          "keyword.operator",
          "storage.type",
          "constant.language.boolean",
        ],
        settings: { foreground: p.keyword },
      },
      {
        scope: ["string", "string.quoted", "markup.inline.raw"],
        settings: { foreground: p.string },
      },
      {
        scope: [
          "constant.numeric",
          "constant.language",
          "support.constant",
          "constant.other",
          "variable.other.constant",
        ],
        settings: { foreground: p.number },
      },
      {
        scope: [
          "entity.name.function",
          "support.function",
          "meta.function-call",
          "entity.name.command",
          "support.function.builtin",
        ],
        settings: { foreground: p.fn },
      },
      {
        scope: [
          "entity.name.tag",
          "support.type.property-name",
          "meta.object-literal.key",
          "entity.other.attribute-name",
          "variable.other.property",
        ],
        settings: { foreground: p.key },
      },
      {
        scope: ["entity.name.type", "support.type", "support.class", "entity.name.class"],
        settings: { foreground: p.number },
      },
      {
        scope: ["variable.parameter", "variable.other.readwrite", "variable"],
        settings: { foreground: p.fg },
      },
      {
        scope: ["punctuation", "meta.brace", "punctuation.separator", "punctuation.terminator"],
        settings: { foreground: p.punctuation },
      },
      { scope: ["markup.deleted"], settings: { foreground: p.keyword } },
      { scope: ["markup.inserted"], settings: { foreground: p.string } },
    ],
  });
}

const night = theme({
  name: "krun-night",
  type: "dark",
  bg: "#1a1822",
  fg: "#eae5da",
  chrome: "#15131b",
  line: "#2e2b38",
  comment: "#948ea3",
  keyword: "#ff7a4a",
  string: "#d4f53c",
  number: "#a9b0ff",
  fn: "#ffc870",
  key: "#e7a6ff",
  punctuation: "#b3adbf",
  selection: "#3a3648",
});

const day = theme({
  name: "krun-day",
  type: "light",
  bg: "#fffdf7",
  fg: "#2a2733",
  chrome: "#f1ecdf",
  line: "#ddd5c4",
  comment: "#6b6577",
  keyword: "#b63a0b",
  string: "#4a6400",
  number: "#3a47e8",
  fn: "#8a4b00",
  key: "#7c2d92",
  punctuation: "#55505f",
  selection: "#f3dccd",
});

export default defineEcConfig({
  themes: [night, day],
  // Starlight switches themes with its own data-theme attribute.
  useStarlightDarkModeSwitch: true,
  useStarlightUiThemeColors: false,
  // Keep the contrast floor above WCAG AA for every token.
  minSyntaxHighlightingColorContrast: 5,
  defaultProps: {
    wrap: true,
    preserveIndent: true,
  },
  styleOverrides: {
    borderRadius: "0.75rem",
    borderWidth: "1px",
    borderColor: ({ theme }) => (theme.type === "dark" ? "#2e2b38" : "#ddd5c4"),
    codeFontFamily: "var(--__sl-font-mono)",
    codeFontSize: "0.875rem",
    codeLineHeight: "1.7",
    codePaddingBlock: "1rem",
    codePaddingInline: "1.25rem",
    uiFontFamily: "var(--__sl-font-mono)",
    uiFontSize: "0.75rem",
    uiFontWeight: "500",
    focusBorder: ({ theme }) => (theme.type === "dark" ? "#ff7a4a" : "#b63a0b"),
    frames: {
      shadowColor: "transparent",
      frameBoxShadowCssValue: "none",
      editorTabBarBackground: ({ theme }) => (theme.type === "dark" ? "#15131b" : "#f1ecdf"),
      editorActiveTabBackground: ({ theme }) => (theme.type === "dark" ? "#1a1822" : "#fffdf7"),
      editorActiveTabIndicatorTopColor: ({ theme }) =>
        theme.type === "dark" ? "#ff5a1f" : "#ff5a1f",
      editorActiveTabIndicatorBottomColor: "transparent",
      editorTabBarBorderBottomColor: ({ theme }) => (theme.type === "dark" ? "#2e2b38" : "#ddd5c4"),
      terminalTitlebarBackground: ({ theme }) => (theme.type === "dark" ? "#15131b" : "#f1ecdf"),
      terminalTitlebarBorderBottomColor: ({ theme }) =>
        theme.type === "dark" ? "#2e2b38" : "#ddd5c4",
      terminalTitlebarDotsForeground: ({ theme }) =>
        theme.type === "dark" ? "#ff5a1f" : "#ff5a1f",
      terminalTitlebarDotsOpacity: "0.85",
      terminalBackground: ({ theme }) => (theme.type === "dark" ? "#1a1822" : "#fffdf7"),
      inlineButtonBackground: ({ theme }) => (theme.type === "dark" ? "#eae5da" : "#2a2733"),
      inlineButtonBackgroundIdleOpacity: "0",
      inlineButtonBackgroundHoverOrFocusOpacity: "0.12",
      inlineButtonBorder: ({ theme }) => (theme.type === "dark" ? "#eae5da" : "#2a2733"),
      inlineButtonForeground: ({ theme }) => (theme.type === "dark" ? "#eae5da" : "#2a2733"),
      tooltipSuccessBackground: "#d4f53c",
      tooltipSuccessForeground: "#17151e",
    },
  },
});
