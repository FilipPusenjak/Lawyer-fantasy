/**
 * Remove the demo data without re-creating it: demo pools (is_demo = true),
 * every league using them and demo_* users. Nothing else is touched.
 *
 *   npx tsx --env-file=.env.local scripts/reset-demo.ts
 *
 * (`npm run db:seed` already does this before re-seeding.)
 */
import { deleteDemoData } from "./seed";

deleteDemoData().then(
  (r) => {
    console.log(`Removed demo data: ${r.leagues} leagues, ${r.pools} pools, ${r.users} users.`);
    process.exit(0);
  },
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
