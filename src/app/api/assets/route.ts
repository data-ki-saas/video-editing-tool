import { NextResponse } from "next/server";
import { createSupabaseUserClient } from "@/lib/supabase/server";
import { uploadAsset } from "@/lib/assets/upload";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  const accessToken = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  if (!accessToken) return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });

  const formData = await request.formData();
  const projectId = formData.get("projectId");
  const file = formData.get("file");
  if (typeof projectId !== "string" || !(file instanceof File)) {
    return NextResponse.json({ error: "projectId and file are required" }, { status: 400 });
  }

  const supabase = createSupabaseUserClient(accessToken);
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) return NextResponse.json({ error: "Invalid access token" }, { status: 401 });

  try {
    const asset = await uploadAsset(supabase, projectId, userData.user.id, file);
    return NextResponse.json({ asset }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    const status = message.startsWith("Only") || message.startsWith("File") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}