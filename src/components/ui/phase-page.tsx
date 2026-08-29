import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { PageHeader } from "./page-header";
import { Card, CardBody } from "./card";
import { buttonClasses } from "./button";

export interface PlannedFeature {
  title: string;
  detail: string;
}

/**
 * Shared page for sections whose feature set arrives in a later phase.
 *
 * These are honest scaffolds, not fake screens: the route, navigation entry and
 * data model exist today, and the page says exactly what is coming and what is
 * already in place underneath.
 */
export function PhasePage({
  icon: Icon,
  title,
  description,
  phase,
  foundation,
  features,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  phase: number;
  /** What already exists in the codebase to support this section. */
  foundation: string;
  features: PlannedFeature[];
  action?: { label: string; href: string };
}) {
  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            {title}
            <span className="rounded bg-[var(--bg-subtle)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-faint ring-1 ring-inset ring-[var(--border)]">
              Phase {phase}
            </span>
          </span>
        }
        description={description}
        actions={
          action ? (
            <Link href={action.href} className={buttonClasses("secondary", "md")}>
              {action.label}
            </Link>
          ) : undefined
        }
      />

      <Card>
        <CardBody className="flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-[var(--bg-subtle)]">
            <Icon className="h-4 w-4 text-muted" strokeWidth={1.75} />
          </span>
          <div>
            <p className="text-[13px] font-medium text-fg">Already in place</p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">
              {foundation}
            </p>
          </div>
        </CardBody>
      </Card>

      <section className="space-y-2.5">
        <h2 className="text-[13px] font-semibold tracking-tight text-fg">
          Planned for this section
        </h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-lg border border-dashed border-line bg-surface/40 px-3.5 py-3"
            >
              <p className="text-[13px] font-medium text-fg">{feature.title}</p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">
                {feature.detail}
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
