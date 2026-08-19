import { createClient } from "@/lib/supabase/client";

export interface Project {
  id: string;
  owner_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

/** There's no project management UI yet -- every signed-in user gets exactly
 * one project, created on first visit and reused after. Replace this with a
 * real picker/creation flow once projects need to be more than "the one
 * place a user's assets live." */
export async function getOrCreateDefaultProject(): Promise<Project> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data: existing, error: selectError } = await supabase
    .from("projects")
    .select("*")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (selectError) throw new Error(selectError.message);
  if (existing) return existing;

  const { data: created, error: insertError } = await supabase
    .from("projects")
    .insert({ owner_id: user.id, name: "My Project" })
    .select("*")
    .single();
  if (insertError) throw new Error(insertError.message);
  return created;
}
