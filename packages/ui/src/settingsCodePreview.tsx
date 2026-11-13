import type { Theme } from "@/useTheme.js";
import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command.js";
import { resolveTheme } from "@/useTheme.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  selectTriggerVariants,
} from "@/components/ui/select.js";
import {
  getThemeOptionLabel,
  SettingsRow,
  ThemePreviewCard,
  ThemeSelect,
} from "@/settings/SettingsPageParts.js";
import { getCodePreviewTheme } from "@/lib/codePreviewPreferences.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getCodeFontFamilyCss, normalizeCodeFontFamily } from "@/lib/codePreviewSettings.js";
import { useSystemFonts } from "@/hooks/usePlatform.js";
import type { CodePreviewSettings } from "@/store/index.js";
import { THEME_MODES } from "@/settings/settingsPageConfig.js";
import { MAX_UI_FONT_SIZE_PX, MIN_UI_FONT_SIZE_PX } from "@/lib/uiFontSize.js";

function FontSizeInput({
  value,
  min,
  max,
  ariaLabel,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  ariaLabel: string;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  const commit = () => {
    const parsed = draft.trim() === "" ? Number.NaN : Number(draft);
    const nextValue = Number.isFinite(parsed)
      ? Math.min(max, Math.max(min, Math.round(parsed)))
      : value;
    setDraft(String(nextValue));
    if (nextValue !== value) {
      onChange(nextValue);
    }
  };

  return (
    <div className="relative w-28">
      <Input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={draft}
        aria-label={ariaLabel}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(String(value));
          }
        }}
        className="pr-8 text-right tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-ui-lg text-foreground-subtle">
        px
      </span>
    </div>
  );
}

