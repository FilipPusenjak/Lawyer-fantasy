/**
 * Site admins are the only users who can create leagues. Admin is a flag on
 * the user row (users.is_admin), granted after the real person has signed up:
 *
 *   npm run make-admin -- <username>            # grant
 *   npm run make-admin -- <username> --revoke   # revoke
 *
 * (It used to come from an ADMIN_USERNAMES list, but then the first person to
 * sign up with a listed name became admin.)
 */
export function isAdminUser(u: { isAdmin: boolean }): boolean {
  return u.isAdmin;
}
