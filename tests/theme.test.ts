import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { themeScript } from "../src/lib/theme.ts";

function browser(saved: string | null, systemDark: boolean, blocked = false) {
  let dark = false;
  const context = {
    document: { documentElement: { classList: {
      toggle: (_name: string, force?: boolean) => (dark = force ?? !dark),
    } } },
    localStorage: {
      getItem: () => { if (blocked) throw Error("Storage blocked"); return saved; },
      setItem: (_key: string, value: string) => { if (blocked) throw Error("Storage blocked"); saved = value; },
    },
    window: { matchMedia: () => ({ matches: systemDark }) },
  };
  return { context, isDark: () => dark, saved: () => saved };
}

test("first paint honours saved mode, otherwise the system preference", () => {
  for (const [saved, system, expected] of [
    ["dark", false, true], ["light", true, false],
    [null, true, true], [null, false, false], ["invalid", true, true],
  ] as const) {
    const state = browser(saved, system);
    runInNewContext(themeScript, state.context);
    assert.equal(state.isDark(), expected);
  }
});

test("switch toggles both ways, persists, and works when storage is blocked", () => {
  const source = readFileSync(new URL("../src/components/ThemeToggle.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  for (const blocked of [false, true]) {
    const state = browser(null, true, blocked);
    runInNewContext(themeScript, state.context);
    assert.equal(state.isDark(), true);
    const exports: any = {};
    runInNewContext(compiled, {
      ...state.context, exports,
      require: (name: string) => name === "lucide-react" ? { Moon: "moon", Sun: "sun" } : {
        jsx: (type: unknown, props: unknown) => ({ type, props }),
        jsxs: (type: unknown, props: unknown) => ({ type, props }),
      },
    });
    const button = exports.ThemeToggle();
    assert.equal(button.props.type, "button");
    assert.ok(button.props["aria-label"]);
    button.props.onClick();
    assert.equal(state.isDark(), false);
    if (!blocked) assert.equal(state.saved(), "light");
    button.props.onClick();
    assert.equal(state.isDark(), true);
    if (!blocked) assert.equal(state.saved(), "dark");
  }
});

test("dark theme text pairs meet 4.5:1 contrast", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const dark = css.match(/\.dark \{([^}]+)\}/)![1];
  const colors = Object.fromEntries([...dark.matchAll(/--([\w-]+): (#[\da-f]{6});/g)].map((m) => [m[1], m[2]]));
  function luminance(hex: string) {
    const channels = hex.slice(1).match(/../g)!.map((c) => {
      const value = parseInt(c, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }
  for (const [fg, bg] of [
    ["foreground", "background"], ["card-foreground", "card"],
    ["popover-foreground", "popover"], ["muted-foreground", "muted"],
    ["primary-foreground", "primary"], ["secondary-foreground", "secondary"],
    ["accent-foreground", "accent"], ["destructive-foreground", "destructive"],
    ["status-in", "card"], ["status-out", "card"], ["status-leave", "card"],
  ]) {
    const a = luminance(colors[fg]), b = luminance(colors[bg]);
    assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5, `${fg} on ${bg}`);
  }
});
