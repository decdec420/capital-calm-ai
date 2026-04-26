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
      broker_credentials: {
        Row: {
          api_key_secret_name: string
          api_passphrase_secret_name: string | null
          api_secret_secret_name: string
          broker: string
          created_at: string
          id: string
          last_error: string | null
          last_verified_at: string | null
          mode: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          api_key_secret_name: string
          api_passphrase_secret_name?: string | null
          api_secret_secret_name: string
          broker: string
          created_at?: string
          id?: string
          last_error?: string | null
          last_verified_at?: string | null
          mode?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          api_key_secret_name?: string
          api_passphrase_secret_name?: string | null
          api_secret_secret_name?: string
          broker?: string
          created_at?: string
          id?: string
          last_error?: string | null
          last_verified_at?: string | null
          mode?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      chat_conversations: {
        Row: {
          created_at: string
          id: string
          last_message_at: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_message_at?: string
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          last_message_at?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      chat_messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string
          id: string
          role: string
          user_id: string
        }
        Insert: {
          content: string
          conversation_id: string
          created_at?: string
          id?: string
          role: string
          user_id: string
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "chat_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      copilot_memory: {
        Row: {
          attempt_count: number
          created_at: string
          direction: string
          drawdown_delta: number | null
          exp_delta: number | null
          experiment_id: string | null
          from_value: number
          id: string
          last_tried_at: string
          outcome: string
          parameter: string
          retry_after: string | null
          sharpe_delta: number | null
          symbol: string
          to_value: number
          updated_at: string
          user_id: string
          win_rate_delta: number | null
        }
        Insert: {
          attempt_count?: number
          created_at?: string
          direction: string
          drawdown_delta?: number | null
          exp_delta?: number | null
          experiment_id?: string | null
          from_value: number
          id?: string
          last_tried_at?: string
          outcome: string
          parameter: string
          retry_after?: string | null
          sharpe_delta?: number | null
          symbol?: string
          to_value: number
          updated_at?: string
          user_id: string
          win_rate_delta?: number | null
        }
        Update: {
          attempt_count?: number
          created_at?: string
          direction?: string
          drawdown_delta?: number | null
          exp_delta?: number | null
          experiment_id?: string | null
          from_value?: number
          id?: string
          last_tried_at?: string
          outcome?: string
          parameter?: string
          retry_after?: string | null
          sharpe_delta?: number | null
          symbol?: string
          to_value?: number
          updated_at?: string
          user_id?: string
          win_rate_delta?: number | null
        }
        Relationships: []
      }
      doctrine_settings: {
        Row: {
          consecutive_loss_limit: number
          created_at: string
          daily_loss_pct: number
          floor_pct: number
          id: string
          loss_cooldown_minutes: number
          max_order_abs_cap: number
          max_order_pct: number
          max_trades_per_day: number
          mode: string
          starting_equity_usd: number
          updated_at: string
          user_id: string
        }
        Insert: {
          consecutive_loss_limit?: number
          created_at?: string
          daily_loss_pct?: number
          floor_pct?: number
          id?: string
          loss_cooldown_minutes?: number
          max_order_abs_cap?: number
          max_order_pct?: number
          max_trades_per_day?: number
          mode?: string
          starting_equity_usd?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          consecutive_loss_limit?: number
          created_at?: string
          daily_loss_pct?: number
          floor_pct?: number
          id?: string
          loss_cooldown_minutes?: number
          max_order_abs_cap?: number
          max_order_pct?: number
          max_trades_per_day?: number
          mode?: string
          starting_equity_usd?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      experiments: {
        Row: {
          after_value: string
          auto_resolved: boolean
          backtest_result: Json | null
          before_value: string
          confidence: number
          created_at: string
          delta: string
          hypothesis: string | null
          id: string
          needs_review: boolean
          notes: string | null
          parameter: string
          priority: string
          proposed_by: string
          status: string
          strategy_id: string | null
          symbol: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          after_value?: string
          auto_resolved?: boolean
          backtest_result?: Json | null
          before_value?: string
          confidence?: number
          created_at?: string
          delta?: string
          hypothesis?: string | null
          id?: string
          needs_review?: boolean
          notes?: string | null
          parameter?: string
          priority?: string
          proposed_by?: string
          status?: string
          strategy_id?: string | null
          symbol?: string
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          after_value?: string
          auto_resolved?: boolean
          backtest_result?: Json | null
          before_value?: string
          confidence?: number
          created_at?: string
          delta?: string
          hypothesis?: string | null
          id?: string
          needs_review?: boolean
          notes?: string | null
          parameter?: string
          priority?: string
          proposed_by?: string
          status?: string
          strategy_id?: string | null
          symbol?: string
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
          guardrail_type: string
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
          guardrail_type?: string
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
          guardrail_type?: string
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
          source: string
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
          source?: string
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
          source?: string
          summary?: string
          tags?: string[]
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      notification_preferences: {
        Row: {
          chat_id: number | null
          created_at: string
          daily_digest: boolean
          guardrail_blocked: boolean
          guardrail_caution: boolean
          id: string
          kill_switch: boolean
          quiet_hours_end: number | null
          quiet_hours_start: number | null
          severity_floor: string
          signal_proposed: boolean
          telegram_username: string | null
          trade_closed: boolean
          trade_opened: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          chat_id?: number | null
          created_at?: string
          daily_digest?: boolean
          guardrail_blocked?: boolean
          guardrail_caution?: boolean
          id?: string
          kill_switch?: boolean
          quiet_hours_end?: number | null
          quiet_hours_start?: number | null
          severity_floor?: string
          signal_proposed?: boolean
          telegram_username?: string | null
          trade_closed?: boolean
          trade_opened?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          chat_id?: number | null
          created_at?: string
          daily_digest?: boolean
          guardrail_blocked?: boolean
          guardrail_caution?: boolean
          id?: string
          kill_switch?: boolean
          quiet_hours_end?: number | null
          quiet_hours_start?: number | null
          severity_floor?: string
          signal_proposed?: boolean
          telegram_username?: string | null
          trade_closed?: boolean
          trade_opened?: boolean
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
          weekly_digest_generated_at: string | null
          weekly_digest_md: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id: string
          weekly_digest_generated_at?: string | null
          weekly_digest_md?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id?: string
          weekly_digest_generated_at?: string | null
          weekly_digest_md?: string | null
        }
        Relationships: []
      }
      strategies: {
        Row: {
          created_at: string
          created_by: string
          description: string
          id: string
          metrics: Json
          name: string
          params: Json
          parent_strategy_id: string | null
          promotion_notes: string | null
          status: string
          updated_at: string
          user_id: string
          version: string
        }
        Insert: {
          created_at?: string
          created_by?: string
          description?: string
          id?: string
          metrics?: Json
          name: string
          params?: Json
          parent_strategy_id?: string | null
          promotion_notes?: string | null
          status?: string
          updated_at?: string
          user_id: string
          version: string
        }
        Update: {
          created_at?: string
          created_by?: string
          description?: string
          id?: string
          metrics?: Json
          name?: string
          params?: Json
          parent_strategy_id?: string | null
          promotion_notes?: string | null
          status?: string
          updated_at?: string
          user_id?: string
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "strategies_parent_strategy_id_fkey"
            columns: ["parent_strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      system_audit_log: {
        Row: {
          action: string
          actor: string
          amount_usd: number | null
          created_at: string
          details: Json
          hash: string
          id: string
          prev_hash: string
          seq: number
          symbol: string | null
          trade_id: string | null
          user_id: string
        }
        Insert: {
          action: string
          actor?: string
          amount_usd?: number | null
          created_at?: string
          details?: Json
          hash: string
          id?: string
          prev_hash: string
          seq: number
          symbol?: string | null
          trade_id?: string | null
          user_id: string
        }
        Update: {
          action?: string
          actor?: string
          amount_usd?: number | null
          created_at?: string
          details?: Json
          hash?: string
          id?: string
          prev_hash?: string
          seq?: number
          symbol?: string | null
          trade_id?: string | null
          user_id?: string
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
          last_engine_snapshot: Json
          last_heartbeat: string
          last_mark_to_market_at: string | null
          latency_ms: number
          live_money_acknowledged_at: string | null
          live_trading_enabled: boolean
          mode: string
          params_wired_live: boolean
          selected_broker: string | null
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
          last_engine_snapshot?: Json
          last_heartbeat?: string
          last_mark_to_market_at?: string | null
          latency_ms?: number
          live_money_acknowledged_at?: string | null
          live_trading_enabled?: boolean
          mode?: string
          params_wired_live?: boolean
          selected_broker?: string | null
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
          last_engine_snapshot?: Json
          last_heartbeat?: string
          last_mark_to_market_at?: string | null
          latency_ms?: number
          live_money_acknowledged_at?: string | null
          live_trading_enabled?: boolean
          mode?: string
          params_wired_live?: boolean
          selected_broker?: string | null
          updated_at?: string
          uptime_hours?: number
          user_id?: string
        }
        Relationships: []
      }
      telegram_bot_state: {
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
      telegram_messages: {
        Row: {
          chat_id: number
          created_at: string
          processed_at: string | null
          raw_update: Json
          text: string | null
          update_id: number
          user_id: string | null
        }
        Insert: {
          chat_id: number
          created_at?: string
          processed_at?: string | null
          raw_update: Json
          text?: string | null
          update_id: number
          user_id?: string | null
        }
        Update: {
          chat_id?: number
          created_at?: string
          processed_at?: string | null
          raw_update?: Json
          text?: string | null
          update_id?: number
          user_id?: string | null
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
          horizon: string
          horizon_confidence: number
          horizon_reasoning: string
          id: string
          lifecycle_phase: string
          lifecycle_transitions: Json
          proposed_entry: number
          proposed_stop: number | null
          proposed_target: number | null
          regime: string
          setup_score: number
          side: string
          size_pct: number
          size_usd: number
          status: string
          strategy_id: string | null
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
          horizon?: string
          horizon_confidence?: number
          horizon_reasoning?: string
          id?: string
          lifecycle_phase?: string
          lifecycle_transitions?: Json
          proposed_entry: number
          proposed_stop?: number | null
          proposed_target?: number | null
          regime?: string
          setup_score?: number
          side: string
          size_pct?: number
          size_usd?: number
          status?: string
          strategy_id?: string | null
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
          horizon?: string
          horizon_confidence?: number
          horizon_reasoning?: string
          id?: string
          lifecycle_phase?: string
          lifecycle_transitions?: Json
          proposed_entry?: number
          proposed_stop?: number | null
          proposed_target?: number | null
          regime?: string
          setup_score?: number
          side?: string
          size_pct?: number
          size_usd?: number
          status?: string
          strategy_id?: string | null
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
          horizon: string
          horizon_history: Json
          id: string
          lifecycle_phase: string
          lifecycle_transitions: Json
          notes: string | null
          opened_at: string
          original_size: number | null
          outcome: string | null
          pnl: number | null
          pnl_pct: number | null
          reason_tags: string[]
          scale_ins: Json
          side: string
          size: number
          status: string
          stop_loss: number | null
          strategy_id: string | null
          strategy_version: string
          symbol: string
          take_profit: number | null
          tp1_filled: boolean
          tp1_price: number | null
          tp2_filled: boolean
          tp2_price: number | null
          tp3_filled: boolean
          tp3_price: number | null
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
          horizon?: string
          horizon_history?: Json
          id?: string
          lifecycle_phase?: string
          lifecycle_transitions?: Json
          notes?: string | null
          opened_at?: string
          original_size?: number | null
          outcome?: string | null
          pnl?: number | null
          pnl_pct?: number | null
          reason_tags?: string[]
          scale_ins?: Json
          side: string
          size: number
          status?: string
          stop_loss?: number | null
          strategy_id?: string | null
          strategy_version?: string
          symbol: string
          take_profit?: number | null
          tp1_filled?: boolean
          tp1_price?: number | null
          tp2_filled?: boolean
          tp2_price?: number | null
          tp3_filled?: boolean
          tp3_price?: number | null
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
          horizon?: string
          horizon_history?: Json
          id?: string
          lifecycle_phase?: string
          lifecycle_transitions?: Json
          notes?: string | null
          opened_at?: string
          original_size?: number | null
          outcome?: string | null
          pnl?: number | null
          pnl_pct?: number | null
          reason_tags?: string[]
          scale_ins?: Json
          side?: string
          size?: number
          status?: string
          stop_loss?: number | null
          strategy_id?: string | null
          strategy_version?: string
          symbol?: string
          take_profit?: number | null
          tp1_filled?: boolean
          tp1_price?: number | null
          tp2_filled?: boolean
          tp2_price?: number | null
          tp3_filled?: boolean
          tp3_price?: number | null
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
      append_audit_log: {
        Args: {
          p_action: string
          p_actor: string
          p_amount_usd: number
          p_details: Json
          p_symbol: string
          p_trade_id: string
          p_user_id: string
        }
        Returns: {
          action: string
          actor: string
          amount_usd: number | null
          created_at: string
          details: Json
          hash: string
          id: string
          prev_hash: string
          seq: number
          symbol: string | null
          trade_id: string | null
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "system_audit_log"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      get_evaluate_candidate_cron_token: { Args: never; Returns: string }
      get_journal_digest_cron_token: { Args: never; Returns: string }
      get_mark_to_market_cron_token: { Args: never; Returns: string }
      get_post_trade_learn_token: { Args: never; Returns: string }
      get_rollover_day_cron_token: { Args: never; Returns: string }
      get_signal_engine_cron_token: { Args: never; Returns: string }
      notify_telegram: {
        Args: {
          p_event_type: string
          p_message: string
          p_severity: string
          p_title: string
          p_user_id: string
        }
        Returns: undefined
      }
      realized_pnl_today: { Args: { p_user_id: string }; Returns: number }
      upsert_copilot_memory:
        | {
            Args: {
              p_direction: string
              p_drawdown_delta: number
              p_exp_delta: number
              p_experiment_id?: string
              p_from_value: number
              p_outcome: string
              p_parameter: string
              p_retry_after: string
              p_sharpe_delta: number
              p_to_value: number
              p_user_id: string
              p_win_rate_delta: number
            }
            Returns: undefined
          }
        | {
            Args: {
              p_direction: string
              p_drawdown_delta: number
              p_exp_delta: number
              p_experiment_id?: string
              p_from_value: number
              p_outcome: string
              p_parameter: string
              p_retry_after: string
              p_sharpe_delta: number
              p_symbol?: string
              p_to_value: number
              p_user_id: string
              p_win_rate_delta: number
            }
            Returns: undefined
          }
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
