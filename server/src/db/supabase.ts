import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
type WebSocketTransport = new (
  address: string | URL,
  protocols?: string | string[]
) => any;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in server environment.");
}

export const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  realtime: {
    transport: WebSocket as unknown as WebSocketTransport
  }
});
