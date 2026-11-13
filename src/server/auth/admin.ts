/**
 * Site admins are the only users who can create leagues. A user is an admin if
 * users.is_admin is true or their username is listed in ADMIN_USERNAMES.
 */
export function adminUsernames(): string[] {
  return (process.env.ADMIN_USERNAMES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminUser(u: { username: string; isAdmin: boolean }): boolean {
  return u.isAdmin || adminUsernames().includes(u.username.toLowerCase());
}
