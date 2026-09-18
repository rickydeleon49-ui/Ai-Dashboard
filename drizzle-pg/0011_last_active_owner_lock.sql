-- Phase 2C.1: Prevent write skew on last active owner check under READ COMMITTED.
--
-- Under PostgreSQL's default READ COMMITTED isolation level, two concurrent
-- transactions each modifying a DIFFERENT owner row in the same workspace
-- (e.g. suspending owner A in tx 1 while suspending owner B in tx 2) would
-- each run their AFTER trigger independently. Because they touch different
-- rows, no row-level lock on workspace_member serializes them, and each
-- transaction's trigger sees the other owner as still active (since the
-- concurrent transaction has not yet committed). Both would pass the
-- NOT EXISTS check and commit, leaving zero active owners.
--
-- To prevent this write skew, the trigger function takes a row lock on the
-- parent workspace row via `PERFORM 1 FROM workspace WHERE id = OLD.workspace_id FOR UPDATE`.
-- This forces all concurrent owner status, role, and deletion changes within
-- the same workspace to serialize. The second transaction blocks until the first
-- commits; once unblocked, PL/pgSQL executes the subsequent query with a fresh
-- snapshot that sees the first transaction's committed change, correctly
-- detecting that no active owners remain and raising the exception.
--
-- `IF FOUND` replaces the old `EXISTS (SELECT 1 FROM workspace WHERE id = OLD.workspace_id)`
-- guard. When a workspace is deleted by the same statement (e.g., cascading from
-- a workspace deletion or user account deletion), the workspace row is gone,
-- `PERFORM ... FOR UPDATE` finds no row (`FOUND` is false), and the check is skipped cleanly.
CREATE OR REPLACE FUNCTION prevent_last_owner_removal() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.role = 'owner' AND OLD.status = 'active'
     AND (TG_OP = 'DELETE' OR NEW.role <> 'owner' OR NEW.status <> 'active') THEN
    PERFORM 1 FROM workspace WHERE id = OLD.workspace_id FOR UPDATE;
    IF FOUND AND NOT EXISTS (
         SELECT 1 FROM workspace_member
         WHERE workspace_id = OLD.workspace_id AND role = 'owner' AND status = 'active'
       ) THEN
      RAISE EXCEPTION 'workspace must retain at least one owner';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