export function AppearanceSectionContent({
  codePreviewSettings,
  setCodePreviewSettings,
  theme,
  setTheme,
  uiFontSizePx,
  setUiFontSizePx,
}: {
  codePreviewSettings: CodePreviewSettings;
  setCodePreviewSettings: (settings: Partial<CodePreviewSettings>) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  uiFontSizePx: number;
  setUiFontSizePx: (fontSizePx: number) => void;
}) {
  const { intl } = useZCodeIntl();
  const activePreviewMode = resolveTheme(theme);
  const systemFonts = useSystemFonts();
  const [fontPickerOpen, setFontPickerOpen] = useState(false);
  const [fontQuery, setFontQuery] = useState("");
  const fontFamilies =
    systemFonts.result?.status === "available" ? systemFonts.result.families : [];
  const filteredFontFamilies = fontFamilies.filter(
    (family) =>
      family !== "default" &&
      family.toLocaleLowerCase().includes(fontQuery.trim().toLocaleLowerCase()),
  );
  const selectFont = (family: string) => {
    setCodePreviewSettings({ fontFamily: normalizeCodeFontFamily(family) });
    setFontPickerOpen(false);
  };
  const selectedFont = codePreviewSettings.fontFamily;
  const selectedFontMissing = selectedFont !== "default" && !fontFamilies.includes(selectedFont);
  const fontStatusId = systemFonts.loading
    ? "common.loading"
    : systemFonts.result?.status === "unsupported"
      ? "settings.codeFontFamilyUnsupported"
      : systemFonts.result?.status === "denied"
        ? "settings.codeFontFamilyDenied"
        : systemFonts.result?.status === "error"
          ? "settings.codeFontFamilyError"
          : systemFonts.result?.status === "available" && fontFamilies.length === 0
            ? "settings.codeFontFamilyEmpty"
            : null;

  return (
    <>
      <div className="min-w-0 space-y-3">
        <div>
          <h3 className="text-ui-lg font-semibold text-foreground">
            {intl.formatMessage({ id: "settings.appearance.interfaceTitle" })}
          </h3>
          <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({
              id: "settings.appearance.interfaceDescription",
            })}
          </p>
        </div>
        <Card className="border border-border bg-card py-0 shadow-none">
          <CardContent className="space-y-0 px-0">
            <SettingsRow
              searchId="settings.themeMode"
              label={intl.formatMessage({ id: "settings.themeMode" })}
              description={intl.formatMessage({
                id: "settings.themeModeDescription",
              })}
              control={
                <Select value={theme} onValueChange={(value) => setTheme(value as Theme)}>
                  <SelectTrigger size="lg" className="w-[260px] min-w-0 justify-between">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {THEME_MODES.map(({ mode, icon: Icon }) => (
                      <SelectItem key={mode} value={mode}>
                        <div className="flex items-center gap-2">
                          <Icon className="size-4" />
                          {intl.formatMessage({
                            id: `settings.themeMode.${mode}`,
                          })}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
            <SettingsRow
              searchId="settings.uiFontSize"
              label={intl.formatMessage({ id: "settings.uiFontSize" })}
              description={intl.formatMessage({
                id: "settings.uiFontSizeDescription",
              })}
              control={
                <FontSizeInput
                  key={uiFontSizePx}
                  min={MIN_UI_FONT_SIZE_PX}
                  max={MAX_UI_FONT_SIZE_PX}
                  value={uiFontSizePx}
                  onChange={setUiFontSizePx}
                  ariaLabel={intl.formatMessage({ id: "settings.uiFontSize" })}
                />
              }
            />
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        <div className="min-w-0 space-y-3">
          <div>
            <h3 className="text-ui-lg font-semibold text-foreground">
              {intl.formatMessage({ id: "settings.appearance.codeTitle" })}
            </h3>
            <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">
              {intl.formatMessage({
                id: "settings.appearance.codeDescription",
              })}
            </p>
          </div>
          <Card className="border border-border bg-card py-0 shadow-none [&_[data-slot=select-trigger]]:w-full">
            <CardContent className="space-y-0 px-0">
              <SettingsRow
                searchId="settings.lightTheme"
                label={intl.formatMessage({ id: "settings.lightTheme" })}
                description={intl.formatMessage({
                  id: "settings.lightThemeDescription",
                })}
                control={
                  <ThemeSelect
                    value={codePreviewSettings.lightTheme}
                    onValueChange={(value) => setCodePreviewSettings({ lightTheme: value })}
                  />
                }
              />
              <SettingsRow
                searchId="settings.darkTheme"
                label={intl.formatMessage({ id: "settings.darkTheme" })}
                description={intl.formatMessage({
                  id: "settings.darkThemeDescription",
                })}
                control={
                  <ThemeSelect
                    value={codePreviewSettings.darkTheme}
                    onValueChange={(value) => setCodePreviewSettings({ darkTheme: value })}
                  />
                }
              />
              <SettingsRow
                searchId="settings.showLineNumbers"
                label={intl.formatMessage({ id: "settings.showLineNumbers" })}
                description={intl.formatMessage({
                  id: "settings.showLineNumbersDescription",
                })}
                control={
                  <Switch
                    checked={codePreviewSettings.showLineNumbers}
                    onCheckedChange={(checked) =>
                      setCodePreviewSettings({ showLineNumbers: checked })
                    }
                  />
                }
              />
              <SettingsRow
                searchId="settings.wrapLongLines"
                label={intl.formatMessage({ id: "settings.wrapLongLines" })}
                description={intl.formatMessage({
                  id: "settings.wrapLongLinesDescription",
                })}
                control={
                  <Switch
                    checked={codePreviewSettings.wrapLongLines}
                    onCheckedChange={(checked) =>
                      setCodePreviewSettings({ wrapLongLines: checked })
                    }
                  />
                }
              />
              <SettingsRow
                searchId="settings.codeFontFamily"
                label={intl.formatMessage({ id: "settings.codeFontFamily" })}
                description={intl.formatMessage({ id: "settings.codeFontFamilyDescription" })}
                control={
                  <Popover
                    open={fontPickerOpen}
                    onOpenChange={(open) => {
                      setFontPickerOpen(open);
                      if (open) {
                        setFontQuery("");
                        void systemFonts.load();
                      }
                    }}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        size="lg"
                        role="combobox"
                        aria-expanded={fontPickerOpen}
                        aria-label={intl.formatMessage({ id: "settings.codeFontFamily" })}
                        className={cn(selectTriggerVariants({ size: "lg" }), "w-full min-w-0")}
                      >
                        <span className="min-w-0 truncate">
                          {selectedFont === "default"
                            ? intl.formatMessage({ id: "settings.codeFontFamilyDefault" })
                            : selectedFont}
                        </span>
                        <ChevronDownIcon className="size-3.5 text-foreground-subtle" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      align="start"
                      data-code-font-popup
                      className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-1rem)] max-h-[min(360px,var(--radix-popover-content-available-height))] gap-0 p-0"
                    >
                      <Command shouldFilter={false} className="h-auto min-h-0">
                        <CommandInput
                          value={fontQuery}
                          onValueChange={setFontQuery}
                          placeholder={intl.formatMessage({ id: "settings.codeFontFamilySearch" })}
                          aria-label={intl.formatMessage({ id: "settings.codeFontFamilySearch" })}
                        />
                        <CommandList className="min-h-0 max-h-none flex-1 overscroll-contain">
                          <CommandItem
                            value="default"
                            data-code-font-option="default"
                            data-checked={selectedFont === "default"}
                            onSelect={() => selectFont("default")}
                          >
                            {intl.formatMessage({ id: "settings.codeFontFamilyDefault" })}
                          </CommandItem>
                          {selectedFontMissing ? (
                            <CommandItem
                              value={selectedFont}
                              disabled
                              data-code-font-option={selectedFont}
                            >
                              <span className="min-w-0 truncate">{selectedFont}</span>
                              {systemFonts.result?.status === "available"
                                ? ` (${intl.formatMessage({ id: "settings.codeFontFamilyMissing" })})`
                                : ""}
                            </CommandItem>
                          ) : null}
                          {fontStatusId ? (
                            <div
                              role="status"
                              className="px-2 py-2 text-ui-base text-foreground-subtle"
                            >
                              {intl.formatMessage({ id: fontStatusId })}
                            </div>
                          ) : null}
                          {!fontStatusId &&
                          fontQuery.trim() &&
                          filteredFontFamilies.length === 0 ? (
                            <div
                              data-slot="command-empty"
                              role="status"
                              className="px-2 py-4 text-center text-ui-base text-foreground-subtle"
                            >
                              {intl.formatMessage({ id: "settings.codeFontFamilyNoMatches" })}
                            </div>
                          ) : null}
                          {filteredFontFamilies.map((family) => (
                            <CommandItem
                              key={family}
                              value={family}
                              data-code-font-option={family}
                              data-code-font-installed="true"
                              data-checked={family === selectedFont}
                              style={{ fontFamily: getCodeFontFamilyCss(family) }}
                              onSelect={() => selectFont(family)}
                            >
                              <span className="min-w-0 truncate">{family}</span>
                            </CommandItem>
                          ))}
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                }
              />
              <SettingsRow
                searchId="settings.fontSize"
                label={intl.formatMessage({ id: "settings.fontSize" })}
                description={intl.formatMessage({
                  id: "settings.fontSizeDescription",
                })}
                control={
                  <FontSizeInput
                    key={codePreviewSettings.fontSizePx}
                    min={12}
                    max={20}
                    value={codePreviewSettings.fontSizePx}
                    onChange={(fontSizePx) => setCodePreviewSettings({ fontSizePx })}
                    ariaLabel={intl.formatMessage({ id: "settings.fontSize" })}
                  />
                }
              />
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <div>
            <h3 className="text-ui-base font-semibold text-foreground">
              {intl.formatMessage({ id: "settings.previewSectionTitle" })}
            </h3>
            <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">
              {intl.formatMessage({ id: "settings.previewDescription" })}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <ThemePreviewCard
              mode="light"
              title={intl.formatMessage({ id: "settings.previewLight" })}
              themeName={getThemeOptionLabel(codePreviewSettings.lightTheme)}
              theme={getCodePreviewTheme("light", codePreviewSettings)}
              isActive={activePreviewMode === "light"}
              showLineNumbers={codePreviewSettings.showLineNumbers}
              wrapLongLines={codePreviewSettings.wrapLongLines}
              fontSizePx={codePreviewSettings.fontSizePx}
            />
            <ThemePreviewCard
              mode="dark"
              title={intl.formatMessage({ id: "settings.previewDark" })}
              themeName={getThemeOptionLabel(codePreviewSettings.darkTheme)}
              theme={getCodePreviewTheme("dark", codePreviewSettings)}
              isActive={activePreviewMode === "dark"}
              showLineNumbers={codePreviewSettings.showLineNumbers}
              wrapLongLines={codePreviewSettings.wrapLongLines}
              fontSizePx={codePreviewSettings.fontSizePx}
            />
          </div>
        </div>
      </div>
    </>
  );
}
