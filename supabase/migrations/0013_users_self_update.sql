-- 0013_users_self_update.sql
--
-- public.users had RLS enabled with only a SELECT policy (0002). Direct
-- UPDATEs from `authenticated` silently affected 0 rows, which made
-- `updateUserDisplayName()` and the web-search active-provider picker
-- claim success in the API while leaving the row untouched in the DB.
--
-- Supabase's default GRANTs on public.users give `authenticated` write
-- access to every column; the only safety so far was the missing UPDATE
-- policy. Replace that double-implicit lockout with explicit control:
-- column-scoped UPDATE grants for the writable surfaces, plus a row-
-- scoped UPDATE policy so users can only touch their own row.
--
-- Writable columns today: display_name, preferred_web_search_provider_id.
-- Sensitive columns (role, is_active, email, id, created_at, last_login_at)
-- stay locked because they are not in the GRANT list — attempts to write
-- them error with `permission denied for table users`.

revoke update on public.users from authenticated;
grant update (display_name, preferred_web_search_provider_id)
  on public.users to authenticated;

create policy users_self_update on public.users
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());
