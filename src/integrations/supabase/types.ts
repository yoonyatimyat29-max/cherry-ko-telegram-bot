export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      bot_chats: {
        Row: {
          bot_id: string
          chat_id: number
          chat_title: string | null
          chat_type: string
          chat_username: string | null
          created_at: string
          id: string
          is_active: boolean
          updated_at: string
        }
        Insert: {
          bot_id: string
          chat_id: number
          chat_title?: string | null
          chat_type?: string
          chat_username?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          updated_at?: string
        }
        Update: {
          bot_id?: string
          chat_id?: number
          chat_title?: string | null
          chat_type?: string
          chat_username?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bot_chats_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: false
            referencedRelation: "bots"
            referencedColumns: ["id"]
          },
        ]
      }
      bot1_conversations: {
        Row: {
          chat_id: number
          id: string
          state: string
          updated_at: string
        }
        Insert: {
          chat_id: number
          id?: string
          state?: string
          updated_at?: string
        }
        Update: {
          chat_id?: number
          id?: string
          state?: string
          updated_at?: string
        }
        Relationships: []
      }
      bot1_state: {
        Row: {
          id: number
          update_offset: number
          updated_at: string
        }
        Insert: {
          id: number
          update_offset?: number
          updated_at?: string
        }
        Update: {
          id?: number
          update_offset?: number
          updated_at?: string
        }
        Relationships: []
      }
      bot2_states: {
        Row: {
          bot_id: string
          id: string
          update_offset: number
          updated_at: string
        }
        Insert: {
          bot_id: string
          id?: string
          update_offset?: number
          updated_at?: string
        }
        Update: {
          bot_id?: string
          id?: string
          update_offset?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bot2_states_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: true
            referencedRelation: "bots"
            referencedColumns: ["id"]
          },
        ]
      }
      bots: {
        Row: {
          api_key: string
          bot_name: string | null
          bot_username: string | null
          created_at: string
          id: string
          is_active: boolean
          owner_chat_id: number
          start_link: string | null
        }
        Insert: {
          api_key: string
          bot_name?: string | null
          bot_username?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          owner_chat_id: number
          start_link?: string | null
        }
        Update: {
          api_key?: string
          bot_name?: string | null
          bot_username?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          owner_chat_id?: number
          start_link?: string | null
        }
        Relationships: []
      }
      channel_forward_jobs: {
        Row: {
          bot_id: string
          completed_at: string | null
          created_at: string
          failed_count: number
          id: string
          last_chat_id: number
          last_error: string | null
          processed_count: number
          source_chat_id: number
          source_message_id: number
          status: string
          success_count: number
          total_recipients: number
          updated_at: string
        }
        Insert: {
          bot_id: string
          completed_at?: string | null
          created_at?: string
          failed_count?: number
          id?: string
          last_chat_id?: number
          last_error?: string | null
          processed_count?: number
          source_chat_id: number
          source_message_id: number
          status?: string
          success_count?: number
          total_recipients?: number
          updated_at?: string
        }
        Update: {
          bot_id?: string
          completed_at?: string | null
          created_at?: string
          failed_count?: number
          id?: string
          last_chat_id?: number
          last_error?: string | null
          processed_count?: number
          source_chat_id?: number
          source_message_id?: number
          status?: string
          success_count?: number
          total_recipients?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_forward_jobs_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: false
            referencedRelation: "bots"
            referencedColumns: ["id"]
          },
        ]
      }
      trigger_pointers: {
        Row: {
          bot_id: string
          id: string
          pointer: number
          trigger_text: string
        }
        Insert: {
          bot_id: string
          id?: string
          pointer?: number
          trigger_text: string
        }
        Update: {
          bot_id?: string
          id?: string
          pointer?: number
          trigger_text?: string
        }
        Relationships: [
          {
            foreignKeyName: "trigger_pointers_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: false
            referencedRelation: "bots"
            referencedColumns: ["id"]
          },
        ]
      }
      trigger_responses: {
        Row: {
          bot_id: string
          created_at: string
          id: string
          response_text: string
          trigger_text: string
        }
        Insert: {
          bot_id: string
          created_at?: string
          id?: string
          response_text: string
          trigger_text: string
        }
        Update: {
          bot_id?: string
          created_at?: string
          id?: string
          response_text?: string
          trigger_text?: string
        }
        Relationships: [
          {
            foreignKeyName: "trigger_responses_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: false
            referencedRelation: "bots"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
