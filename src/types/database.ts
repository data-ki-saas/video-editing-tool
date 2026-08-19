export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type TimelineState = {
  tracks: Array<{
    id: string;
    name?: string;
    clips: Array<{
      id: string;
      assetId?: string;
      start: number;
      duration: number;
    }>;
  }>;
  [key: string]: Json | undefined;
};

export type User = {
  id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
};

export type Project = {
  id: string;
  owner_id: string;
  name: string;
  timeline: TimelineState;
  created_at: string;
  updated_at: string;
};

export type AssetKind = "video" | "image";

export type Asset = {
  id: string;
  project_id: string;
  uploaded_by: string;
  filename: string;
  kind: AssetKind;
  mime_type: "video/mp4" | "image/jpeg" | "image/png";
  size_bytes: number;
  storage_key: string;
  public_url: string;
  created_at: string;
};

export type Database = {
  public: {
    Tables: {
      users: {
        Row: User;
        Insert: Omit<User, "created_at" | "updated_at"> & Partial<Pick<User, "created_at" | "updated_at">>;
        Update: Partial<Omit<User, "id" | "created_at" | "updated_at">>;
        Relationships: [];
      };
      projects: {
        Row: Project;
        Insert: Omit<Project, "id" | "created_at" | "updated_at"> & Partial<Pick<Project, "id" | "created_at" | "updated_at">>;
        Update: Partial<Omit<Project, "id" | "created_at" | "updated_at">>;
        Relationships: [];
      };
      assets: {
        Row: Asset;
        Insert: Omit<Asset, "id" | "created_at"> & Partial<Pick<Asset, "id" | "created_at">>;
        Update: Partial<Omit<Asset, "id" | "created_at">>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}