-- Phase 2C.1: Ensure workspace always retains at least one ACTIVE owner.
-- Extends migration 0002 to cover member status changes (suspension or removal)
-- as well as role demotions and row deletions.
CREATE OR REPLACE FUNCTION prevent_last_owner_removal() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.role = 'owner' AND OLD.status = 'active' AND (TG_OP = 'DELETE' OR NEW.role <> 'owner' OR NEW.status <> 'active') THEN
    IF EXISTS (SELECT 1 FROM workspace WHERE id = OLD.workspace_id)
       AND NOT EXISTS (
         SELECT 1 FROM workspace_member
         WHERE workspace_id = OLD.workspace_id AND role = 'owner' AND status = 'active'
       ) THEN
      RAISE EXCEPTION 'workspace must retain at least one owner';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS workspace_member_last_owner ON workspace_member;
--> statement-breakpoint
CREATE TRIGGER workspace_member_last_owner
  AFTER UPDATE OR DELETE ON workspace_member
  FOR EACH ROW EXECUTE FUNCTION prevent_last_owner_removal();
