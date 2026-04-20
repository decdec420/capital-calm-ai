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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      account_state: {
        Row: {
          balance_floor: number
          base_currency: string
          cash: number
          created_at: string
          equity: number
          id: string
          start_of_day_equity: number
          updated_at: string
          user_id: string
        }
        Insert: {
          balance_floor?: number
          base_currency?: string
          cash?: number
          created_at?: string
          equity?: number
          id?: string
          start_of_day_equity?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          balance_floor?: number
          base_currency?: string
          cash?: number
          created_at?: string
          equity?: number
          id?: string
          start_of_day_equity?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      alerts: {
        Row: {
          created_at: string
          id: string
          message: string
          severity: string
          title: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          message?: string
          severity?: string
          title: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          message?: string
          severity?: string
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      experiments: {
        Row: {
          after_value: string
          before_value: string
          created_at: string
          delta: string
          id: string
          notes: string | null
          parameter: string
          status: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          after_value?: string
          before_value?: string
          created_at?: string
          delta?: string
          id?: string
          notes?: string | null
          parameter?: string
          status?: string
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          after_value?: string
          before_value?: string
          created_at?: string
          delta?: string
          id?: string
          notes?: string | null
          parameter?: string
          status?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      guardrails: {
        Row: {
          created_at: string
          current_value: string
          description: string
          id: string
          label: string
          level: string
          limit_value: string
          sort_order: number
          updated_at: string
          user_id: string
          utilization: number
        }
        Insert: {
          created_at?: string
          current_value?: string
          description?: string
          id?: string
          label: string
          level?: string
          limit_value?: string
          sort_order?: number
          updated_at?: string
          user_id: string
          utilization?: number
        }
        Update: {
          created_at?: string
          current_value?: string
          description?: string
          id?: string
          label?: string
          level?: string
          limit_value?: string
          sort_order?: number
          updated_at?: string
          user_id?: string
          utilization?: number
        }
        Relationships: []
      }
      journal_entries: {
        Row: {
          created_at: string
          id: string
          kind: string
          llm_explanation: string | null
          raw: Json | null
          summary: string
          tags: string[]
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind?: string
          llm_explanation?: string | null
          raw?: Json | null
          summary?: string
          tags?: string[]
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          llm_explanation?: string | null
          raw?: Json | null
          summary?: string
          tags?: string[]
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      strategies: {
        Row: {
          created_at: string
          description: string
          id: string
          metrics: Json
          name: string
          params: Json
          status: string
          updated_at: string
          user_id: string
          version: string
        }
        Insert: {
          created_at?: string
          description?: string
          id?: string
          metrics?: Json
          name: string
          params?: Json
          status?: string
          updated_at?: string
          user_id: string
          version: string
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          metrics?: Json
          name?: string
          params?: Json
          status?: string
          updated_at?: string
          user_id?: string
          version?: string
        }
        Relationships: []
      }
      system_state: {
        Row: {
          autonomy_level: string
          bot: string
          broker_connection: string
          created_at: string
          data_feed: string
          id: string
          kill_switch_engaged: boolean
          last_heartbeat: string
          latency_ms: number
          live_trading_enabled: boolean
          mode: string
          updated_at: string
          uptime_hours: number
          user_id: string
        }
        Insert: {
          autonomy_level?: string
          bot?: string
          broker_connection?: string
          created_at?: string
          data_feed?: string
          id?: string
          kill_switch_engaged?: boolean
          last_heartbeat?: string
          latency_ms?: number
          live_trading_enabled?: boolean
          mode?: string
          updated_at?: string
          uptime_hours?: number
          user_id: string
        }
        Update: {
          autonomy_level?: string
          bot?: string
          broker_connection?: string
          created_at?: string
          data_feed?: string
          id?: string
          kill_switch_engaged?: boolean
          last_heartbeat?: string
          latency_ms?: number
          live_trading_enabled?: boolean
          mode?: string
          updated_at?: string
          uptime_hours?: number
          user_id?: string
        }
        Relationships: []
      }
      trade_signals: {
        Row: {
          ai_model: string
          ai_reasoning: string
          confidence: number
          context_snapshot: Json
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decision_reason: string | null
          executed_trade_id: string | null
          expires_at: string
          id: string
          proposed_entry: number
          proposed_stop: number | null
          proposed_target: number | null
          regime: string
          setup_score: number
          side: string
          size_pct: number
          size_usd: number
          status: string
          symbol: string
          updated_at: string
          user_id: string
        }
        Insert: {
          ai_model?: string
          ai_reasoning?: string
          confidence?: number
          context_snapshot?: Json
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_reason?: string | null
          executed_trade_id?: string | null
          expires_at?: string
          id?: string
          proposed_entry: number
          proposed_stop?: number | null
          proposed_target?: number | null
          regime?: string
          setup_score?: number
          side: string
          size_pct?: number
          size_usd?: number
          status?: string
          symbol?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          ai_model?: string
          ai_reasoning?: string
          confidence?: number
          context_snapshot?: Json
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_reason?: string | null
          executed_trade_id?: string | null
          expires_at?: string
          id?: string
          proposed_entry?: number
          proposed_stop?: number | null
          proposed_target?: number | null
          regime?: string
          setup_score?: number
          side?: string
          size_pct?: number
          size_usd?: number
          status?: string
          symbol?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      trades: {
        Row: {
          closed_at: string | null
          created_at: string
          current_price: number | null
          entry_price: number
          exit_price: number | null
          id: string
          notes: string | null
          opened_at: string
          outcome: string | null
          pnl: number | null
          pnl_pct: number | null
          reason_tags: string[]
          side: string
          size: number
          status: string
          stop_loss: number | null
          strategy_version: string
          symbol: string
          take_profit: number | null
          unrealized_pnl: number | null
          unrealized_pnl_pct: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          closed_at?: string | null
          created_at?: string
          current_price?: number | null
          entry_price: number
          exit_price?: number | null
          id?: string
          notes?: string | null
          opened_at?: string
          outcome?: string | null
          pnl?: number | null
          pnl_pct?: number | null
          reason_tags?: string[]
          side: string
          size: number
          status?: string
          stop_loss?: number | null
          strategy_version?: string
          symbol: string
          take_profit?: number | null
          unrealized_pnl?: number | null
          unrealized_pnl_pct?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          current_price?: number | null
          entry_price?: number
          exit_price?: number | null
          id?: string
          notes?: string | null
          opened_at?: string
          outcome?: string | null
          pnl?: number | null
          pnl_pct?: number | null
          reason_tags?: string[]
          side?: string
          size?: number
          status?: string
          stop_loss?: number | null
          strategy_version?: string
          symbol?: string
          take_profit?: number | null
          unrealized_pnl?: number | null
          unrealized_pnl_pct?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_signal_engine_cron_token: { Args: never; Returns: string }
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
