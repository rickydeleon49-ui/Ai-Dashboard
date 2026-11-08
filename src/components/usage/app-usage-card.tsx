import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import type { AppUsageBucket, AppUsageSummary } from "@/core/usage/app-usage";
import { formatCompact } from "@/lib/usage-format";
import { cn } from "@/lib/utils";

const NUM = "tabular-nums";

const PROVIDER_LABEL: Record<string, string> = {
  local: "Ollama (local)",
  hermes: "Hermes",
};

function tokens(b: AppUsageBucket): number {
  return b.promptTokens + b.completionTokens;
}

/**
 * The app's own usage: Ollama / Hermes chat replies and the LM Studio advisor.
 * Hidden when there is nothing to show.
 */
export function AppUsageCard({ app }: { app: AppUsageSummary | null | undefined }) {
  if (!app) return null;

  const providers = Object.entries(app.chat).filter(([, p]) => p.last7Days.calls > 0);
  const advisorCalls = app.advisor.last7Days.calls;
  if (providers.length === 0 && advisorCalls === 0) return null;

  return (
    <Card aria-label="This app usage">
      <CardHeader>
        <CardTitle>This app</CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        {providers.map(([provider, p]) => {
          const topModels = Object.entries(p.byModel)
            .sort((a, b) => tokens(b[1]) - tokens(a[1]) || b[1].calls - a[1].calls)
            .slice(0, 3);
          return (
            <div key={provider} className="space-y-1 text-[13px] text-muted">
              <p className="flex justify-between gap-2">
                <span className="font-medium text-fg">{PROVIDER_LABEL[provider] ?? provider}</span>
                <span className={NUM}>
                  {p.today.calls.toLocaleString("en-US")} replies today ·{" "}
                  {p.last7Days.calls.toLocaleString("en-US")} in 7 days
                </span>
              </p>
              <p className="flex justify-between gap-2">
                <span>Tokens (7 days)</span>
                <span className={NUM}>
                  <span className="text-fg">{formatCompact(tokens(p.last7Days))}</span>
                  {p.last7Days.tokensUnknown > 0 ? (
                    <span className="text-faint">
                      {" "}
                      · {p.last7Days.tokensUnknown.toLocaleString("en-US")} without counts
                    </span>
                  ) : null}
                </span>
              </p>
              {topModels.length > 0 ? (
                <ul className="text-[12px]">
                  {topModels.map(([model, b]) => (
                    <li key={model} className="flex justify-between gap-2">
                      <span className="truncate">{model}</span>
                      <span className={NUM}>
                        {b.calls.toLocaleString("en-US")} replies · {formatCompact(tokens(b))}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}

        {advisorCalls > 0 ? (
          <div
            className={cn(
              "space-y-1 text-[13px] text-muted",
              providers.length > 0 && "border-t border-line pt-3",
            )}
          >
            <p className="flex justify-between gap-2">
              <span className="font-medium text-fg">LM Studio advisor</span>
              <span className={NUM}>
                {app.advisor.today.calls.toLocaleString("en-US")} calls today ·{" "}
                {advisorCalls.toLocaleString("en-US")} in 7 days
              </span>
            </p>
            {app.advisor.last7Days.failed > 0 ? (
              <p className={cn("text-red-500", NUM)}>
                {app.advisor.today.failed > 0
                  ? `${app.advisor.today.failed.toLocaleString("en-US")} failed today · `
                  : ""}
                {app.advisor.last7Days.failed.toLocaleString("en-US")} failed in 7 days
              </p>
            ) : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
