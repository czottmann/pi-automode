import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, fuzzyFilter, matchesKey } from "@earendil-works/pi-tui";
import type { SelectItem } from "@earendil-works/pi-tui";
import { formatModelSpec } from "./model.ts";

/** Interactive model selector shown when `/automode model` is run without arguments. */
export function promptForClassifierModel(
  ctx: ExtensionContext,
  current?: string,
): Promise<string | undefined> {
  if (!ctx.hasUI) {
    return Promise.resolve(undefined);
  }
  const available = ctx.modelRegistry.getAvailable();
  if (available.length === 0) {
    return Promise.resolve(undefined);
  }

  const items: SelectItem[] = available.map((model) => {
    const spec = formatModelSpec(model);
    return {
      value: spec,
      label: `${model.id} \u001b[2m[${model.provider}]\u001b[0m`,
      description: spec === current ? "\u2713" : undefined,
    };
  });
  items.sort((a, b) => a.label.localeCompare(b.label));

  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const filterInput = new Input();
    filterInput.onEscape = () => done(undefined);

    let filtered: SelectItem[] = items;
    let selectList = buildModelList(filtered, theme, filterInput, done, tui);

    function applyFilter(query: string): void {
      filtered = query
        ? fuzzyFilter(items, query, (item) => `${item.label} ${item.value}`)
        : items;
      selectList = buildModelList(filtered, theme, filterInput, done, tui);
      tui.requestRender();
    }

    return {
      render(width: number) {
        const selected = selectList.getSelectedItem();
        const lines: string[] = [];
        lines.push(theme.fg("accent", theme.bold("Select classifier model")));
        lines.push(theme.fg("dim", "Only showing models from configured providers. Use /login to add providers."));
        lines.push("");
        lines.push(filterInput.render(width).join("\n"));
        lines.push("");
        lines.push(...selectList.render(width));
        lines.push("");
        if (selected) {
          lines.push(theme.fg("muted", `Model Name: ${selected.label}`));
        }
        return lines;
      },
      invalidate() {
        /* no-op */
      },
      handleInput(data: string) {
        if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "return") || matchesKey(data, "escape")) {
          selectList.handleInput(data);
          tui.requestRender();
          return;
        }
        filterInput.handleInput(data);
        applyFilter(filterInput.getValue());
      },
    };
  });
}

function buildModelList(
  items: SelectItem[],
  theme: any,
  filterInput: Input,
  done: (value: string | undefined) => void,
  tui: any,
): SelectList {
  const maxVisible = Math.min(10, Math.max(1, items.length));
  const list = new SelectList(items, maxVisible, {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
  });
  list.setSelectedIndex(0);
  list.onCancel = () => done(undefined);
  list.onSelect = (item) => done(item.value);
  list.onSelectionChange = () => tui.requestRender();
  filterInput.onSubmit = () => {
    const selected = list.getSelectedItem();
    if (selected) done(selected.value);
  };
  return list;
}
