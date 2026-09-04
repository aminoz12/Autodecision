-- ============================================================================
--  Fix: revoking EXECUTE from PUBLIC on handle_new_user also stripped the
--  internal supabase_auth_admin role, so every auth signup failed with
--  "Database error creating new user". Grant it back explicitly (that role
--  fires the on-auth-user-created trigger).
-- ============================================================================

grant execute on function public.handle_new_user() to supabase_auth_admin;
grant usage on schema public to supabase_auth_admin;
