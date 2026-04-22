/**
 * Shared types for the agent loop.
 */

export interface AgentButton {
  id: string;
  title: string;
}

export interface FinishTurnPayload {
  reply: string;
  buttons?: AgentButton[];
}

export interface AgentTurnResult {
  /** The final user-facing reply chosen by the agent via finish_turn. */
  reply: string;
  /** Buttons for interactive WATI messages. Max 2 (WATI session msg cap). */
  buttons?: AgentButton[];
  /** True if the agent called finish_turn cleanly. False = fell back. */
  cleanFinish: boolean;
  /** How many tool iterations the loop ran. */
  iterations: number;
}
