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
      agent_health: {
        Row: {
          agent_name: string
          checked_at: string
          failure_count: number
          id: string
          last_error: string | null
          last_failure: string | null
          last_success: string | null
          status: string
          user_id: string
        }
        Insert: {
          agent_name: string
          checked_at?: string
          failure_count?: number
          id?: string
          last_error?: string | null
          last_failure?: string | null
          last_success?: string | null
          status: string
          user_id: string
        }
        Update: {
          agent_name?: string
          checked_at?: string
          failure_count?: number
          id?: string
          last_error?: string | null
          last_failure?: string | null
          last_success?: string | null
          status?: string
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
      api_rate_limits: {
        Row: {
          function_name: string
          id: string
          request_count: number
          user_id: string
          window_start: string
        }
        Insert: {
          function_name: string
          id?: string
          request_count?: number
          user_id: string
          window_start?: string
        }
        Update: {
          function_name?: string
          id?: string
          request_count?: number
          user_id?: string
          window_start?: string
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
      broker_health: {
        Row: {
          created_at: string
          key_name: string | null
          last_error: string | null
          last_failure_at: string | null
          last_success_at: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          key_name?: string | null
          last_error?: string | null
          last_failure_at?: string | null
          last_success_at?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          key_name?: string | null
          last_error?: string | null
          last_failure_at?: string | null
          last_success_at?: string | null
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
      daily_briefs: {
        Row: {
          ai_model: string
          brief_date: string
          brief_text: string
          caution_flags: string[]
          created_at: string
          id: string
          key_levels: Json
          session_bias: string
          updated_at: string
          user_id: string
          watch_symbols: string[]
        }
        Insert: {
          ai_model?: string
          brief_date: string
          brief_text?: string
          caution_flags?: string[]
          created_at?: string
          id?: string
          key_levels?: Json
          session_bias?: string
          updated_at?: string
          user_id: string
          watch_symbols?: string[]
        }
        Update: {
          ai_model?: string
          brief_date?: string
          brief_text?: string
          caution_flags?: string[]
          created_at?: string
          id?: string
          key_levels?: Json
          session_bias?: string
          updated_at?: string
          user_id?: string
          watch_symbols?: string[]
        }
        Relationships: []
      }
      doctrine_settings: {
        Row: {
          consecutive_loss_limit: number
          created_at: string
          daily_loss_pct: number
          floor_abs_min: number
          floor_pct: number
          id: string
          loss_cooldown_minutes: number
          max_correlated_positions: number
          max_order_abs_cap: number
          max_order_abs_floor: number
          max_order_pct: number
          max_trades_per_day: number
          mode: string
          risk_per_trade_pct: number
          scan_interval_seconds: number
          starting_equity_usd: number | null
          updated_at: string
          updated_via: string
          user_id: string
        }
        Insert: {
          consecutive_loss_limit?: number
          created_at?: string
          daily_loss_pct?: number
          floor_abs_min?: number
          floor_pct?: number
          id?: string
          loss_cooldown_minutes?: number
          max_correlated_positions?: number
          max_order_abs_cap?: number
          max_order_abs_floor?: number
          max_order_pct?: number
          max_trades_per_day?: number
          mode?: string
          risk_per_trade_pct?: number
          scan_interval_seconds?: number
          starting_equity_usd?: number | null
          updated_at?: string
          updated_via?: string
          user_id: string
        }
        Update: {
          consecutive_loss_limit?: number
          created_at?: string
          daily_loss_pct?: number
          floor_abs_min?: number
          floor_pct?: number
          id?: string
          loss_cooldown_minutes?: number
          max_correlated_positions?: number
          max_order_abs_cap?: number
          max_order_abs_floor?: number
          max_order_pct?: number
          max_trades_per_day?: number
          mode?: string
          risk_per_trade_pct?: number
          scan_interval_seconds?: number
          starting_equity_usd?: number | null
          updated_at?: string
          updated_via?: string
          user_id?: string
        }
        Relationships: []
      }
      doctrine_symbol_overrides: {
        Row: {
          created_at: string
          daily_loss_pct: number | null
          enabled: boolean
          id: string
          max_order_pct: number | null
          max_trades_per_day: number | null
          risk_per_trade_pct: number | null
          symbol: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          daily_loss_pct?: number | null
          enabled?: boolean
          id?: string
          max_order_pct?: number | null
          max_trades_per_day?: number | null
          risk_per_trade_pct?: number | null
          symbol: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          daily_loss_pct?: number | null
          enabled?: boolean
          id?: string
          max_order_pct?: number | null
          max_trades_per_day?: number | null
          risk_per_trade_pct?: number | null
          symbol?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      doctrine_versions: {
        Row: {
          created_at: string
          id: string
          label: string | null
          overrides: Json
          settings: Json
          source: string
          user_id: string
          version_no: number
        }
        Insert: {
          created_at?: string
          id?: string
          label?: string | null
          overrides?: Json
          settings?: Json
          source?: string
          user_id: string
          version_no: number
        }
        Update: {
          created_at?: string
          id?: string
          label?: string | null
          overrides?: Json
          settings?: Json
          source?: string
          user_id?: string
          version_no?: number
        }
        Relationships: []
      }
      doctrine_windows: {
        Row: {
          created_at: string
          days: number[]
          enabled: boolean
          end_utc: string
          id: string
          label: string
          mode: string
          start_utc: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          days?: number[]
          enabled?: boolean
          end_utc: string
          id?: string
          label: string
          mode: string
          start_utc: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          days?: number[]
          enabled?: boolean
          end_utc?: string
          id?: string
          label?: string
          mode?: string
          start_utc?: string
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
      market_intelligence: {
        Row: {
          candle_count_1d: number | null
          candle_count_1h: number | null
          candle_count_4h: number | null
          entry_quality_context: string
          environment_rating: string
          fear_greed_label: string | null
          fear_greed_score: number | null
          funding_rate_pct: number | null
          funding_rate_signal: string
          generated_at: string
          id: string
          key_level_notes: string | null
          macro_bias: string
          macro_confidence: number
          macro_summary: string
          market_phase: string
          nearest_resistance: number | null
          nearest_support: number | null
          news_flags: Json
          pattern_context: string
          recent_momentum_1h: string | null
          recent_momentum_4h: string | null
          recent_momentum_at: string | null
          recent_momentum_notes: string | null
          running_narrative: string | null
          sentiment_summary: string
          symbol: string
          trend_structure: string
          user_id: string
        }
        Insert: {
          candle_count_1d?: number | null
          candle_count_1h?: number | null
          candle_count_4h?: number | null
          entry_quality_context?: string
          environment_rating?: string
          fear_greed_label?: string | null
          fear_greed_score?: number | null
          funding_rate_pct?: number | null
          funding_rate_signal?: string
          generated_at?: string
          id?: string
          key_level_notes?: string | null
          macro_bias?: string
          macro_confidence?: number
          macro_summary?: string
          market_phase?: string
          nearest_resistance?: number | null
          nearest_support?: number | null
          news_flags?: Json
          pattern_context?: string
          recent_momentum_1h?: string | null
          recent_momentum_4h?: string | null
          recent_momentum_at?: string | null
          recent_momentum_notes?: string | null
          running_narrative?: string | null
          sentiment_summary?: string
          symbol: string
          trend_structure?: string
          user_id: string
        }
        Update: {
          candle_count_1d?: number | null
          candle_count_1h?: number | null
          candle_count_4h?: number | null
          entry_quality_context?: string
          environment_rating?: string
          fear_greed_label?: string | null
          fear_greed_score?: number | null
          funding_rate_pct?: number | null
          funding_rate_signal?: string
          generated_at?: string
          id?: string
          key_level_notes?: string | null
          macro_bias?: string
          macro_confidence?: number
          macro_summary?: string
          market_phase?: string
          nearest_resistance?: number | null
          nearest_support?: number | null
          news_flags?: Json
          pattern_context?: string
          recent_momentum_1h?: string | null
          recent_momentum_4h?: string | null
          recent_momentum_at?: string | null
          recent_momentum_notes?: string | null
          running_narrative?: string | null
          sentiment_summary?: string
          symbol?: string
          trend_structure?: string
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
      pending_doctrine_changes: {
        Row: {
          activated_at: string | null
          cancelled_at: string | null
          effective_at: string
          field: string
          from_value: number | null
          id: string
          reason: string | null
          requested_at: string
          status: string
          to_value: number
          user_id: string
        }
        Insert: {
          activated_at?: string | null
          cancelled_at?: string | null
          effective_at: string
          field: string
          from_value?: number | null
          id?: string
          reason?: string | null
          requested_at?: string
          status?: string
          to_value: number
          user_id: string
        }
        Update: {
          activated_at?: string | null
          cancelled_at?: string | null
          effective_at?: string
          field?: string
          from_value?: number | null
          id?: string
          reason?: string | null
          requested_at?: string
          status?: string
          to_value?: number
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
          auto_pause_reason: string | null
          auto_paused_at: string | null
          consecutive_losses: number
          created_at: string
          created_by: string
          description: string
          display_name: string | null
          friendly_summary: string | null
          id: string
          metrics: Json
          name: string
          params: Json
          parent_strategy_id: string | null
          promotion_notes: string | null
          regime_affinity: string[]
          risk_weight: number
          side_capability: string[]
          status: string
          symbol: string | null
          updated_at: string
          user_id: string
          version: string
        }
        Insert: {
          auto_pause_reason?: string | null
          auto_paused_at?: string | null
          consecutive_losses?: number
          created_at?: string
          created_by?: string
          description?: string
          display_name?: string | null
          friendly_summary?: string | null
          id?: string
          metrics?: Json
          name: string
          params?: Json
          parent_strategy_id?: string | null
          promotion_notes?: string | null
          regime_affinity?: string[]
          risk_weight?: number
          side_capability?: string[]
          status?: string
          symbol?: string | null
          updated_at?: string
          user_id: string
          version: string
        }
        Update: {
          auto_pause_reason?: string | null
          auto_paused_at?: string | null
          consecutive_losses?: number
          created_at?: string
          created_by?: string
          description?: string
          display_name?: string | null
          friendly_summary?: string | null
          id?: string
          metrics?: Json
          name?: string
          params?: Json
          parent_strategy_id?: string | null
          promotion_notes?: string | null
          regime_affinity?: string[]
          risk_weight?: number
          side_capability?: string[]
          status?: string
          symbol?: string | null
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
          {
            foreignKeyName: "strategies_parent_strategy_id_fkey"
            columns: ["parent_strategy_id"]
            isOneToOne: false
            referencedRelation: "strategy_performance_ci_v"
            referencedColumns: ["strategy_id"]
          },
          {
            foreignKeyName: "strategies_parent_strategy_id_fkey"
            columns: ["parent_strategy_id"]
            isOneToOne: false
            referencedRelation: "strategy_performance_v"
            referencedColumns: ["strategy_id"]
          },
          {
            foreignKeyName: "strategies_parent_strategy_id_fkey"
            columns: ["parent_strategy_id"]
            isOneToOne: false
            referencedRelation: "strategy_regime_perf_v"
            referencedColumns: ["strategy_id"]
          },
        ]
      }
      strategy_reviews: {
        Row: {
          ai_model: string | null
          brief_text: string
          continue_ids: string[]
          id: string
          kill_ids: string[]
          needs_action: boolean
          promote_ids: string[]
          raw_analysis: Json
          reviewed_at: string
          top_regime: string | null
          trades_analyzed: number
          trigger_type: string
          user_id: string
          win_rate_trend: string | null
          worst_regime: string | null
        }
        Insert: {
          ai_model?: string | null
          brief_text: string
          continue_ids?: string[]
          id?: string
          kill_ids?: string[]
          needs_action?: boolean
          promote_ids?: string[]
          raw_analysis?: Json
          reviewed_at?: string
          top_regime?: string | null
          trades_analyzed?: number
          trigger_type: string
          user_id: string
          win_rate_trend?: string | null
          worst_regime?: string | null
        }
        Update: {
          ai_model?: string | null
          brief_text?: string
          continue_ids?: string[]
          id?: string
          kill_ids?: string[]
          needs_action?: boolean
          promote_ids?: string[]
          raw_analysis?: Json
          reviewed_at?: string
          top_regime?: string | null
          trades_analyzed?: number
          trigger_type?: string
          user_id?: string
          win_rate_trend?: string | null
          worst_regime?: string | null
        }
        Relationships: []
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
          active_profile: string
          autonomy_level: string
          bot: string
          broker_connection: string
          created_at: string
          data_feed: string
          doctrine_overlay_today: Json
          id: string
          kill_switch_engaged: boolean
          last_auto_promoted_at: string | null
          last_engine_snapshot: Json
          last_evaluated_at: string | null
          last_heartbeat: string
          last_jessica_decision: Json | null
          last_mark_to_market_at: string | null
          latency_ms: number
          live_money_acknowledged_at: string | null
          live_trading_enabled: boolean
          mode: string
          paper_account_balance: number
          params_wired_live: boolean
          pause_reason: string | null
          selected_broker: string | null
          trading_paused_until: string | null
          updated_at: string
          uptime_hours: number
          user_id: string
        }
        Insert: {
          active_profile?: string
          autonomy_level?: string
          bot?: string
          broker_connection?: string
          created_at?: string
          data_feed?: string
          doctrine_overlay_today?: Json
          id?: string
          kill_switch_engaged?: boolean
          last_auto_promoted_at?: string | null
          last_engine_snapshot?: Json
          last_evaluated_at?: string | null
          last_heartbeat?: string
          last_jessica_decision?: Json | null
          last_mark_to_market_at?: string | null
          latency_ms?: number
          live_money_acknowledged_at?: string | null
          live_trading_enabled?: boolean
          mode?: string
          paper_account_balance?: number
          params_wired_live?: boolean
          pause_reason?: string | null
          selected_broker?: string | null
          trading_paused_until?: string | null
          updated_at?: string
          uptime_hours?: number
          user_id: string
        }
        Update: {
          active_profile?: string
          autonomy_level?: string
          bot?: string
          broker_connection?: string
          created_at?: string
          data_feed?: string
          doctrine_overlay_today?: Json
          id?: string
          kill_switch_engaged?: boolean
          last_auto_promoted_at?: string | null
          last_engine_snapshot?: Json
          last_evaluated_at?: string | null
          last_heartbeat?: string
          last_jessica_decision?: Json | null
          last_mark_to_market_at?: string | null
          latency_ms?: number
          live_money_acknowledged_at?: string | null
          live_trading_enabled?: boolean
          mode?: string
          paper_account_balance?: number
          params_wired_live?: boolean
          pause_reason?: string | null
          selected_broker?: string | null
          trading_paused_until?: string | null
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
      tool_calls: {
        Row: {
          actor: string
          called_at: string
          id: string
          reason: string | null
          result: Json | null
          success: boolean
          tool_args: Json
          tool_name: string
          user_id: string
        }
        Insert: {
          actor: string
          called_at?: string
          id?: string
          reason?: string | null
          result?: Json | null
          success?: boolean
          tool_args?: Json
          tool_name: string
          user_id: string
        }
        Update: {
          actor?: string
          called_at?: string
          id?: string
          reason?: string | null
          result?: Json | null
          success?: boolean
          tool_args?: Json
          tool_name?: string
          user_id?: string
        }
        Relationships: []
      }
      trade_signals: {
        Row: {
          ai_model: string
          ai_reasoning: string
          approved_at: string | null
          approved_by: string | null
          confidence: number
          context_snapshot: Json
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decision_reason: string | null
          direction_basis: string | null
          executed_trade_id: string | null
          expires_at: string
          horizon: string
          horizon_confidence: number
          horizon_reasoning: string
          id: string
          lifecycle_phase: string
          lifecycle_transitions: Json
          paper_grade: boolean
          proposed_entry: number
          proposed_stop: number | null
          proposed_target: number | null
          regime: string
          rejected_reason: string | null
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
          approved_at?: string | null
          approved_by?: string | null
          confidence?: number
          context_snapshot?: Json
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_reason?: string | null
          direction_basis?: string | null
          executed_trade_id?: string | null
          expires_at?: string
          horizon?: string
          horizon_confidence?: number
          horizon_reasoning?: string
          id?: string
          lifecycle_phase?: string
          lifecycle_transitions?: Json
          paper_grade?: boolean
          proposed_entry: number
          proposed_stop?: number | null
          proposed_target?: number | null
          regime?: string
          rejected_reason?: string | null
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
          approved_at?: string | null
          approved_by?: string | null
          confidence?: number
          context_snapshot?: Json
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_reason?: string | null
          direction_basis?: string | null
          executed_trade_id?: string | null
          expires_at?: string
          horizon?: string
          horizon_confidence?: number
          horizon_reasoning?: string
          id?: string
          lifecycle_phase?: string
          lifecycle_transitions?: Json
          paper_grade?: boolean
          proposed_entry?: number
          proposed_stop?: number | null
          proposed_target?: number | null
          regime?: string
          rejected_reason?: string | null
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
          direction_basis: string | null
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
          synthetic_short: boolean
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
          direction_basis?: string | null
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
          synthetic_short?: boolean
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
          direction_basis?: string | null
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
          synthetic_short?: boolean
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
      strategy_performance_ci_v: {
        Row: {
          avg_pnl: number | null
          avg_pnl_hi: number | null
          avg_pnl_lo: number | null
          avg_pnl_pct: number | null
          closed_trades: number | null
          edge_verdict: string | null
          evidence_status: string | null
          losses: number | null
          risk_weight: number | null
          sharpe: number | null
          sharpe_hi: number | null
          sharpe_lo: number | null
          status: string | null
          strategy_id: string | null
          strategy_name: string | null
          strategy_version: string | null
          total_pnl: number | null
          user_id: string | null
          win_rate: number | null
          win_rate_hi: number | null
          win_rate_lo: number | null
          wins: number | null
        }
        Relationships: []
      }
      strategy_performance_v: {
        Row: {
          avg_pnl: number | null
          avg_pnl_pct: number | null
          closed_trades: number | null
          last_closed_at: string | null
          losses: number | null
          regime_affinity: string[] | null
          risk_weight: number | null
          side_capability: string[] | null
          status: string | null
          strategy_id: string | null
          strategy_name: string | null
          strategy_version: string | null
          total_pnl: number | null
          total_trades: number | null
          user_id: string | null
          win_rate: number | null
          wins: number | null
        }
        Relationships: []
      }
      strategy_regime_perf_v: {
        Row: {
          avg_pnl: number | null
          avg_pnl_hi: number | null
          avg_pnl_lo: number | null
          closed_trades: number | null
          evidence_status: string | null
          losses: number | null
          regime: string | null
          sd_pnl: number | null
          strategy_id: string | null
          strategy_name: string | null
          strategy_version: string | null
          total_pnl: number | null
          user_id: string | null
          win_rate: number | null
          win_rate_hi: number | null
          win_rate_lo: number | null
          wins: number | null
        }
        Relationships: []
      }
      trade_coach_grades: {
        Row: {
          avg_grade_numeric: number | null
          count: number | null
          grade: string | null
          last_graded_at: string | null
          regime: string | null
          symbol: string | null
          user_id: string | null
        }
        Relationships: []
      }
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
      check_and_increment_rate_limit: {
        Args: {
          p_function_name: string
          p_max_requests: number
          p_user_id: string
          p_window_seconds: number
        }
        Returns: {
          allowed: boolean
          remaining: number
          reset_at: string
        }[]
      }
      check_jessica_heartbeat: { Args: never; Returns: undefined }
      delete_broker_secrets: { Args: never; Returns: undefined }
      get_activate_doctrine_changes_cron_token: { Args: never; Returns: string }
      get_daily_brief_cron_token: { Args: never; Returns: string }
      get_evaluate_candidate_cron_token: { Args: never; Returns: string }
      get_jessica_cron_token: { Args: never; Returns: string }
      get_journal_digest_cron_token: { Args: never; Returns: string }
      get_katrina_cron_token: { Args: never; Returns: string }
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
      update_broker_health: {
        Args: {
          p_error?: string
          p_key_name?: string
          p_status: string
          p_user_id: string
        }
        Returns: undefined
      }
      upsert_broker_secret: {
        Args: { p_description?: string; p_name: string; p_value: string }
        Returns: undefined
      }
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
      users_on_profile: { Args: { p_profile: string }; Returns: string[] }
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
