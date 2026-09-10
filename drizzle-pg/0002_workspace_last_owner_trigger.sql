-- Custom SQL migration file, put your code below! --

-- A workspace must always keep at least one owner. This can't be a CHECK
-- constraint (it depends on other rows, not just the one being written) and
-- an app-level "count owners, then delete" is racy under concurrent requests
-- unless every caller remembers to take a row lock — a trigger protects every
-- write path, including ones added later that never read this comment.
--
-- Fires on DELETE (removing an owner's membership row) and on UPDATE where
-- an owner's role is changing to something else (demotion). A workspace's
-- own deletion cascades its members away too, which is fine — the workspace
-- no longer exists, so there is no "last owner" left to protect — hence the
-- EXISTS guard below, skipping the check once the workspace row itself is
-- gone.
--
-- This must be an AFTER trigger, not BEFORE (verified directly, the hard
-- way): deleting a *user* who is a workspace's creator cascades down two
-- independent FK paths at once — workspace.created_by (deletes the
-- workspace) and workspace_member.user_id (deletes that user's membership
-- rows directly) — and Postgres does not guarantee the workspace-deleting
-- path completes before the membership-deleting path runs its BEFORE
-- triggers. A BEFORE trigger can therefore see the workspace row still
-- present and wrongly block the deletion. Row-level AFTER triggers are
-- queued and fire once the whole statement — including every cascaded
-- action it triggered, on any table — has finished, so by the time this
-- runs, a workspace that was going to disappear already has, and EXISTS
-- correctly says so.
--
-- Being an AFTER trigger also changes what the owner count means: it runs
-- once this row's own change has already been applied, so counting
-- remaining 'owner' rows already excludes it. A two-owner workspace demoting
-- one down to 'member' must be allowed, and by the time this fires that
-- demotion is already applied, so "any owner rows left" (NOT EXISTS) is the
-- right guard — "count <= 1", the equivalent check under BEFORE semantics
-- (where the row-to-change is still counted as an owner), would wrongly
-- reject that two-owner case here, since the one remaining owner alone
-- satisfies "<= 1".
CREATE FUNCTION prevent_last_owner_removal() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.role = 'owner' AND (TG_OP = 'DELETE' OR NEW.role <> 'owner') THEN
    IF EXISTS (SELECT 1 FROM workspace WHERE id = OLD.workspace_id)
       AND NOT EXISTS (
         SELECT 1 FROM workspace_member
         WHERE workspace_id = OLD.workspace_id AND role = 'owner'
       ) THEN
      RAISE EXCEPTION 'workspace must retain at least one owner';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workspace_member_last_owner
  AFTER UPDATE OR DELETE ON workspace_member
  FOR EACH ROW EXECUTE FUNCTION prevent_last_owner_removal();
