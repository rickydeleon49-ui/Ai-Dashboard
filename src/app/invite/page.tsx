import { Mail } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { AcceptInvitationButton } from "@/components/invite/accept-invitation-button";
import type { InvitationFailureReason } from "@/core/workspaces/invitations";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accept invitation" };

const REASON_MESSAGE: Record<InvitationFailureReason, string> = {
  not_found: "This invitation link isn't valid.",
  revoked: "This invitation has been revoked by the workspace.",
  expired: "This invitation has expired. Ask for a new one.",
  already_accepted: "This invitation has already been used.",
  email_mismatch: "This invitation was sent to a different email address.",
  already_member: "You're already a member of this workspace.",
  membership_suspended: "Your membership in this workspace is suspended. An admin or owner must reinstate it.",
};

export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <div className="space-y-5">
        <PageHeader title="Accept invitation" />
        <EmptyState icon={Mail} title="No invitation token" description="This link is missing its token." />
      </div>
    );
  }

  // Hosted multi-user mode only — desktop and single-password hosted mode
  // have no invitations at all, so this cannot call anything that needs
  // DATABASE_URL when it isn't set.
  if (!process.env.DATABASE_URL) {
    return (
      <div className="space-y-5">
        <PageHeader title="Accept invitation" />
        <EmptyState
          icon={Mail}
          title="Not available"
          description="This deployment does not have hosted accounts enabled."
        />
      </div>
    );
  }

  const { previewInvitation } = await import("@/core/workspaces/invitations");
  const preview = await previewInvitation(token);

  return (
    <div className="space-y-5">
      <PageHeader title="Accept invitation" />
      <Card className="max-w-md">
        <CardBody>
          {!preview ? (
            <p className="text-[13px] text-muted">{REASON_MESSAGE.not_found}</p>
          ) : !preview.valid ? (
            <p className="text-[13px] text-muted">
              {REASON_MESSAGE[preview.reason ?? "not_found"]}
            </p>
          ) : (
            <div className="space-y-4">
              <div>
                <p className="text-[13px] text-fg">
                  You&rsquo;ve been invited to join <strong>{preview.workspaceName}</strong> as{" "}
                  <strong>{preview.role}</strong>.
                </p>
                <p className="mt-1 text-[12px] text-faint">Invited: {preview.email}</p>
              </div>
              <AcceptInvitationButton token={token} />
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
