-- EventSync: bootstrap the first administrator.
-- IMPORTANT: Create/sign in the intended account via Supabase Auth FIRST.
-- Replace the email below with the exact email address of that account, then run as project owner in SQL Editor.
-- Never expose the database password or Supabase service-role key in frontend code.

DO $$
DECLARE
  target_email text := 'replace-with-your-admin-email@example.com';
  target_user_id uuid;
BEGIN
  IF target_email = 'replace-with-your-admin-email@example.com' THEN
    RAISE EXCEPTION 'Edit target_email in this script before running it.';
  END IF;

  SELECT id INTO target_user_id
  FROM auth.users
  WHERE lower(email) = lower(target_email)
  LIMIT 1;

  IF target_user_id IS NULL THEN
    RAISE EXCEPTION 'No Supabase Auth user found for email %. Sign up first.', target_email;
  END IF;

  UPDATE public.user_profiles
  SET role = 'admin', client_id = NULL, updated_at = now()
  WHERE user_id = target_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found for %. Check that the auth trigger/migrations were installed.', target_email;
  END IF;
END $$;
