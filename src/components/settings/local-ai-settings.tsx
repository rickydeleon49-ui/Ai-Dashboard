"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { StatusDot, stateLabel } from "@/components/ai/status-dot";
import { CONTEXT_SIZES, AI_REASONING_EFFORTS, type AiSettings } from "@/core/ai/config";
import type { AiOverview } from "@/core/ai/service";
import { formatBytes } from "@/lib/utils";

/**
 * Local AI configuration and connection diagnostics.
 *
 * Preferences save as they are changed rather than behind a Save button: every
 * control here is a single independent value, and a form that can be left in an
 * unsaved state invites exactly the "I turned that on, why didn't it work"
 * confusion this panel exists to prevent. Text fields commit on blur so a
 * half-typed URL is never stored.
 */
export function LocalAiSettings({ overview }: { overview: AiOverview }) {
  const router = useRouter();
  const [settings, setSettings] = useState<AiSettings>(overview.settings);
  const [status, setStatus] = useState(overview.local);
  const [hermes, setHermes] = useState(overview.hermes);
  const [models, setModels] = useState(overview.models);
  const [loaded, setLoaded] = useState(overview.loaded);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(
    async (update: Partial<AiSettings>) => {
      // Optimistic: the control should not lag behind the click, and a rejected
      // value is replaced by whatever the server says it actually stored.
      setSettings((current) => ({ ...current, ...update }));
      setError(null);

      try {
        const response = await fetch("/api/ai/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        });
        const body = (await response.json()) as { settings?: AiSettings; error?: string };

        if (!response.ok || !body.settings) {
          setError(body.error ?? "Could not save that setting.");
          setSettings(overview.settings);
          return;
        }

        setSettings(body.settings);
        setSaved(true);
        setTimeout(() => setSaved(false), 1800);
        router.refresh();
      } catch {
        setError("Could not reach the server.");
      }
    },
    [overview.settings, router],
  );

  const test = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/ai/status", { cache: "no-store" });
      const body = (await response.json()) as AiOverview;
      setStatus(body.local);
      setHermes(body.hermes);
      setModels(body.models);
      setLoaded(body.loaded);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }, []);

  const unavailable = overview.runtime === "hosted";

  return (
    <div className="space-y-4 min-w-0">
      {unavailable ? (
        <p className="rounded-md border border-line bg-[var(--bg-subtle)] px-2.5 py-2 text-[12.5px] leading-relaxed text-muted break-words">
          This copy runs on a server, so there is no local Ollama to reach. These
          preferences are still saved and apply to the desktop application.
        </p>
      ) : null}

      <Toggle
        label="Enable local AI"
        help="Adds local models to the AI Workspace."
        checked={settings.enabled}
        onChange={(enabled) => save({ enabled })}
      />
      <Toggle
        label="Start Ollama with Command Center"
        help="Only if it is not already running. An instance you started yourself is never stopped."
        checked={settings.autoStart}
        onChange={(autoStart) => save({ autoStart })}
        disabled={!settings.enabled}
      />
      <Toggle
        label="Preload the default model at startup"
        help="Off by default: a large model can hold 11 GB of VRAM before you have asked it anything."
        checked={settings.preloadModel}
        onChange={(preloadModel) => save({ preloadModel })}
        disabled={!settings.enabled || !settings.defaultModel}
      />
      <Toggle
        label="Stream replies"
        help="Show tokens as they arrive instead of waiting for the whole answer."
        checked={settings.streaming}
        onChange={(streaming) => save({ streaming })}
        disabled={!settings.enabled}
      />

      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Default model" help="Used for new conversations.">
          <Select
            value={settings.defaultModel}
            onChange={(event) => save({ defaultModel: event.target.value })}
            disabled={!settings.enabled}
            className="min-h-[40px] md:min-h-0"
          >
            <option value="">First installed model</option>
            {models.map((model) => (
              <option key={model.name} value={model.name}>
                {model.name}
              </option>
            ))}
            {/* A saved model that is no longer installed still has to be
                selectable, or the field would silently show the wrong one. */}
            {settings.defaultModel &&
            !models.some((model) => model.name === settings.defaultModel) ? (
              <option value={settings.defaultModel}>
                {settings.defaultModel} (not installed)
              </option>
            ) : null}
          </Select>
        </Field>

        <Field label="Context window" help="Larger contexts use more VRAM.">
          <Select
            value={String(settings.contextSize)}
            onChange={(event) => save({ contextSize: Number(event.target.value) })}
            disabled={!settings.enabled}
            className="min-h-[40px] md:min-h-0"
          >
            {CONTEXT_SIZES.map((size) => (
              <option key={size} value={size}>
                {size.toLocaleString()}
              </option>
            ))}
            {CONTEXT_SIZES.includes(settings.contextSize as (typeof CONTEXT_SIZES)[number]) ? null : (
              <option value={settings.contextSize}>{settings.contextSize.toLocaleString()}</option>
            )}
          </Select>
        </Field>

        <Field
          label="Unload model after"
          hint="minutes"
          help="0 keeps it loaded until Ollama is stopped."
        >
          <Input
            type="number"
            min={0}
            max={1440}
            value={settings.idleTimeoutMinutes}
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                idleTimeoutMinutes: Number(event.target.value),
              }))
            }
            onBlur={(event) => save({ idleTimeoutMinutes: Number(event.target.value) })}
            disabled={!settings.enabled}
            className="min-h-[40px] md:min-h-0"
          />
        </Field>

        <Field label="Reasoning effort" help="Sent only to models that support it.">
          <Select
            value={settings.reasoningEffort}
            onChange={(event) =>
              save({ reasoningEffort: event.target.value as AiSettings["reasoningEffort"] })
            }
            disabled={!settings.enabled}
            className="min-h-[40px] md:min-h-0"
          >
            {AI_REASONING_EFFORTS.map((effort) => (
              <option key={effort} value={effort}>
                {effort === "default" ? "Model default" : effort}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Default mode" help="Which mode the workspace opens in.">
          <Select
            value={settings.mode}
            onChange={(event) => save({ mode: event.target.value as AiSettings["mode"] })}
            disabled={!settings.enabled}
            className="min-h-[40px] md:min-h-0"
          >
            <option value="chat">Chat</option>
            <option value="agent">Agent</option>
          </Select>
        </Field>

        <Field label="Ollama API URL" help="Change this only if Ollama listens elsewhere.">
          <Input
            value={settings.endpoint}
            onChange={(event) =>
              setSettings((current) => ({ ...current, endpoint: event.target.value }))
            }
            onBlur={(event) => save({ endpoint: event.target.value })}
            spellCheck={false}
            className="font-mono text-[12px] min-h-[40px] md:min-h-0"
            disabled={!settings.enabled}
          />
        </Field>
      </div>

      {/* Diagnostics ------------------------------------------------------ */}
      <div className="space-y-2 border-t border-line pt-3 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-faint">
            Connection
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {saved ? (
              <span className="flex items-center gap-1 text-[11.5px] text-emerald-400">
                <Check className="h-3 w-3" strokeWidth={2} />
                Saved
              </span>
            ) : null}
            <Button type="button" size="sm" className="min-h-[40px] md:min-h-0" onClick={test} disabled={busy}>
              {busy ? (
                <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
              ) : (
                <RefreshCw className="h-3 w-3" strokeWidth={1.75} />
              )}
              Test connection
            </Button>
          </div>
        </div>

        <DiagnosticRow label="Ollama">
          <span className="flex items-center gap-1.5">
            <StatusDot state={status.state} />
            <span className="text-[12.5px] text-fg">{stateLabel(status.state)}</span>
          </span>
        </DiagnosticRow>
        <DiagnosticRow label="API URL">
          <span className="font-mono text-[11.5px] text-muted">{status.endpoint ?? "—"}</span>
        </DiagnosticRow>
        <DiagnosticRow label="Installed models">
          <span className="text-[12.5px] text-muted">
            {models.length === 0 ? "None" : models.map((model) => model.name).join(", ")}
          </span>
        </DiagnosticRow>
        {loaded.length > 0 ? (
          <DiagnosticRow label="In memory">
            <span className="text-[12.5px] text-muted">
              {loaded
                .map((model) =>
                  model.sizeVram > 0
                    ? `${model.name} (${formatBytes(model.sizeVram)})`
                    : model.name,
                )
                .join(", ")}
            </span>
          </DiagnosticRow>
        ) : null}
        <DiagnosticRow label="Hermes">
          <span className="flex items-center gap-1.5">
            <StatusDot state={hermes.state} />
            <span className="text-[12.5px] text-fg">{stateLabel(hermes.state)}</span>
          </span>
        </DiagnosticRow>

        <p className="text-[11.5px] leading-relaxed text-muted break-words">{status.detail}</p>

        {status.error || error ? (
          <details className="pt-0.5">
            <summary className="cursor-pointer text-[11.5px] text-faint hover:text-muted">
              Last error
            </summary>
            <p className="mt-1 break-all font-mono text-[11px] leading-relaxed text-faint">
              {error ?? status.error}
            </p>
          </details>
        ) : null}
      </div>

      {/* Agent ------------------------------------------------------------ */}
      <div className="space-y-3 border-t border-line pt-3 min-w-0">
        <Toggle
          label="Agent integration"
          help="Offers Agent mode in the workspace once Hermes is connected."
          checked={settings.agentEnabled}
          onChange={(agentEnabled) => save({ agentEnabled })}
        />
        <Field
          label="Hermes executable"
          help="Leave empty to find it on your PATH. Command Center detects it but does not run it yet."
        >
          <Input
            value={settings.hermesPath}
            onChange={(event) =>
              setSettings((current) => ({ ...current, hermesPath: event.target.value }))
            }
            onBlur={(event) => save({ hermesPath: event.target.value })}
            placeholder="C:\\Users\\you\\AppData\\Local\\Programs\\Hermes\\hermes.exe"
            spellCheck={false}
            className="font-mono text-[12px] min-h-[40px] md:min-h-0"
          />
        </Field>
        <p className="text-[11.5px] leading-relaxed text-faint break-words">{hermes.detail}</p>
      </div>
    </div>
  );
}

function DiagnosticRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 min-w-0">
      <span className="shrink-0 text-[12.5px] text-muted">{label}</span>
      <span className="min-w-0 break-words md:truncate text-right">{children}</span>
    </div>
  );
}

function Toggle({
  label,
  help,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  help: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 min-w-0 min-h-[40px] md:min-h-0 py-1 md:py-0">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer rounded border-line accent-[var(--accent)] disabled:opacity-50"
      />
      <span className="min-w-0">
        <span className="block text-[13px] text-fg break-words">{label}</span>
        <span className="block text-[11.5px] leading-relaxed text-faint break-words">{help}</span>
      </span>
    </label>
  );
}
