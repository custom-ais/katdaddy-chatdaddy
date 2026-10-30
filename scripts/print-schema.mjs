// Prints the SQL BOB needs in Supabase (schema, row-level security, and the bob_exec function).
import { SCHEMA_SQL, RLS_SQL, RPC_SQL } from "../server/schema.mjs";
console.log([SCHEMA_SQL, RLS_SQL, RPC_SQL].join("\n\n"));
