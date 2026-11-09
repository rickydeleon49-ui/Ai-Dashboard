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
    <Card aria-label="This app usage" className="min-w-0">
      <CardHeader className="min-w-0">
        <CardTitle className="break-words">This app</CardTitle>
      </CardHeader>
      <CardBody className="min-w-0 space-y-4">
        {providers.map(([provider, p]) => {
          const topModels = Object.entries(p.byModel)
            .sort((a, b) => tokens(b[1]) - tokens(a[1]) || b[1].calls - a[1].calls)
            .slice(0, 3);
          return (
            <div key={provider} className="min-w-0 space-y-1 text-[13px] text-muted">
              <p className="flex flex-wrap justify-between gap-1 break-words">
                <span className="font-medium text-fg break-words">{PROVIDER_LABEL[provider] ?? provider}</span>
                <span className={cn(NUM, "whitespace-nowrap")}>
                  {p.today.calls.toLocaleString("en-US")} replies today ·{" "}
                  {p.last7Days.calls.toLocaleString("en-US")} in 7 days
                </span>
              </p>
              <p className="flex flex-wrap justify-between gap-1 break-words">
                <span>Tokens (7 days)</span>
                <span className={cn(NUM, "whitespace-nowrap")}>
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
                <div className="overflow-x-auto min-w-0">
                  <ul className="text-[12px] min-w-0 space-y-0.5">
                    {topModels.map(([model, b]) => (
                      <li key={model} className="flex justify-between gap-2 min-w-0">
                        <span className="break-words min-w-0">{model}</span>
                        <span className={cn(NUM, "whitespace-nowrap shrink-0")}>
                          {b.calls.toLocaleString("en-US")} replies · {formatCompact(tokens(b))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          );
        })}

        {advisorCalls > 0 ? (
          <div
            className={cn(
              "min-w-0 space-y-1 text-[13px] text-muted",
              providers.length > 0 && "border-t border-line pt-3",
            )}
          >
            <p className="flex flex-wrap justify-between gap-1 break-words">
              <span className="font-medium text-fg break-words">LM Studio advisor</span>
              <span className={cn(NUM, "whitespace-nowrap")}>
                {app.advisor.today.calls.toLocaleString("en-US")} calls today ·{" "}
                {advisorCalls.toLocaleString("en-US")} in 7 days
              </span>
            </p>
            {app.advisor.last7Days.failed > 0 ? (
              <p className={cn("text-red-500 break-words", NUM)}>
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
