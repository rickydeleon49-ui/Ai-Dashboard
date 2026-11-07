"use client";

import {
  CheckCircle2,
  XCircle,
  RefreshCw,
  Cpu,
  Loader2,
} from "lucide-react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { ProviderProbeInfo } from "@/core/agents/provider-probes";

export function ProviderProbesCard({
  providers,
  onRefresh,
  isRefreshing,
}: {
  providers: ProviderProbeInfo[];
  onRefresh: () => void;
  isRefreshing: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between w-full">
          <CardTitle className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-faint" />
            CLI Provider Probes
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={onRefresh}
            disabled={isRefreshing}
            className="gap-1.5"
          >
            {isRefreshing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Re-probe Providers
          </Button>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        <p className="text-[12.5px] leading-relaxed text-muted">
          Provider readiness is probed live on this machine. CLI executables must be installed and signed in.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          {providers.map((p) => (
            <div
              key={p.id}
              className="rounded-lg border border-line bg-[var(--bg-subtle)] p-3.5 space-y-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-[13px] font-semibold text-fg">{p.name}</h3>
                  {p.executable ? (
                    <p
                      className="text-[11px] font-mono text-faint truncate max-w-[220px]"
                      title={p.executable}
                    >
                      {p.executable}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-col items-end gap-1">
                  {p.installed ? (
                    <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                      <CheckCircle2 className="h-3 w-3" />
                      {p.version ? `v${p.version}` : "Installed"}
                    </Badge>
                  ) : (
                    <Badge className="bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20">
                      <XCircle className="h-3 w-3" />
                      Not Installed
                    </Badge>
                  )}
                  {p.installed ? (
                    p.authenticated === true ? (
                      <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1">
                        ● Signed in
                      </span>
                    ) : p.authenticated === false ? (
                      <span className="text-[10px] text-red-500 font-medium flex items-center gap-1">
                        ● Not signed in
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted font-medium flex items-center gap-1">
                        ○ Auth unknown
                      </span>
                    )
                  ) : null}
                </div>
              </div>

              {p.models && p.models.length > 0 ? (
                <div>
                  <span className="text-[11px] font-medium text-muted block mb-1">
                    Configured models:
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {p.models.map((m) => (
                      <span
                        key={m}
                        className="rounded bg-surface px-1.5 py-0.5 text-[10.5px] font-mono text-muted border border-line"
                      >
                        {m}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              {p.error ? (
                <div className="text-[11px] text-red-500/90 bg-red-500/5 rounded p-2 border border-red-500/10">
                  {p.error}
                </div>
              ) : null}

              {!p.installed && p.tried && p.tried.length > 0 ? (
                <div className="text-[11px] text-faint">
                  <span className="font-medium">Paths checked:</span>
                  <ul className="mt-0.5 list-disc list-inside font-mono text-[10px] truncate">
                    {p.tried.slice(0, 3).map((t) => (
                      <li key={t} title={t} className="truncate">
                        {t}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}
